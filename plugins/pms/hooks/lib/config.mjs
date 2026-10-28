// Find, read and validate the markdown pm-sync config.
//
// The contract the hooks rely on: no config means ABSENT and total silence, a config
// with `enabled: false` means the same, and a broken config is INVALID, which costs
// one line at session start and nothing anywhere else. A hook must never block work
// because a config is malformed.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parseYamlSubset, YamlError } from './yaml.mjs'
import { repoRelative } from './glob.mjs'

// The neutral root path serves every client (Claude Code, Codex, Grok); the .claude path
// is where installs made before that live, and keeps working.
export const NEUTRAL_CONFIG_RELATIVE = '.pm-sync.local.md'
export const NEUTRAL_LOG_RELATIVE = '.pm-sync.log.md'
export const DEFAULT_CONFIG_RELATIVE = '.claude/pm-sync.local.md'
export const DEFAULT_LOG_RELATIVE = '.claude/pm-sync.log.md'
export const DEFAULT_STALE_WORK_MINUTES = 8
export const DEFAULT_STALE_VERIFY_MINUTES = 2

const ID = /^[A-Za-z0-9-]{8,64}$/
const CONNECTOR = /^mcp__[A-Za-z0-9_-]+__$/
const KNOWN = {
  root: ['enabled', 'board', 'lanes', 'active_lane', 'protected_priority', 'connector', 'track', 'enforce', 'log'],
  board: ['name', 'id', 'url', 'owner'],
  enforce: ['block_edits_without_active_card', 'stale_work_minutes', 'stale_verify_minutes', 'verify_command'],
}

/**
 * Where the config lives: PM_SYNC_CONFIG wins, absolute or relative to the repo root;
 * then .pm-sync.local.md at the root; then the older .claude/pm-sync.local.md.
 */
export function configPath(root, env = {}) {
  const override = typeof env.PM_SYNC_CONFIG === 'string' ? env.PM_SYNC_CONFIG.trim() : ''
  if (override) return isAbsolute(override) ? override : join(root, override)
  const neutral = join(root, NEUTRAL_CONFIG_RELATIVE)
  return existsSync(neutral) ? neutral : join(root, DEFAULT_CONFIG_RELATIVE)
}

/** The log sits beside the neutral config; every other location keeps the .claude default. */
const defaultLogFor = (root, path) => (path === join(root, NEUTRAL_CONFIG_RELATIVE) ? NEUTRAL_LOG_RELATIVE : DEFAULT_LOG_RELATIVE)

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Frontmatter block and verbatim body, or null when the file carries no frontmatter. */
function splitFrontmatter(text) {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n')
  let open = 0
  while (open < lines.length && lines[open].trim() === '') open += 1
  if (lines[open]?.trim() !== '---') return null
  const close = lines.findIndex((line, index) => index > open && line.trim() === '---')
  if (close === -1) return null
  const body = lines.slice(close + 1)
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  // `before` is how many file lines precede the frontmatter, so a YAML line number can name the file's line.
  return { frontmatter: lines.slice(open + 1, close).join('\n'), body: body.join('\n'), before: open + 1 }
}

function unknownKeys(value, allowed, prefix, warnings) {
  if (!isMap(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) warnings.push(`unknown key "${prefix}${key}" in the pm-sync config (ignored)`)
  }
}

function requiredString(value, name, errors) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  errors.push(`${name} is required`)
  return null
}

function idOrError(value, name, errors) {
  // An all-digit id parses as a number; some boards really do use numeric ids.
  const text = requiredString(typeof value === 'number' && Number.isInteger(value) ? String(value) : value, name, errors)
  if (text === null) return null
  if (!ID.test(text)) { errors.push(`${name} must be 8 to 64 letters, digits or dashes`); return null }
  return text
}

function minutes(value, name, fallback, errors) {
  if (value === undefined || value === null) return fallback * 60 * 1000
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`enforce.${name} must be a number of minutes greater than zero`)
    return fallback * 60 * 1000
  }
  return Math.round(value * 60 * 1000)
}

function lanesOf(value, errors) {
  if (!isMap(value)) { errors.push('lanes is required: a map of lane name to group id'); return [] }
  const names = Object.keys(value)
  if (names.length === 0) { errors.push('lanes is required: at least one lane name and group id'); return [] }
  return names.map((name) => ({ name, id: idOrError(value[name], `lanes.${name}`, errors) })).filter((lane) => lane.id !== null)
}

function trackOf(value, errors) {
  if (!Array.isArray(value)) { errors.push('track is required: at least one repo-relative glob'); return [] }
  const globs = value.filter((glob) => typeof glob === 'string' && glob.trim() !== '').map((glob) => glob.trim())
  if (globs.length === 0) errors.push('track is required: at least one repo-relative glob')
  if (globs.length !== value.length) errors.push('track entries must all be non-empty strings')
  return globs
}

function verifyCommandOf(value, errors) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') { errors.push('enforce.verify_command must be a regular expression string'); return null }
  try { return new RegExp(value) } catch (error) { errors.push(`enforce.verify_command is not a valid regular expression: ${error.message}`); return null }
}

