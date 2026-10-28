import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { configPath, DEFAULT_CONFIG_RELATIVE, DEFAULT_LOG_RELATIVE, loadConfig } from '../lib/config.mjs'

const VALID = [
  '---',
  'enabled: true',
  'board:',
  '  name: Acme Web',
  '  id: 5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11',
  '  url: https://pm.example.com/boards/5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11',
  '  owner: Alex',
  'lanes:',
  '  Queue: 8c4d3e5f-6a7b-4c8d-ae9f-1a2b3c4d5e66',
  '  In-progress: 7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55',
  '  QA: 6a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c44',
  '  Complete: 9d5e4f6a-7b8c-4d9e-8f0a-2b3c4d5e6f77',
  'active_lane: In-progress',
  'protected_priority: Needs approval',
  'connector: mcp__claude_ai_Project_Management_System__',
  'track:',
  '  - packages/core/src/**',
  '  - scripts/*builder*.mjs',
  'enforce:',
  '  block_edits_without_active_card: true',
  '  stale_work_minutes: 8',
  '  stale_verify_minutes: 2',
  "  verify_command: '\\b(vitest|tsc\\b)'",
  'log: .claude/pm-sync.log.md',
  '---',
  '',
  '## My board rules',
  '',
  '- One transition per call.',
].join('\n')

/** A temp repo root, with the config written at `relative` when text is given. */
function repo(text, relative = DEFAULT_CONFIG_RELATIVE) {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-config-'))
  if (text !== null) {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, relative), text)
  }
  return root
}

const load = (text, env = {}) => loadConfig({ root: repo(text), env })

/** The config of a file that must load cleanly, so a failure reads as an assertion. */
function loaded(text) {
  const result = load(text)
  assert.deepEqual(result.errors, [], 'expected no config errors')
  assert.ok(result.config, `expected a loaded config, got state ${result.state}`)
  return result.config
}

test('the shipped config.example.md is valid for this parser', () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const template = readFileSync(join(base, 'config.example.md'), 'utf8')
  assert.match(template, /^enabled: false$/m, 'the template must ship switched off')
  const off = loadConfig({ root: repo(template), env: {} })
  assert.equal(off.state, 'disabled')
  const on = loadConfig({ root: repo(template.replace('enabled: false', 'enabled: true')), env: {} })
  assert.deepEqual(on.errors, [], 'the template must validate once enabled')
  assert.deepEqual(on.warnings, [], 'the template must not warn')
})

test('configPath defaults into .claude and PM_SYNC_CONFIG overrides it', () => {
  assert.equal(configPath('/repo', {}), join('/repo', DEFAULT_CONFIG_RELATIVE))
  assert.equal(configPath('/repo', { PM_SYNC_CONFIG: 'other/pm.md' }), join('/repo', 'other/pm.md'))
  assert.equal(configPath('/repo', { PM_SYNC_CONFIG: '/abs/pm.md' }), '/abs/pm.md')
})

test('no config file is absent, with nothing to say', () => {
  const result = load(null)
  assert.equal(result.state, 'absent')
  assert.deepEqual(result.errors, [])
  assert.equal(result.config, null)
})

test('enabled: false is disabled, exactly like no config', () => {
  const result = load(VALID.replace('enabled: true', 'enabled: false'))
  assert.equal(result.state, 'disabled')
  assert.deepEqual(result.errors, [])
  assert.equal(result.config, null)
})

