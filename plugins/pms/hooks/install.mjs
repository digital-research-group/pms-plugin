#!/usr/bin/env node
// Merges the pm-sync hook registrations into a Claude settings file or a Codex hooks
// file, and takes them back out again; or writes a config from the board's setup.
//
//   node hooks/install.mjs [--client claude-code|codex|grok] [--settings <path>] [--scope project|user]
//                          [--uninstall] [--dry-run] [--replace-legacy]
//   node hooks/install.mjs --config-json <file> [--active-lane <name>] [--force] [--dry-run]
//
// Grok Build reads .claude/settings.json itself, so --client grok installs the Claude
// registration unchanged: the commands carry no --client flag, and pm-sync.mjs tells the
// two clients apart by payload shape. Codex has its own .codex/hooks.json, no
// CLAUDE_PROJECT_DIR and no PostToolUseFailure, so it gets a translated registration.
//
// Why a script rather than hand-edited JSON: a settings file holds other people's
// hooks (security gates, notifiers) and unrelated settings, and one careless
// assignment silently drops them. This merges per event, appending, and it is
// idempotent, so running it twice is a no-op. Malformed JSON is REFUSED rather than
// repaired: a settings file that does not parse disables every setting in it, so
// rewriting one would hide the damage instead of reporting it.
//
// Exit codes: 0 done (or nothing to do), 1 a legacy install or an existing config is in
// the way, 2 bad usage or a file this script will not touch.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYamlSubset } from './lib/yaml.mjs'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = join(SKILL_DIR, 'settings.hooks.json')
const MARKER = 'pm-sync.mjs'
const LEGACY_MARKER = 'pm-board-sync.mjs'
const EXAMPLE = join(SKILL_DIR, 'config.example.md')
const PROJECT_PREFIX = '$CLAUDE_PROJECT_DIR/.claude'
const USER_PREFIX = '$HOME/.claude'
// Codex sets no CLAUDE_PROJECT_DIR; its hook commands run in the session cwd.
const CODEX_PROJECT_PREFIX = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.claude'
const CLIENTS = ['claude-code', 'codex', 'grok']
const CONFIG_FILE = '.pm-sync.local.md'

const USAGE = `usage: node hooks/install.mjs [--client claude-code|codex|grok] [--settings <path>] [--scope project|user] [--uninstall] [--dry-run] [--replace-legacy]
       node hooks/install.mjs --config-json <file> [--client <name>] [--active-lane <name>] [--force] [--dry-run]

  --client <name>     claude-code (default) or grok: .claude/settings.json; codex: .codex/hooks.json
  --settings <path>   the settings file to merge into
                      (default: the client's file under the cwd for --scope project, under $HOME for user)
  --scope project     hook commands run from the repo's .claude/skills/pm-sync (default)
  --scope user        hook commands run from $HOME/.claude/skills/pm-sync
  --uninstall         remove the pm-sync hooks, leaving every other hook in place
  --dry-run           print the change and write nothing
  --replace-legacy    replace an older pm-board-sync.mjs install with this one
  --config-json <f>   write ${CONFIG_FILE} at the repo root from repo_context's setup for one board,
                      saved as {"config": <setup>} (a bare setup object works too); with --client it
                      then installs that client's hooks too, otherwise it installs none
  --active-lane <n>   the active lane, when the setup has none or you want another
  --force             overwrite an existing ${CONFIG_FILE}`

function fail(message, code) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = {
    settings: null, scope: 'project', uninstall: false, dryRun: false, replaceLegacy: false,
    client: 'claude-code', clientGiven: false, configJson: null, activeLane: null, force: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--settings') {
      options.settings = argv[index += 1]
      if (!options.settings) fail(`--settings needs a path\n\n${USAGE}`, 2)
    } else if (arg === '--scope') {
      options.scope = argv[index += 1]
      if (options.scope !== 'project' && options.scope !== 'user') fail(`--scope must be project or user\n\n${USAGE}`, 2)
    } else if (arg === '--client') {
      options.client = argv[index += 1]
      options.clientGiven = true
      if (!CLIENTS.includes(options.client)) fail(`--client must be one of ${CLIENTS.join(', ')}\n\n${USAGE}`, 2)
    } else if (arg === '--config-json') {
      options.configJson = argv[index += 1]
      if (!options.configJson) fail(`--config-json needs a file\n\n${USAGE}`, 2)
    } else if (arg === '--active-lane') {
      options.activeLane = argv[index += 1]
      if (!options.activeLane) fail(`--active-lane needs a lane name\n\n${USAGE}`, 2)
    } else if (arg === '--force') options.force = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--replace-legacy') options.replaceLegacy = true
    else if (arg === '--help' || arg === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0) }
    else fail(`unknown option "${arg}"\n\n${USAGE}`, 2)
  }
  if (!options.settings) {
    const relative = options.client === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'
    options.settings = options.scope === 'user'
      ? join(process.env.HOME ?? '', relative)
      // The client reads its settings at the repo root, even when this runs from a subfolder.
      : join(repoRootOf(process.cwd()), relative)
  } else if (!isAbsolute(options.settings)) {
    options.settings = resolve(process.cwd(), options.settings)
  }
  return options
}

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const serialize = (settings) => `${JSON.stringify(settings, null, 2)}\n`