function logOf(value, root, errors, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') { errors.push('log must be a repo-relative file path'); return fallback }
  const relative = repoRelative(root, value.trim())
  if (relative === null) { errors.push('log must be a repo-relative path inside the repository'); return fallback }
  // The log is rewritten on every board call, so it must never land on git's own files.
  if (relative.toLowerCase().split('/').includes('.git') || !relative.toLowerCase().endsWith('.md')) { errors.push('log must be a .md file outside .git'); return fallback }
  return relative
}

function build(parsed, body, root, defaultLog) {
  const errors = []
  const warnings = []
  unknownKeys(parsed, KNOWN.root, '', warnings)
  unknownKeys(parsed.board, KNOWN.board, 'board.', warnings)
  unknownKeys(parsed.enforce, KNOWN.enforce, 'enforce.', warnings)

  if (parsed.enabled !== true) {
    errors.push(parsed.enabled === undefined || parsed.enabled === null
      ? 'enabled is not set: add "enabled: true" to turn board sync on'
      : 'enabled must be true or false')
    return { errors, warnings, config: null }
  }

  const board = isMap(parsed.board) ? parsed.board : {}
  const name = requiredString(board.name, 'board.name', errors)
  const id = idOrError(board.id, 'board.id', errors)
  const lanes = lanesOf(parsed.lanes, errors)
  const activeLane = requiredString(parsed.active_lane, 'active_lane', errors)
  const active = lanes.find((lane) => lane.name === activeLane)
  if (activeLane !== null && lanes.length > 0 && !active) {
    errors.push(`active_lane "${activeLane}" is not one of the lanes (${lanes.map((lane) => lane.name).join(', ')})`)
  }
  const connector = requiredString(parsed.connector, 'connector', errors)
  // `auto` matches any MCP server name; see connectorSuffix in pm-sync.mjs.
  if (connector !== null && connector !== 'auto' && !CONNECTOR.test(connector)) {
    warnings.push(`connector "${connector}" does not look like an MCP tool-name prefix such as mcp__drg_pm__; board calls may not be noticed`)
  }
  const track = trackOf(parsed.track, errors)
  const enforce = isMap(parsed.enforce) ? parsed.enforce : {}
  const blockEdits = enforce.block_edits_without_active_card
  if (blockEdits !== undefined && typeof blockEdits !== 'boolean') errors.push('enforce.block_edits_without_active_card must be true or false')
  const config = {
    board: {
      name,
      id,
      url: typeof board.url === 'string' ? board.url.trim() : '',
      owner: typeof board.owner === 'string' && board.owner.trim() !== '' ? board.owner.trim() : 'the board owner',
    },
    lanes,
    laneIds: Object.fromEntries(lanes.map((lane) => [lane.name, lane.id])),
    activeLane,
    activeLaneId: active ? active.id : null,
    protectedPriority: typeof parsed.protected_priority === 'string' && parsed.protected_priority.trim() !== '' ? parsed.protected_priority.trim() : null,
    connector,
    track,
    blockEditsWithoutActiveCard: typeof blockEdits === 'boolean' ? blockEdits : true,
    staleWorkMs: minutes(enforce.stale_work_minutes, 'stale_work_minutes', DEFAULT_STALE_WORK_MINUTES, errors),
    staleVerifyMs: minutes(enforce.stale_verify_minutes, 'stale_verify_minutes', DEFAULT_STALE_VERIFY_MINUTES, errors),
    verifyCommand: verifyCommandOf(enforce.verify_command, errors),
    logRelative: logOf(parsed.log, root, errors, defaultLog),
    body,
  }
  return { errors, warnings, config: errors.length === 0 ? config : null }
}

/**
 * The config for a repo: { state: 'absent' | 'disabled' | 'invalid' | 'ok', path, errors, warnings, config, body }.
 * Never throws: an unreadable or malformed file is reported, not raised.
 */
export function loadConfig({ root, env = {} } = {}) {
  const path = configPath(root, env)
  const empty = { path, errors: [], warnings: [], config: null, body: '' }
  let text
  try { text = readFileSync(path, 'utf8') } catch { return { ...empty, state: 'absent' } }

  const split = splitFrontmatter(text)
  if (!split) return { ...empty, state: 'invalid', errors: ['the file must start with a --- frontmatter block and close it with ---'] }

  let parsed
  try { parsed = parseYamlSubset(split.frontmatter) } catch (error) {
    const line = error instanceof YamlError ? `line ${error.line + split.before}` : 'frontmatter'
    const detail = error instanceof YamlError ? error.message.replace(/^line \d+: /, '') : String(error.message ?? error)
    return { ...empty, state: 'invalid', body: split.body, errors: [`${line}: ${detail}`] }
  }
  if (!isMap(parsed)) return { ...empty, state: 'invalid', body: split.body, errors: ['the frontmatter must be a map of keys'] }
  if (parsed.enabled === false) return { ...empty, state: 'disabled', body: split.body }

  const built = build(parsed, split.body, root, defaultLogFor(root, path))
  return {
    path,
    body: split.body,
    errors: built.errors,
    warnings: built.warnings,
    config: built.config,
    state: built.config ? 'ok' : 'invalid',
  }
}