test('a valid config is parsed, with lane order kept and defaults filled in', () => {
  assert.equal(load(VALID).state, 'ok')
  const config = loaded(VALID)
  assert.equal(config.board.name, 'Acme Web')
  assert.equal(config.board.id, '5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11')
  assert.equal(config.board.owner, 'Alex')
  assert.deepEqual(config.lanes.map((lane) => lane.name), ['Queue', 'In-progress', 'QA', 'Complete'])
  assert.equal(config.lanes[1].id, '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55')
  assert.equal(config.activeLane, 'In-progress')
  assert.equal(config.activeLaneId, '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55')
  assert.equal(config.protectedPriority, 'Needs approval')
  assert.equal(config.connector, 'mcp__claude_ai_Project_Management_System__')
  assert.deepEqual(config.track, ['packages/core/src/**', 'scripts/*builder*.mjs'])
  assert.equal(config.blockEditsWithoutActiveCard, true)
  assert.equal(config.staleWorkMs, 8 * 60 * 1000)
  assert.equal(config.staleVerifyMs, 2 * 60 * 1000)
  assert.equal(config.verifyCommand.test('pnpm vitest run'), true)
  assert.equal(config.verifyCommand.test('ls -la'), false)
  assert.equal(config.logRelative, '.claude/pm-sync.log.md')
  assert.match(config.body, /^## My board rules/)
  assert.match(config.body, /One transition per call\./)
})

test('an absent enforce block and an absent log take the documented defaults', () => {
  const trimmed = VALID.split('\n').filter((line) => !/^(enforce:|  (block_edits|stale_|verify_command)|log:)/.test(line)).join('\n')
  const config = loaded(trimmed)
  assert.equal(config.blockEditsWithoutActiveCard, true)
  assert.equal(config.staleWorkMs, 8 * 60 * 1000)
  assert.equal(config.staleVerifyMs, 2 * 60 * 1000)
  assert.equal(config.verifyCommand, null)
  assert.equal(config.logRelative, DEFAULT_LOG_RELATIVE)
})

test('the body is kept verbatim, including blank lines and markdown', () => {
  const result = load(['---', 'enabled: false', '---', 'line one', '', '  indented', '---', 'after'].join('\n'))
  assert.equal(result.body, 'line one\n\n  indented\n---\nafter')
})

test('an unknown key warns and still loads', () => {
  const result = load(VALID.replace('enabled: true', 'enabled: true\nboards: oops'))
  assert.equal(result.state, 'ok')
  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /unknown key "boards"/)
})

test('an unknown nested key warns with its path', () => {
  const result = load(VALID.replace('  owner: Alex', '  owner: Alex\n  colour: red'))
  assert.equal(result.state, 'ok')
  assert.match(result.warnings[0], /unknown key "board\.colour"/)
})

test('PM_SYNC_CONFIG points the loader at another file', () => {
  const root = repo(VALID, '.claude/elsewhere.md')
  const miss = loadConfig({ root, env: {} })
  assert.equal(miss.state, 'absent')
  const hit = loadConfig({ root, env: { PM_SYNC_CONFIG: '.claude/elsewhere.md' } })
  assert.equal(hit.state, 'ok')
  assert.equal(hit.path, join(root, '.claude/elsewhere.md'))
})

test('a missing frontmatter block is invalid and says so', () => {
  const result = load('just a note, no frontmatter')
  assert.equal(result.state, 'invalid')
  assert.match(result.errors[0], /frontmatter/)
  assert.equal(result.config, null)
})

test('an unclosed frontmatter block is invalid', () => {
  assert.match(load('---\nenabled: true\nboard:\n  name: x').errors[0], /frontmatter/)
})

test('a YAML error outside the subset is reported with its line', () => {
  const result = load('---\nenabled: true\nboard:\n\tname: x\n---\n')
  assert.equal(result.state, 'invalid')
  assert.match(result.errors[0], /line 4/)
  assert.match(result.errors[0], /tab/i)
})

test('enabled must be present and boolean', () => {
  assert.match(load(VALID.replace('enabled: true\n', '')).errors[0], /enabled/)
  assert.match(load(VALID.replace('enabled: true', "enabled: 'true'")).errors[0], /enabled must be true or false/)
})