/** The settings file as an object, or null when it does not exist. Refuses anything it should not rewrite. */
function readSettings(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return null }
  if (text.trim() === '') return {}
  let value
  try { value = JSON.parse(text) } catch (error) {
    fail(`${path} is not valid JSON (${error.message}).\nNothing was written. A settings file that does not parse disables every`
      + ' setting in it, so fix the JSON first, then run this again.', 2)
  }
  if (!isMap(value)) fail(`${path} does not hold a JSON object, so this script will not rewrite it. Nothing was written.`, 2)
  return value
}

/** The hook blocks to add, with their commands pointed at the chosen scope and client. */
function templateHooks(scope, client) {
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const hooks = template.hooks ?? {}
  if (scope !== 'user' && client !== 'codex') return hooks
  const prefix = scope === 'user' ? USER_PREFIX : CODEX_PROJECT_PREFIX
  return Object.fromEntries(Object.entries(hooks)
    // Codex has no PostToolUseFailure: a failed call is read from PostToolUse instead.
    .filter(([event]) => client !== 'codex' || event !== 'PostToolUseFailure')
    .map(([event, blocks]) => [event, blocks.map((block) => ({
      ...block,
      ...(client === 'codex' ? { matcher: codexMatcher(event, block.matcher) } : {}),
      hooks: block.hooks.map((hook) => ({
        ...hook,
        command: `${hook.command.split(PROJECT_PREFIX).join(prefix)}${client === 'codex' ? ' --client codex' : ''}`,
      })),
    }))]))
}

/** Codex reports every file edit as apply_patch, whatever the matcher names. */
function codexMatcher(event, matcher) {
  if (event === 'PreToolUse') return 'apply_patch|Edit|Write'
  if (event === 'PostToolUse') return `apply_patch|${matcher}`
  return matcher
}

const commandsIn = (settings) => Object.values(settings.hooks ?? {})
  .flatMap((blocks) => (Array.isArray(blocks) ? blocks : []))
  .flatMap((block) => (Array.isArray(block?.hooks) ? block.hooks : []))
  .map((hook) => String(hook?.command ?? ''))

const eventsHolding = (settings, marker) => Object.entries(settings.hooks ?? {})
  .filter(([, blocks]) => (Array.isArray(blocks) ? blocks : []).some((block) => (Array.isArray(block?.hooks) ? block.hooks : [])
    .some((hook) => String(hook?.command ?? '').includes(marker))))
  .map(([event]) => event)

/** Drop every hook whose command carries `marker`, then any block or event left empty. */
function removeMarker(settings, marker) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  let removed = 0
  for (const [event, blocks] of Object.entries(next.hooks)) {
    if (!Array.isArray(blocks)) continue
    const kept = blocks
      .map((block) => {
        if (!Array.isArray(block?.hooks)) return block
        const hooks = block.hooks.filter((hook) => !String(hook?.command ?? '').includes(marker))
        removed += block.hooks.length - hooks.length
        return { ...block, hooks }
      })
      .filter((block) => !Array.isArray(block?.hooks) || block.hooks.length > 0)
    if (kept.length === 0) delete next.hooks[event]
    else next.hooks[event] = kept
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks
  return { settings: next, removed }
}

function addHooks(settings, hooks) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  const added = []
  for (const [event, blocks] of Object.entries(hooks)) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : []
    // An event that already carries a pm-sync hook is left alone, so a second run adds
    // nothing and a partial install is repaired rather than duplicated.
    if (existing.some((block) => (Array.isArray(block?.hooks) ? block.hooks : []).some((hook) => String(hook?.command ?? '').includes(MARKER)))) continue
    next.hooks[event] = [...existing, ...blocks]
    added.push(event)
  }
  return { settings: next, added }
}

