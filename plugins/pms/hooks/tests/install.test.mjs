import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(HOOKS_DIR, '..')
const INSTALL = join(HOOKS_DIR, 'install.mjs')
const TEMPLATE = join(SKILL_DIR, 'settings.hooks.json')
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']
const MODES = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt', PreToolUse: 'pre-tool', PostToolUse: 'post-tool', PostToolUseFailure: 'post-tool-failure', Stop: 'stop' }

/** An unrelated settings file: other hooks, and settings that must survive untouched. */
const EXISTING = {
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'security-gate.sh', timeout: 15 }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node notifier.cjs stop' }] }],
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node notifier.cjs prompt' }] }],
  },
}

const LEGACY = {
  hooks: {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/pm-board-sync.mjs" session-start', timeout: 10 }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/pm-board-sync.mjs" stop', timeout: 20 }] }],
  },
}

function settingsFile(value) {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-install-'))
  const file = join(root, 'settings.json')
  if (value !== null) writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function install(file, args = []) {
  const result = spawnSync(process.execPath, [INSTALL, '--settings', file, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The settings file parsed, asserted to exist and to be valid JSON. */
function read(file) {
  assert.equal(existsSync(file), true, 'expected the settings file to exist')
  const text = readFileSync(file, 'utf8')
  try { return JSON.parse(text) } catch (error) { return assert.fail(`settings file is not valid JSON: ${error.message}`) }
}

const commandsOf = (settings, event) => (settings.hooks?.[event] ?? []).flatMap((block) => block.hooks.map((hook) => hook.command))
const pmCommands = (settings) => EVENTS.flatMap((event) => commandsOf(settings, event)).filter((command) => command.includes('pm-sync.mjs'))

test('the shipped settings.hooks.json registers exactly the six events, and every mode exists in the script', () => {
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  assert.deepEqual(Object.keys(template), ['hooks'])
  assert.deepEqual(Object.keys(template.hooks).sort(), [...EVENTS].sort())
  const script = readFileSync(join(HOOKS_DIR, 'pm-sync.mjs'), 'utf8')
  for (const event of EVENTS) {
    const blocks = template.hooks[event]
    assert.equal(blocks.length, 1, event)
    assert.equal(blocks[0].hooks.length, 1, event)
    const hook = blocks[0].hooks[0]
    assert.equal(hook.type, 'command', event)
    assert.match(hook.command, new RegExp(`pm-sync\\.mjs" ${MODES[event]}$`), event)
    assert.match(hook.command, /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/skills\/pm-sync\/hooks\/pm-sync\.mjs"/, event)
    assert.equal(hook.timeout, event === 'Stop' ? 20 : 10, event)
    assert.ok(script.includes(`mode === '${MODES[event]}'`), `pm-sync.mjs must handle the mode ${MODES[event]}`)
  }
  assert.equal(typeof template.hooks.PreToolUse[0].matcher, 'string')
  assert.match(template.hooks.PreToolUse[0].matcher, /Edit\|Write\|MultiEdit\|NotebookEdit/)
  assert.match(template.hooks.PostToolUse[0].matcher, /Bash/)
  assert.match(template.hooks.PostToolUseFailure[0].matcher, /^mcp__/)
  assert.equal(template.hooks.SessionStart[0].matcher, '')
  assert.equal(template.hooks.Stop[0].matcher, '')
})

test('the plugin hooks.json registers the same events and modes as the template, and sees repo links and repo_context', () => {
  const plugin = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'))
  assert.deepEqual(Object.keys(plugin.hooks).sort(), [...EVENTS].sort())
  for (const event of EVENTS) assert.match(plugin.hooks[event][0].hooks[0].command, new RegExp(`pm-sync\\.mjs" ${MODES[event]}$`), event)
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  for (const matcher of [plugin.hooks.PostToolUse[0].matcher, template.hooks.PostToolUse[0].matcher]) {
    for (const tool of ['repo_context', 'link_item_github', 'update_item_github_link']) {
      assert.ok(new RegExp(`^(?:${matcher})$`).test(`mcp__pms__${tool}`), `${tool} is seen by ${matcher}`)
    }
  }
})

test('every mode the template names runs and exits 0', () => {
  for (const mode of Object.values(MODES)) {
    const result = spawnSync(process.execPath, [join(HOOKS_DIR, 'pm-sync.mjs'), mode], { input: '{}', encoding: 'utf8' })
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
  }
})

test('install creates a settings file that does not exist yet', () => {
  const file = settingsFile(null)
  const result = install(file)
  assert.equal(result.code, 0, result.stderr)
  const settings = read(file)
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...EVENTS].sort())
  assert.equal(pmCommands(settings).length, 6)
  for (const event of EVENTS) assert.match(commandsOf(settings, event)[0], new RegExp(`pm-sync\\.mjs" ${MODES[event]}$`))
  assert.match(result.stdout, /install/i)
})

test('install writes 2-space JSON with a trailing newline', () => {
  const file = settingsFile({})
  install(file)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /\n$/)
  assert.match(text, /^\{\n  "hooks": \{\n    "SessionStart"/)
  assert.equal(text.includes('\t'), false)
})

test('install preserves every unrelated hook and setting', () => {
  const file = settingsFile(EXISTING)
  assert.equal(install(file).code, 0)
  const settings = read(file)
  assert.deepEqual(settings.permissions, EXISTING.permissions, 'unrelated settings survive')
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], EXISTING.hooks.UserPromptSubmit[0], 'an unrelated hook on a shared event survives, first')
  assert.equal(commandsOf(settings, 'PreToolUse').includes('security-gate.sh'), true, 'the security gate survives')
  assert.equal(commandsOf(settings, 'Stop').includes('node notifier.cjs stop'), true, 'the notifier survives')
  assert.equal(settings.hooks.PreToolUse.length, 2, 'pm-sync is appended, not substituted')
  assert.equal(settings.hooks.Stop.length, 2)
  assert.equal(pmCommands(settings).length, 6)
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node notifier.cjs stop', 'existing blocks keep their order')
})

test('running install twice changes nothing the second time', () => {
  const file = settingsFile(EXISTING)
  assert.equal(install(file).code, 0)
  const first = readFileSync(file, 'utf8')
  const stamp = statSync(file).mtimeMs
  const second = install(file)
  assert.equal(second.code, 0, second.stderr)
  assert.equal(readFileSync(file, 'utf8'), first, 'the file is byte-identical')
  assert.equal(statSync(file).mtimeMs, stamp, 'and it was not rewritten')
  assert.match(second.stdout, /already/i)
})

test('a partial install is repaired without duplicating what is there', () => {
  const file = settingsFile({})
  install(file)
  const settings = read(file)
  assert.ok(settings.hooks, 'expected the first install to register hooks')
  delete settings.hooks.PostToolUse
  delete settings.hooks.Stop
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  assert.equal(install(file).code, 0)
  const repaired = read(file)
  assert.equal(pmCommands(repaired).length, 6)
  assert.equal(commandsOf(repaired, 'SessionStart').length, 1, 'the surviving event is not duplicated')
})

test('a legacy pm-board-sync install is reported and refused unless replacement is asked for', () => {
  const file = settingsFile(LEGACY)
  const before = readFileSync(file, 'utf8')
  const result = install(file)
  assert.notEqual(result.code, 0, 'a legacy conflict must exit non-zero')
  assert.equal(readFileSync(file, 'utf8'), before, 'and must not write')
  const said = result.stdout + result.stderr
  assert.match(said, /pm-board-sync\.mjs/)
  assert.match(said, /--replace-legacy/)
})

test('--replace-legacy swaps the legacy hook for pm-sync and keeps unrelated hooks', () => {
  const file = settingsFile({ hooks: { ...LEGACY.hooks, Stop: [...LEGACY.hooks.Stop, ...EXISTING.hooks.Stop] } })
  const result = install(file, ['--replace-legacy'])
  assert.equal(result.code, 0, result.stderr)
  const settings = read(file)
  assert.equal(JSON.stringify(settings).includes('pm-board-sync.mjs'), false, 'no legacy command remains')
  assert.equal(pmCommands(settings).length, 6)
  assert.equal(commandsOf(settings, 'Stop').includes('node notifier.cjs stop'), true, 'the unrelated Stop hook survives')
  assert.match(result.stdout, /legacy/i)
})

test('--scope user points the commands at $HOME', () => {
  const file = settingsFile({})
  assert.equal(install(file, ['--scope', 'user']).code, 0)
  for (const command of pmCommands(read(file))) {
    assert.match(command, /^node "\$HOME\/\.claude\/skills\/pm-sync\/hooks\/pm-sync\.mjs"/)
    assert.equal(command.includes('CLAUDE_PROJECT_DIR'), false)
  }
})

test('--uninstall removes only the pm-sync blocks and drops what is left empty', () => {
  const file = settingsFile(EXISTING)
  install(file)
  const result = install(file, ['--uninstall'])
  assert.equal(result.code, 0, result.stderr)
  const settings = read(file)
  assert.equal(JSON.stringify(settings).includes('pm-sync.mjs'), false)
  assert.deepEqual(settings.permissions, EXISTING.permissions)
  assert.deepEqual(settings.hooks.PreToolUse, EXISTING.hooks.PreToolUse, 'the security gate is untouched')
  assert.deepEqual(settings.hooks.Stop, EXISTING.hooks.Stop)
  assert.deepEqual(settings.hooks.UserPromptSubmit, EXISTING.hooks.UserPromptSubmit)
  assert.equal('SessionStart' in settings.hooks, false, 'an event left with no hooks is dropped')
  assert.equal('PostToolUse' in settings.hooks, false)
  assert.match(result.stdout, /remov/i)
})

test('--uninstall drops the hooks key entirely when pm-sync was all it held', () => {
  const file = settingsFile({ permissions: { allow: [] } })
  install(file)
  assert.equal(install(file, ['--uninstall']).code, 0)
  const settings = read(file)
  assert.equal('hooks' in settings, false)
  assert.deepEqual(settings.permissions, { allow: [] })
})

test('--uninstall with nothing installed is a silent no-op', () => {
  const file = settingsFile(EXISTING)
  const before = readFileSync(file, 'utf8')
  const result = install(file, ['--uninstall'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.match(result.stdout, /nothing/i)
})

test('malformed JSON is refused with exit code 2 and no write', () => {
  const file = settingsFile('{ "hooks": { oops }')
  const result = install(file)
  assert.equal(result.code, 2)
  assert.equal(readFileSync(file, 'utf8'), '{ "hooks": { oops }', 'the file is left exactly as it was')
  assert.match(result.stderr, /not valid JSON/i)
  assert.match(result.stderr, /settings\.json/)
  assert.equal(install(file, ['--uninstall']).code, 2, 'uninstall refuses it too')
})

test('settings that are JSON but not an object are refused', () => {
  for (const text of ['[]', '"hello"', '42', 'null']) {
    const file = settingsFile(text)
    const result = install(file)
    assert.equal(result.code, 2, text)
    assert.equal(readFileSync(file, 'utf8'), text, text)
  }
})

test('--dry-run prints what would change and writes nothing', () => {
  const file = settingsFile(EXISTING)
  const result = install(file, ['--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(EXISTING, null, 2)}\n`, 'nothing is written')
  assert.match(result.stdout, /dry run/i)
  assert.match(result.stdout, /^\+.*pm-sync\.mjs\\" session-start/m, 'the added lines are shown as a diff')
  assert.equal(/^-/m.test(result.stdout), false, 'an install removes no lines')
  assert.equal(result.stdout.includes('security-gate.sh'), false, 'unchanged lines are not noise')
})

test('--dry-run of an uninstall shows the removals', () => {
  const file = settingsFile(EXISTING)
  install(file)
  const after = readFileSync(file, 'utf8')
  const result = install(file, ['--uninstall', '--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readFileSync(file, 'utf8'), after)
  assert.match(result.stdout, /^-.*pm-sync\.mjs\\" stop/m)
})

test('a bad flag or scope is refused with usage, exit 2', () => {
  const file = settingsFile({})
  for (const args of [['--nonsense'], ['--scope', 'sideways'], ['--scope']]) {
    const result = install(file, args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr + result.stdout, /usage/i, args.join(' '))
  }
  assert.equal(existsSync(file) && readFileSync(file, 'utf8'), '{}\n'.replace('{}\n', readFileSync(file, 'utf8')))
})

test('--settings may be omitted: the project default is .claude/settings.json under the cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-install-cwd-'))
  const result = spawnSync(process.execPath, [INSTALL], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const settings = read(join(root, '.claude/settings.json'))
  assert.equal(pmCommands(settings).length, 6)
})

test('install reports the file it wrote and how to undo it', () => {
  const file = settingsFile({})
  const result = install(file)
  assert.ok(result.stdout.includes(file), 'the target path is named')
  assert.match(result.stdout, /--uninstall/, 'and so is the way back out')
})

// --- clients ---------------------------------------------------------------------------

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']

test('--client codex writes .codex/hooks.json with five events, explicit --client codex, and no PostToolUseFailure', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-install-codex-'))
  const result = spawnSync(process.execPath, [INSTALL, '--client', 'codex'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const settings = read(join(root, '.codex/hooks.json'))
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...CODEX_EVENTS].sort())
  for (const event of CODEX_EVENTS) {
    const [command] = commandsOf(settings, event)
    assert.match(command, new RegExp(`pm-sync\\.mjs" ${MODES[event]} --client codex$`), event)
    assert.equal(command.includes('CLAUDE_PROJECT_DIR'), false, 'Codex does not set CLAUDE_PROJECT_DIR')
  }
  assert.match(settings.hooks.PreToolUse[0].matcher, /apply_patch/)
  assert.match(settings.hooks.PostToolUse[0].matcher, /apply_patch/)
  assert.match(settings.hooks.PostToolUse[0].matcher, /mcp__/)
  assert.match(result.stdout, /\/hooks/, 'the trust reminder is printed')
  assert.match(result.stdout, /re-?approv|re-?trust/i)
})

test('--client codex is idempotent, keeps other hooks, dry-runs and uninstalls', () => {
  const file = settingsFile(EXISTING)
  assert.equal(install(file, ['--client', 'codex', '--dry-run']).code, 0)
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(EXISTING, null, 2)}\n`)
  assert.equal(install(file, ['--client', 'codex']).code, 0)
  const first = readFileSync(file, 'utf8')
  assert.match(install(file, ['--client', 'codex']).stdout, /already/i)
  assert.equal(readFileSync(file, 'utf8'), first)
  assert.equal(commandsOf(read(file), 'PreToolUse').includes('security-gate.sh'), true)
  assert.equal(install(file, ['--client', 'codex', '--uninstall']).code, 0)
  assert.deepEqual(read(file), EXISTING)
  const bad = settingsFile('{ nope')
  assert.equal(install(bad, ['--client', 'codex']).code, 2, 'malformed JSON is refused for Codex too')
})

test('--client codex --scope user points at $HOME', () => {
  const file = settingsFile({})
  assert.equal(install(file, ['--client', 'codex', '--scope', 'user']).code, 0)
  for (const command of commandsOf(read(file), 'Stop')) assert.match(command, /^node "\$HOME\/\.claude\/skills\/pm-sync\/hooks\/pm-sync\.mjs"/)
})

test('--client grok installs the Claude registration unchanged, with no --client flag, so both clients can share it', () => {
  const claude = settingsFile({})
  const grok = settingsFile({})
  assert.equal(install(claude).code, 0)
  const result = install(grok, ['--client', 'grok'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(read(grok), read(claude))
  assert.equal(JSON.stringify(read(grok)).includes('--client'), false)
  assert.match(result.stdout, /hooks-trust/)
  assert.match(install(grok, ['--client', 'grok']).stdout, /already/i, 'a Claude install already serves Grok')
  assert.equal(install(grok, ['--client', 'grok', '--uninstall']).code, 0)
})

test('--client grok defaults to .claude/settings.json, the file Grok reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-install-grok-'))
  assert.equal(spawnSync(process.execPath, [INSTALL, '--client', 'grok'], { cwd: root, encoding: 'utf8' }).status, 0)
  assert.equal(pmCommands(read(join(root, '.claude/settings.json'))).length, 6)
})

test('an unknown --client is refused with usage', () => {
  const result = install(settingsFile({}), ['--client', 'cursor'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /usage/i)
})

// --- --config-json ---------------------------------------------------------------------

const SETUP = {
  board: { name: 'Ops: Q4 #launch', id: '5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11', url: 'https://pm.example.com/boards/5e1f0c2a' },
  lanes: [
    { name: 'To do: next', groupId: '8c4d3e5f-6a7b-4c8d-ae9f-1a2b3c4d5e66' },
    { name: 'Doing #1', groupId: '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55' },
    { name: "It's \"done\"", groupId: '9d5e4f6a-7b8c-4d9e-8f0a-2b3c4d5e6f77' },
  ],
  activeLane: 'Doing #1',
  statusColumn: { id: 'status', options: ['To do: next', 'Doing #1'] },
  priorityOptions: ['High', 'Low'],
}

function configJson(value, args = [], { existing = null, legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-config-json-'))
  const file = join(root, 'setup.json')
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  if (existing !== null) writeFileSync(join(root, '.pm-sync.local.md'), existing)
  if (legacy) { mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.claude/pm-sync.local.md'), '---\nenabled: false\n---\n') }
  const result = spawnSync(process.execPath, [INSTALL, '--config-json', file, ...args], { cwd: root, encoding: 'utf8' })
  return { root, code: result.status, stdout: result.stdout, stderr: result.stderr, target: join(root, '.pm-sync.local.md') }
}

test('--config-json writes a valid, enabled .pm-sync.local.md from the repo_context setup', async () => {
  const { loadConfig } = await import('../lib/config.mjs')
  const result = configJson({ config: SETUP })
  assert.equal(result.code, 0, result.stderr)
  const loaded = loadConfig({ root: result.root, env: {} })
  assert.equal(loaded.state, 'ok', loaded.errors.join('; '))
  assert.equal(loaded.path, result.target)
  assert.equal(loaded.config.board.name, 'Ops: Q4 #launch', 'a name with ": " and " #" survives the YAML subset')
  assert.deepEqual(loaded.config.lanes.map((lane) => lane.name), ['To do: next', 'Doing #1', "It's \"done\""], 'lanes keep board order')
  assert.equal(loaded.config.activeLane, 'Doing #1')
  assert.equal(loaded.config.activeLaneId, '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55')
  assert.equal(loaded.config.logRelative, '.pm-sync.log.md')
  assert.ok(loaded.config.track.length > 0)
  const text = readFileSync(result.target, 'utf8')
  assert.match(text, /narrow/i, 'the person is told to narrow track')
  assert.match(text, /## Board rules/, 'the default rules body is appended')
  assert.equal(loaded.config.connector, 'auto', 'the server name differs per client, so the written config matches any')
})

test('--config-json with --client writes the config AND installs that client\'s hooks in one command', () => {
  const both = configJson({ config: SETUP }, ['--client', 'codex'])
  assert.equal(both.code, 0, both.stderr)
  assert.ok(existsSync(both.target), 'config written')
  const hooks = readFileSync(join(both.root, '.codex/hooks.json'), 'utf8')
  assert.match(hooks, /pm-sync\.mjs/, 'codex hooks installed')
  assert.match(both.stdout, /\/hooks/, 'tells the person to approve the hooks in Codex')

  const configOnly = configJson({ config: SETUP })
  assert.equal(configOnly.code, 0, configOnly.stderr)
  assert.ok(!existsSync(join(configOnly.root, '.codex/hooks.json')) && !existsSync(join(configOnly.root, '.claude/settings.json')),
    'without --client only the config is written')
})

test('run from a subfolder of a git checkout, the config and the hooks both land at the repo root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-subdir-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  const sub = join(root, 'apps', 'web')
  mkdirSync(sub, { recursive: true })
  const file = join(root, 'setup.json')
  writeFileSync(file, JSON.stringify({ config: SETUP }))
  const result = spawnSync(process.execPath, [INSTALL, '--config-json', file, '--client', 'codex'], { cwd: sub, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(join(root, '.pm-sync.local.md')))
  assert.ok(existsSync(join(root, '.codex/hooks.json')), 'hooks at the root, where Codex reads them')
  assert.ok(!existsSync(join(sub, '.codex')))
})

test('--config-json also takes the bare setup object', async () => {
  const { loadConfig } = await import('../lib/config.mjs')
  const result = configJson(SETUP)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(loadConfig({ root: result.root, env: {} }).state, 'ok')
})

test('--config-json refuses a null activeLane unless --active-lane names one', () => {
  const refused = configJson({ config: { ...SETUP, activeLane: null } })
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /--active-lane/)
  assert.equal(existsSync(refused.target), false)
  const named = configJson({ config: { ...SETUP, activeLane: null } }, ['--active-lane', 'To do: next'])
  assert.equal(named.code, 0, named.stderr)
  assert.match(readFileSync(named.target, 'utf8'), /active_lane: "To do: next"/)
  const wrong = configJson({ config: SETUP }, ['--active-lane', 'Nope'])
  assert.equal(wrong.code, 2)
  assert.match(wrong.stderr, /not one of the lanes/)
})

test('--config-json refuses to overwrite an existing config without --force', () => {
  const kept = configJson({ config: SETUP }, [], { existing: 'MINE\n' })
  assert.notEqual(kept.code, 0)
  assert.equal(readFileSync(kept.target, 'utf8'), 'MINE\n')
  assert.match(kept.stderr, /--force/)
  const forced = configJson({ config: SETUP }, ['--force'], { existing: 'MINE\n' })
  assert.equal(forced.code, 0, forced.stderr)
  assert.match(readFileSync(forced.target, 'utf8'), /enabled: true/)
})

test('--config-json notes that the new file shadows a legacy .claude config', () => {
  const result = configJson({ config: SETUP }, [], { legacy: true })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /\.claude\/pm-sync\.local\.md/)
})

test('--config-json refuses malformed or incomplete input and writes nothing', () => {
  for (const value of ['{ not json', { config: { lanes: [] } }, { config: { ...SETUP, board: { name: 'x' } } }, '[]']) {
    const result = configJson(value)
    assert.equal(result.code, 2, JSON.stringify(value))
    assert.equal(existsSync(result.target), false)
  }
})

test('--config-json --dry-run prints the config and writes nothing', () => {
  const result = configJson({ config: SETUP }, ['--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /enabled: true/)
  assert.equal(existsSync(result.target), false)
})