test('each required field is reported by name when it is missing', () => {
  const cases = [
    ['  id: 5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11', 'board.id'],
    ['  name: Acme Web', 'board.name'],
    ['connector: mcp__claude_ai_Project_Management_System__', 'connector'],
    ['active_lane: In-progress', 'active_lane'],
  ]
  for (const [line, named] of cases) {
    const result = load(VALID.replace(`${line}\n`, ''))
    assert.equal(result.state, 'invalid', named)
    assert.ok(result.errors.some((error) => error.includes(named)), `${named}: ${result.errors.join(' | ')}`)
  }
})

test('lanes and track must each hold at least one entry', () => {
  const noLanes = load(VALID.split('\n').filter((line) => !/^(lanes:|  (Queue|In-progress|QA|Complete):)/.test(line)).join('\n'))
  assert.ok(noLanes.errors.some((error) => error.includes('lanes')))
  const noTrack = load(VALID.split('\n').filter((line) => !/^(track:|  - )/.test(line)).join('\n'))
  assert.ok(noTrack.errors.some((error) => error.includes('track')))
})

test('active_lane must name one of the lanes', () => {
  const result = load(VALID.replace('active_lane: In-progress', 'active_lane: Doing'))
  assert.equal(result.state, 'invalid')
  assert.match(result.errors[0], /active_lane "Doing"/)
})

test('ids must look like ids', () => {
  assert.match(load(VALID.replace('  id: 5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11', '  id: short')).errors[0], /board\.id/)
  assert.match(load(VALID.replace('  QA: 6a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c44', '  QA: has spaces here')).errors[0], /lanes\.QA/)
  assert.equal(load(VALID.replace('  id: 5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11', '  id: 12345678')).state, 'ok')
})

test('verify_command must compile as a regular expression', () => {
  const result = load(VALID.replace("  verify_command: '\\b(vitest|tsc\\b)'", "  verify_command: '(unclosed'"))
  assert.equal(result.state, 'invalid')
  assert.match(result.errors[0], /verify_command/)
})

test('the stale bounds must be positive numbers', () => {
  assert.match(load(VALID.replace('  stale_work_minutes: 8', '  stale_work_minutes: 0')).errors[0], /stale_work_minutes/)
  assert.match(load(VALID.replace('  stale_verify_minutes: 2', '  stale_verify_minutes: soon')).errors[0], /stale_verify_minutes/)
  assert.equal(loaded(VALID.replace('  stale_work_minutes: 8', '  stale_work_minutes: 0.5')).staleWorkMs, 30_000)
})

test('block_edits_without_active_card must be boolean', () => {
  assert.match(load(VALID.replace('  block_edits_without_active_card: true', '  block_edits_without_active_card: yes')).errors[0], /block_edits_without_active_card/)
})

test('the log path must stay inside the repo', () => {
  for (const bad of ['../outside.md', '/etc/pm.md', '.claude/../../up.md']) {
    const result = load(VALID.replace('log: .claude/pm-sync.log.md', `log: ${bad}`))
    assert.equal(result.state, 'invalid', bad)
    assert.match(result.errors[0], /log/)
  }
})

test('a connector that is not a tool-name prefix warns but still works', () => {
  const result = load(VALID.replace('connector: mcp__claude_ai_Project_Management_System__', 'connector: pm_tools'))
  assert.equal(result.state, 'ok')
  assert.ok(result.warnings.some((warning) => warning.includes('connector')))
})

test('configPath prefers .pm-sync.local.md at the root, then the .claude path, and PM_SYNC_CONFIG beats both', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-config-path-'))
  assert.equal(configPath(root, {}), join(root, DEFAULT_CONFIG_RELATIVE), 'neither exists: the legacy default')
  writeFileSync(join(root, '.pm-sync.local.md'), '---\nenabled: false\n---\n')
  assert.equal(configPath(root, {}), join(root, '.pm-sync.local.md'))
  assert.equal(configPath(root, { PM_SYNC_CONFIG: 'x.md' }), join(root, 'x.md'))
})