/** A line diff of the serialized settings: only what changed, marked + and -. */
function diff(before, after) {
  const from = new Set(before.split('\n'))
  const to = new Set(after.split('\n'))
  return [
    ...after.split('\n').filter((line) => line.trim() && !from.has(line)).map((line) => `+${line}`),
    ...before.split('\n').filter((line) => line.trim() && !to.has(line)).map((line) => `-${line}`),
  ].join('\n')
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

const yamlQuote = (value) => JSON.stringify(String(value))
const singleQuote = (value) => `'${String(value).replace(/'/g, "''")}'`

/** The example config's frontmatter defaults (track, enforce) and its rules body. */
function exampleDefaults() {
  const lines = readFileSync(EXAMPLE, 'utf8').split('\n')
  const close = lines.indexOf('---', 1)
  return { parsed: parseYamlSubset(lines.slice(1, close).join('\n')), body: lines.slice(close + 1).join('\n').trim() }
}

/** The setup for one board, validated: { board, lanes, activeLane } or a refusal. */
function readSetup(path, activeOverride) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { fail(`${path} is not readable JSON (${error.message}). Nothing was written.`, 2) }
  const setup = isMap(value) && isMap(value.config) ? value.config : value
  const board = isMap(setup) && isMap(setup.board) ? setup.board : null
  const lanes = isMap(setup) && Array.isArray(setup.lanes) ? setup.lanes : []
  if (!board || typeof board.name !== 'string' || !board.name || typeof board.id !== 'string' || !board.id) {
    fail(`${path} has no board { name, id }: save one board's setup from repo_context (setup: true). Nothing was written.`, 2)
  }
  if (lanes.length === 0 || !lanes.every((lane) => isMap(lane) && typeof lane.name === 'string' && lane.name && typeof lane.groupId === 'string' && lane.groupId)) {
    fail(`${path} has no lanes [{ name, groupId }]. Nothing was written.`, 2)
  }
  const activeLane = activeOverride ?? setup.activeLane
  if (typeof activeLane !== 'string' || !activeLane) {
    fail(`The board setup names no active lane. Re-run with --active-lane <name>, one of: ${lanes.map((lane) => lane.name).join(', ')}. Nothing was written.`, 2)
  }
  if (!lanes.some((lane) => lane.name === activeLane)) {
    fail(`--active-lane "${activeLane}" is not one of the lanes (${lanes.map((lane) => lane.name).join(', ')}). Nothing was written.`, 2)
  }
  return { board, lanes, activeLane, priorityOptions: Array.isArray(setup.priorityOptions) ? setup.priorityOptions : null }
}

/** The config text: the board's real ids, the example's defaults, and its rules body. */
function configText({ board, lanes, activeLane, priorityOptions }) {
  const { parsed, body } = exampleDefaults()
  const enforce = parsed.enforce ?? {}
  return [
    '---',
    '# pm-sync config, written by install.mjs --config-json from the board\'s repo_context setup.',
    '# This file is personal: git-ignore it. enabled: false turns every hook off again.',
    'enabled: true',
    '',
    'board:',
    `  name: ${yamlQuote(board.name)}`,
    `  id: ${yamlQuote(board.id)}`,
    ...(typeof board.url === 'string' && board.url ? [`  url: ${yamlQuote(board.url)}`] : []),
    '',
    '# Lane (group) name -> group id, in board order.',
    'lanes:',
    ...lanes.map((lane) => `  ${yamlQuote(lane.name)}: ${yamlQuote(lane.groupId)}`),
    '',
    `active_lane: ${yamlQuote(activeLane)}`,
    '',
    '# A Priority value that must never be moved or worked on without the owner\'s go-ahead.',
    `# protected_priority: ${priorityOptions?.length ? `one of ${priorityOptions.join(', ')}` : 'Needs approval'}`,
    '',
    '# auto: board calls are recognised under any MCP server name (Claude, Codex and Grok each name',
    '# it differently). Set a prefix such as mcp__drg_pm__ to accept only that server.',
    'connector: auto',
    '',
    '# NARROW THIS: repo-relative globs for the work this board really tracks. These are',
    '# the example defaults, and an edit outside them is ignored by every gate.',
    'track:',
    ...(parsed.track ?? []).map((glob) => `  - ${singleQuote(glob)}`),
    '',
    'enforce:',
    ...Object.entries(enforce).map(([key, value]) => `  ${key}: ${typeof value === 'string' ? singleQuote(value) : value}`),
    '',
    'log: .pm-sync.log.md',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function repoRootOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || cwd
  } catch { return cwd }
}

const options = parseArgs(process.argv.slice(2))
const say = (text) => process.stdout.write(`${text}\n`)

if (options.configJson) {
  const root = repoRootOf(process.cwd())
  const target = join(root, CONFIG_FILE)
  const text = configText(readSetup(resolve(process.cwd(), options.configJson), options.activeLane))
  if (existsSync(target) && !options.force) fail(`${target} already exists. Nothing was written. Re-run with --force to replace it.`, 1)
  if (options.dryRun) {
    say(`Dry run: this would be written to ${target}. Nothing was written.\n`)
    say(text)
    if (!options.clientGiven) process.exit(0)
  } else {
    write(target, text)
    say(`Wrote ${target}. Narrow its track globs to the work this board covers${options.clientGiven ? '.' : ', then install the hooks (--client claude-code|codex|grok).'}`)
  }
  if (existsSync(join(root, '.claude/pm-sync.local.md'))) {
    say('Note: .claude/pm-sync.local.md is now shadowed by the new file, which wins. Delete the old one once the new one is right.')
  }
  // With --client the same command goes on to install that client's hooks: setup is one step.
  if (!options.clientGiven) process.exit(0)
}

const current = readSettings(options.settings)
const before = serialize(current ?? {})

if (options.uninstall) {
  const { settings, removed } = removeMarker(current ?? {}, MARKER)
  if (removed === 0) {
    say(`pm-sync is not installed in ${options.settings}; nothing to remove.`)
    process.exit(0)
  }
  const after = serialize(settings)
  if (options.dryRun) {
    say(`Dry run: ${removed} pm-sync hook(s) would be removed from ${options.settings}. Nothing was written.`)
    say(diff(before, after))
    process.exit(0)
  }
  write(options.settings, after)
  say(`Removed ${removed} pm-sync hook(s) from ${options.settings}. Every other hook was left as it was.`)
  process.exit(0)
}

const legacyEvents = eventsHolding(current ?? {}, LEGACY_MARKER)
if (legacyEvents.length > 0 && !options.replaceLegacy) {
  for (const command of commandsIn(current ?? {}).filter((entry) => entry.includes(LEGACY_MARKER))) say(`  ${command}`)
  fail(`${options.settings} already registers the older ${LEGACY_MARKER} hook (${legacyEvents.join(', ')}).`
    + ' Nothing was written. Re-run with --replace-legacy to swap it for pm-sync, or remove those entries yourself first.', 1)
}

let base = current ?? {}
let replaced = 0
if (legacyEvents.length > 0) {
  const stripped = removeMarker(base, LEGACY_MARKER)
  base = stripped.settings
  replaced = stripped.removed
}
const { settings, added } = addHooks(base, templateHooks(options.scope, options.client))
const after = serialize(settings)

if (after === before) {
  say(`pm-sync is already installed in ${options.settings}; nothing to change. Remove it with --uninstall.`)
  process.exit(0)
}
if (options.dryRun) {
  say(`Dry run: pm-sync would be installed into ${options.settings} (${added.join(', ') || 'no new events'}`
    + `${replaced ? `, replacing ${replaced} legacy hook(s)` : ''}). Nothing was written.`)
  say(diff(before, after))
  process.exit(0)
}
write(options.settings, after)
say(`Installed pm-sync hooks into ${options.settings} (${added.join(', ')})${replaced ? `, replacing ${replaced} legacy ${LEGACY_MARKER} hook(s)` : ''}.`)
say(`Every other hook was left as it was. Undo this with: node hooks/install.mjs --settings ${options.settings} --uninstall`)
if (options.client === 'codex') {
  say('Codex runs project hooks only once they are trusted: open /hooks in Codex and approve them. Trust is pinned to each hook\'s hash,'
    + ' so re-approve them in /hooks after any change to these hooks or to the pm-sync scripts.')
}
if (options.client === 'grok') {
  say('Grok Build reads these .claude/settings.json hooks too. Trust the project hooks with /hooks-trust (or launch with --trust).'
    + ' The commands carry no --client flag: pm-sync tells Grok\'s camelCase payload apart by itself.')
}
