// End to end: the Codex and Grok adapters, the outbox, repo_context reconcile and the
// git catch-up, each driven through pm-sync.mjs against a temporary git checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-sync.mjs')
const BOARD = '5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11'
const ACTIVE_GROUP = '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55'
const QA_GROUP = '6a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c44'
const CONNECTOR = 'mcp__claude_ai_Project_Management_System__'
const T0 = Date.parse('2026-10-05T03:00:00.000Z')
const MINUTE = 60_000
const OUTBOX = '.pm-sync/outbox.jsonl'

const CONFIG = [
  '---',
  'enabled: true',
  'board:',
  '  name: Acme Web',
  `  id: ${BOARD}`,
  'lanes:',
  '  Queue: 8c4d3e5f-6a7b-4c8d-ae9f-1a2b3c4d5e66',
  `  In-progress: ${ACTIVE_GROUP}`,
  `  QA: ${QA_GROUP}`,
  'active_lane: In-progress',
  `connector: ${CONNECTOR}`,
  'track:',
  '  - packages/core/src/**',
  '  - scripts/*builder*.mjs',
  '---',
  '',
  'RULES BODY',
].join('\n')

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** A temp git checkout with tracked files; the config goes to `configAt` unless it is null. */
function checkout({ configAt = '.pm-sync.local.md', config = CONFIG, remote = 'git@github.com:acme/widgets.git', commit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-sync-'))
  git(root, 'init', '-q', '-b', 'feature/drag')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  for (const path of ['packages/core/src/a.ts', 'scripts/test-builder.mjs', 'docs/notes.md']) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), `// ${path}\n`)
  }
  if (remote) git(root, 'remote', 'add', 'origin', remote)
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init') }
  if (configAt) {
    mkdirSync(join(root, dirname(configAt)), { recursive: true })
    writeFileSync(join(root, configAt), config)
  }
  return root
}

function run(root, mode, payload = {}, { at = T0, env = {}, args = [], raw = null } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, mode, ...args], {
    input: raw ?? JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PM_SYNC_NOW: String(at), CLAUDE_PROJECT_DIR: root, ...env },
  })
  assert.equal(result.status, 0, `${mode} must exit 0: ${result.stderr}`)
  assert.equal(result.stderr, '', `${mode} must not write to stderr`)
  let json = null
  if (result.stdout.trim() !== '') {
    try { json = JSON.parse(result.stdout) } catch { assert.fail(`${mode} wrote non-JSON: ${result.stdout}`) }
  }
  return { stdout: result.stdout, json }
}

const context = (result) => {
  assert.ok(result.json?.hookSpecificOutput, `expected hookSpecificOutput, got ${result.stdout || '(no output)'}`)
  return String(result.json.hookSpecificOutput.additionalContext ?? '')
}
const outbox = (root) => (existsSync(join(root, OUTBOX))
  ? readFileSync(join(root, OUTBOX), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [])
const stateOf = (root) => JSON.parse(readFileSync(join(root, `.git/claude-pm-sync-${BOARD.slice(0, 8)}.json`), 'utf8'))
// Clocks and HEAD at the last write are per checkout, in a file beside the shared mirror.
const localOf = (root) => {
  const name = readdirSync(join(root, '.git')).find((entry) => entry.startsWith(`claude-pm-sync-${BOARD.slice(0, 8)}-wt-`))
  return JSON.parse(readFileSync(join(root, '.git', name), 'utf8'))
}

const itemJson = (status, id = 'item-aaaaaaaa', groupId = ACTIVE_GROUP) => JSON.stringify({
  item: { id, boardId: BOARD, groupId, status, untrusted_text: { name: 'Builder drag and drop' } },
})
const write = (status, requestId = 'req-1', response = itemJson(status)) => ({
  tool_name: `${CONNECTOR}items`,
  tool_input: { action: 'update_item', arguments: { itemId: 'item-aaaaaaaa', fields: { Status: status }, requestId } },
  tool_response: response,
})
const patch = (...paths) => ['*** Begin Patch', ...paths.map((path) => `*** Update File: ${path}`), '*** End Patch'].join('\n')

// --- client adapters -------------------------------------------------------------------

test('Codex: an apply_patch touching a tracked file is denied with the Claude-shaped deny', () => {
  const root = checkout()
  const denied = run(root, 'pre-tool', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch('docs/notes.md', 'packages/core/src/a.ts') }, cwd: root }, { args: ['--client', 'codex'] })
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /In-progress/)
  const untracked = run(root, 'pre-tool', { tool_name: 'apply_patch', tool_input: { command: patch('docs/notes.md') }, cwd: root })
  assert.equal(untracked.stdout, '', 'an untracked patch passes, and apply_patch alone is detected as Codex')
})

test('Codex: a Move-to target counts as an edit of the tracked destination', () => {
  const root = checkout()
  const text = '*** Begin Patch\r\n*** Update File: docs/notes.md\r\n*** Move to: scripts/x-builder.mjs\r\n*** End Patch\r\n'
  const denied = run(root, 'pre-tool', { tool_name: 'apply_patch', tool_input: { command: text }, cwd: root }, { args: ['--client', 'codex'] })
  assert.equal(denied.json?.hookSpecificOutput?.permissionDecision, 'deny', 'CRLF text and the Move-to path are both read')
})

test('Codex: a tracked apply_patch with no active card nudges as context, not a result-replacing block', () => {
  const root = checkout()
  const result = run(root, 'post-tool', { tool_name: 'apply_patch', tool_input: { command: patch('packages/core/src/a.ts') }, cwd: root }, { args: ['--client', 'codex'] })
  assert.equal(result.json?.decision, undefined)
  assert.match(context(result), /no Acme Web card is recorded in In-progress/)
})

test('Codex: a session start and a Stop use the Claude shapes', () => {
  const root = checkout()
  const start = run(root, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd: root }, { args: ['--client', 'codex'] })
  assert.equal(start.json.hookSpecificOutput.hookEventName, 'SessionStart')
  run(root, 'stop', { cwd: root }, { args: ['--client', 'codex'] })
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed\n')
  const stop = run(root, 'stop', { cwd: root, stop_hook_active: false }, { args: ['--client', 'codex'], at: T0 + MINUTE })
  assert.equal(stop.json.decision, 'block')
})

test('Grok: a camelCase tracked edit is denied with {decision: deny, reason}', () => {
  const root = checkout()
  const denied = run(root, 'pre-tool', { hookEventName: 'PreToolUse', toolName: 'Edit', toolInput: { file_path: join(root, 'packages/core/src/a.ts') }, cwd: root })
  assert.equal(denied.json.decision, 'deny')
  assert.match(denied.json.reason, /In-progress/)
  assert.equal(denied.json.hookSpecificOutput, undefined)
})

test('Grok: passive events print nothing, but the mirror is still kept', () => {
  const root = checkout()
  assert.equal(run(root, 'session-start', { hookEventName: 'SessionStart', cwd: root }).stdout, '')
  const edit = { hookEventName: 'PostToolUse', toolName: 'Edit', toolInput: { file_path: 'packages/core/src/a.ts' }, cwd: root }
  assert.equal(run(root, 'post-tool', edit).stdout, '', 'no nudge: Grok ignores it')
  const mirrored = run(root, 'post-tool', { hookEventName: 'PostToolUse', toolName: `${CONNECTOR}items`, toolInput: write('In-progress').tool_input, toolResponse: itemJson('In-progress'), cwd: root })
  assert.equal(mirrored.stdout, '')
  assert.equal(stateOf(root).items['item-aaaaaaaa'].status, 'In-progress')
  assert.equal(run(root, 'pre-tool', { toolName: 'Edit', toolInput: { file_path: 'packages/core/src/a.ts' }, cwd: root }).stdout, '', 'the gate opened')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed\n')
  run(root, 'stop', { hookEventName: 'Stop', cwd: root })
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed again\n')
  assert.equal(run(root, 'stop', { hookEventName: 'Stop', cwd: root }, { at: T0 + MINUTE }).stdout, '')
})

test('Grok: a camelCase payload missing every optional field is silent and safe', () => {
  const root = checkout()
  for (const mode of ['session-start', 'pre-tool', 'post-tool', 'post-tool-failure', 'stop']) {
    assert.equal(run(root, mode, { hookEventName: 'X' }, { env: { CLAUDE_PROJECT_DIR: root } }).stdout, '', mode)
  }
})

test('non-JSON stdin exits 0 silently in every mode and for every client', () => {
  const root = checkout()
  for (const client of ['claude-code', 'codex', 'grok']) {
    for (const mode of ['pre-tool', 'post-tool', 'post-tool-failure', 'stop']) {
      assert.equal(run(root, mode, null, { raw: '}{ not json', args: ['--client', client] }).stdout, '', `${client} ${mode}`)
    }
  }
})

// --- outbox ----------------------------------------------------------------------------

test('every write instruction asks for a requestId', () => {
  const root = checkout()
  assert.match(context(run(root, 'session-start', { cwd: root })), /requestId/)
  const failure = run(root, 'post-tool-failure', { ...write('QA'), cwd: root })
  assert.match(context(failure), /requestId "req-1"/)
})

test('Claude: a failed board write is queued in the outbox with its requestId', () => {
  const root = checkout()
  run(root, 'post-tool-failure', { ...write('QA', 'req-77'), error: 'socket hang up', cwd: root })
  const entries = outbox(root)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tool, `${CONNECTOR}items`)
  assert.equal(entries[0].requestId, 'req-77')
  assert.deepEqual(entries[0].arguments, write('QA', 'req-77').tool_input)
  assert.equal(entries[0].at, new Date(T0).toISOString())
})

test('a failed read is not queued: only writes are replayed', () => {
  const root = checkout()
  run(root, 'post-tool-failure', { tool_name: `${CONNECTOR}items`, tool_input: { action: 'get_item', arguments: { itemId: 'x' } }, cwd: root })
  assert.deepEqual(outbox(root), [])
})

test('Codex: an error-looking PostToolUse result is a failure: queued, not mirrored, and the redo is asked for', () => {
  const root = checkout()
  const result = run(root, 'post-tool', { ...write('In-progress', 'req-9', { isError: true, content: [{ type: 'text', text: 'timeout' }] }), cwd: root }, { args: ['--client', 'codex'] })
  assert.match(context(result), /FAILED/)
  assert.match(context(result), /req-9/)
  assert.equal(outbox(root)[0].requestId, 'req-9')
  assert.equal(existsSync(join(root, '.pm-sync.log.md')), false, 'a failed write is not a write')
  const denied = run(root, 'pre-tool', { tool_name: 'apply_patch', tool_input: { command: patch('packages/core/src/a.ts') }, cwd: root })
  assert.equal(denied.json?.hookSpecificOutput?.permissionDecision, 'deny', 'the failed move did not open the gate')
})

test('Grok: a failed write is queued silently', () => {
  const root = checkout()
  const result = run(root, 'post-tool-failure', { hookEventName: 'PostToolUseFailure', toolName: `${CONNECTOR}items`, toolInput: write('QA', 'req-g').tool_input, cwd: root })
  assert.equal(result.stdout, '')
  assert.equal(outbox(root)[0].requestId, 'req-g')
})

test('a replay that succeeds with the same requestId clears its outbox entry', () => {
  const root = checkout()
  run(root, 'post-tool-failure', { ...write('QA', 'req-1'), cwd: root })
  run(root, 'post-tool-failure', { ...write('Queue', 'req-2'), cwd: root })
  run(root, 'post-tool', { ...write('QA', 'req-1'), cwd: root }, { at: T0 + MINUTE })
  assert.deepEqual(outbox(root).map((entry) => entry.requestId), ['req-2'])
})

test('a successful identical write without a requestId also clears the entry', () => {
  const root = checkout()
  const bare = { tool_name: `${CONNECTOR}update_item`, tool_input: { itemId: 'item-aaaaaaaa', fields: { Status: 'QA' } } }
  run(root, 'post-tool-failure', { ...bare, cwd: root })
  assert.equal(outbox(root).length, 1)
  assert.equal(outbox(root)[0].requestId, null)
  run(root, 'post-tool', { ...bare, tool_response: itemJson('QA'), cwd: root }, { at: T0 + MINUTE })
  assert.deepEqual(outbox(root), [])
})

test('session start asks for queued writes to be replayed with the same requestIds', () => {
  const root = checkout()
  run(root, 'post-tool-failure', { ...write('QA', 'req-5'), cwd: root })
  const text = context(run(root, 'session-start', { cwd: root }, { at: T0 + MINUTE }))
  assert.match(text, /1 board write.* queued/i)
  assert.match(text, /req-5/)
  assert.match(text, /same requestId/)
  assert.match(text, /ask .*instead of replaying/i, 'the server-wins rule rides with it')
})

test('post-tool reminds about a non-empty outbox at most once per five minutes', () => {
  const root = checkout()
  run(root, 'post-tool-failure', { ...write('QA', 'req-5'), cwd: root })
  const read = { tool_name: 'Read', tool_input: { file_path: 'docs/notes.md' }, cwd: root }
  const bash = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root }
  assert.match(context(run(root, 'post-tool', bash, { at: T0 + MINUTE })), /req-5/)
  assert.equal(run(root, 'post-tool', bash, { at: T0 + 3 * MINUTE }).stdout, '', 'inside the cooldown')
  assert.match(context(run(root, 'post-tool', bash, { at: T0 + 7 * MINUTE })), /req-5/)
  run(root, 'post-tool', { ...write('QA', 'req-5'), cwd: root }, { at: T0 + 8 * MINUTE })
  assert.equal(run(root, 'post-tool', bash, { at: T0 + 20 * MINUTE }).stdout, '', 'an empty outbox says nothing')
  assert.equal(run(root, 'post-tool', read, { at: T0 + 30 * MINUTE }).stdout, '')
})

test('a corrupt outbox line never breaks a hook', () => {
  const root = checkout()
  mkdirSync(join(root, '.pm-sync'), { recursive: true })
  writeFileSync(join(root, OUTBOX), `{broken\n${JSON.stringify({ at: 'x', tool: `${CONNECTOR}items`, arguments: {}, requestId: 'req-ok' })}\n`)
  assert.match(context(run(root, 'session-start', { cwd: root })), /req-ok/)
})

test('a full outbox drops the oldest and says so', () => {
  const root = checkout()
  // 52 different writes (one per card): the same write retried under new requestIds is one entry.
  for (let n = 0; n < 52; n += 1) {
    const failed = write('QA', `req-${n}`)
    failed.tool_input.arguments.itemId = `item-${String(n).padStart(8, '0')}`
    run(root, 'post-tool-failure', { ...failed, cwd: root })
  }
  assert.equal(outbox(root).length, 50)
  const text = context(run(root, 'session-start', { cwd: root }))
  assert.match(text, /2 older queued writes? (was|were) dropped/)
})

// --- repo_context reconcile ------------------------------------------------------------

const repoContext = (body, layout = 'grouped') => (layout === 'grouped'
  ? { tool_name: `${CONNECTOR}items`, tool_input: { action: 'repo_context', arguments: { remote: 'acme/widgets' } }, tool_response: JSON.stringify(body) }
  : { tool_name: `${CONNECTOR}repo_context`, tool_input: { remote: 'acme/widgets' }, tool_response: JSON.stringify(body) })

test('session start asks for a full repo_context call with the local remote, branch and known ids', () => {
  const root = checkout()
  run(root, 'post-tool', { ...write('In-progress'), cwd: root })
  const text = context(run(root, 'session-start', { cwd: root, source: 'resume' }, { at: T0 + MINUTE }))
  assert.match(text, /repo_context/)
  assert.match(text, /git@github\.com:acme\/widgets\.git/)
  assert.match(text, /feature\/drag/)
  assert.match(text, /item-aaaaaaaa/)
  assert.match(text, /full call/i, 'no cursor recorded yet')
  // The server lists repo_context as an action of the grouped items tool; there is no identity group tool.
  assert.match(text, /items with action "repo_context"/)
  assert.doesNotMatch(text, /identity/)
})

test('a repo_context response stores the cursor, refreshes cards and drops gone ones', () => {
  const root = checkout()
  run(root, 'post-tool', { ...write('In-progress'), cwd: root })
  run(root, 'post-tool', { ...write('QA', 'req-2', itemJson('QA', 'item-bbbbbbbb', QA_GROUP)), cwd: root })
  const body = {
    repo: { fullName: 'acme/widgets' },
    match: 'linked',
    cursor: '2026-10-05T03:30:00.000Z',
    boards: [{ id: BOARD, url: 'u', untrusted_text: { name: 'Acme Web' } }],
    items: [{ id: 'item-aaaaaaaa', url: 'u', boardId: BOARD, groupId: QA_GROUP, status: 'QA', updatedAt: '2026-10-05T03:20:00.000Z', assignedToMe: true, branchMatch: true, untrusted_text: { name: 'Renamed\u001b[31m card', branches: ['feature/drag'] } }],
    gone: ['item-bbbbbbbb'],
    truncated: false,
  }
  // The card this checkout put in In-progress now sits in QA: someone else moved it.
  assert.match(context(run(root, 'post-tool', { ...repoContext(body), cwd: root }, { at: T0 + 30 * MINUTE })), /moved to QA on the board, not by this session/)
  const state = stateOf(root)
  assert.equal(state.syncedThrough, '2026-10-05T03:30:00.000Z')
  assert.equal(state.items['item-aaaaaaaa'].status, 'QA')
  assert.equal(state.items['item-aaaaaaaa'].groupId, QA_GROUP)
  assert.equal(state.items['item-aaaaaaaa'].name, 'Renamed card', 'board text is sanitised')
  assert.equal(state.items['item-bbbbbbbb'], undefined, 'a gone card leaves the mirror')
  assert.equal(localOf(root).lastWriteAt, new Date(T0).toISOString(), 'a reconcile is a read, not a write')
  const text = context(run(root, 'session-start', { cwd: root, source: 'compact' }, { at: T0 + 31 * MINUTE }))
  assert.match(text, /since "2026-10-05T03:30:00\.000Z"/)
})

test('the individual repo_context tool layout is handled the same way', () => {
  const root = checkout()
  run(root, 'post-tool', { ...repoContext({ match: 'no_links', cursor: '2026-10-05T04:00:00.000Z', boards: [], items: [], gone: [], truncated: false }, 'individual'), cwd: root })
  assert.equal(stateOf(root).syncedThrough, '2026-10-05T04:00:00.000Z')
})

test('a repo_context for an unknown repo changes nothing in the mirror', () => {
  const root = checkout()
  run(root, 'post-tool', { ...write('In-progress'), cwd: root })
  const before = readFileSync(join(root, `.git/claude-pm-sync-${BOARD.slice(0, 8)}.json`), 'utf8')
  run(root, 'post-tool', { ...repoContext({ match: 'unknown_repo', cursor: '2026-10-05T05:00:00.000Z', boards: [], items: [], gone: ['item-aaaaaaaa'], truncated: false }), cwd: root }, { at: T0 + MINUTE })
  assert.equal(readFileSync(join(root, `.git/claude-pm-sync-${BOARD.slice(0, 8)}.json`), 'utf8'), before)
})

test('a repo_context item from another board is not mirrored here', () => {
  const root = checkout()
  run(root, 'post-tool', { ...repoContext({ match: 'linked', cursor: '2026-10-05T04:00:00.000Z', boards: [], items: [{ id: 'item-foreign1', boardId: 'ffffffff-0000-1111-2222-333333333333', groupId: 'g', status: 'In-progress', untrusted_text: { name: 'F' } }], gone: [], truncated: false }), cwd: root })
  assert.equal(stateOf(root).items['item-foreign1'], undefined)
})

// --- git catch-up ----------------------------------------------------------------------

test('commits made after the last board write are reported at session start', () => {
  const root = checkout()
  run(root, 'post-tool', { ...write('In-progress'), cwd: root })
  assert.equal(localOf(root).headAtWrite, git(root, 'rev-parse', 'HEAD'))
  assert.doesNotMatch(context(run(root, 'session-start', { cwd: root })), /commits? since the last board write/)
  for (const n of [1, 2]) {
    writeFileSync(join(root, 'docs/notes.md'), `// ${n}\n`)
    git(root, 'commit', '-q', '-am', `c${n}`)
  }
  assert.match(context(run(root, 'session-start', { cwd: root })), /2 commits since the last board write; record them on the active card/)
})

test('an unknown recorded sha, a repo with no commits, or no remote are skipped silently', () => {
  const root = checkout({ remote: null, commit: false })
  run(root, 'post-tool', { ...write('In-progress'), cwd: root })
  const text = context(run(root, 'session-start', { cwd: root }))
  assert.doesNotMatch(text, /commits since/)
  assert.doesNotMatch(text, /remote "/)
  const other = checkout()
  run(other, 'post-tool', { ...write('In-progress'), cwd: other })
  const name = readdirSync(join(other, '.git')).find((entry) => entry.startsWith(`claude-pm-sync-${BOARD.slice(0, 8)}-wt-`))
  writeFileSync(join(other, '.git', name), JSON.stringify({ ...localOf(other), headAtWrite: 'deadbeef'.repeat(5) }))
  assert.doesNotMatch(context(run(other, 'session-start', { cwd: other })), /commits since/)
})

test('with git missing from PATH, or outside a repo, sync stays off: a config it cannot check is not trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-nogit-'))
  writeFileSync(join(root, '.pm-sync.local.md'), CONFIG)
  mkdirSync(join(root, 'packages/core/src'), { recursive: true })
  writeFileSync(join(root, 'packages/core/src/a.ts'), '//\n')
  for (const env of [{}, { PATH: '/nonexistent' }]) {
    const text = context(run(root, 'session-start', { cwd: root }, { env }))
    assert.doesNotMatch(text, /Acme Web/)
    assert.match(text, /board sync is off/)
    run(root, 'post-tool', { ...write('In-progress'), cwd: root }, { env })
  }
})

// --- config path -----------------------------------------------------------------------

test('the neutral .pm-sync.local.md wins over .claude/pm-sync.local.md, and its log sits beside it', () => {
  const root = checkout({ configAt: '.pm-sync.local.md' })
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude/pm-sync.local.md'), CONFIG.replace('name: Acme Web', 'name: Old Board'))
  const text = context(run(root, 'session-start', { cwd: root }))
  assert.match(text, /Acme Web/)
  assert.doesNotMatch(text, /Old Board/)
  run(root, 'post-tool', { ...write('QA'), cwd: root })
  assert.equal(existsSync(join(root, '.pm-sync.log.md')), true)
  assert.equal(existsSync(join(root, '.claude/pm-sync.log.md')), false)
})

test('an install with only .claude/pm-sync.local.md keeps working, logging into .claude', () => {
  const root = checkout({ configAt: '.claude/pm-sync.local.md' })
  assert.match(context(run(root, 'session-start', { cwd: root })), /Acme Web/)
  run(root, 'post-tool', { ...write('QA'), cwd: root })
  assert.equal(existsSync(join(root, '.claude/pm-sync.log.md')), true)
})

test('credentials embedded in the origin URL never reach the injected context', () => {
  const root = checkout({ remote: 'https://someone:low-entropy-fixture@github.com/acme/widgets.git' })
  const text = context(run(root, 'session-start', { cwd: root }))
  assert.match(text, /remote "https:\/\/github\.com\/acme\/widgets\.git"/)
  assert.doesNotMatch(text, /low-entropy-fixture|someone@/)
})

// --- connector: auto ---------------------------------------------------------------------

test('connector auto sees board calls under any MCP server name, and ignores another server\'s look-alike tool', () => {
  const root = checkout({ config: CONFIG.replace(`connector: ${CONNECTOR}`, 'connector: auto') })
  const asServer = (server, payload) => ({ ...payload, tool_name: payload.tool_name.replace(CONNECTOR, `mcp__${server}__`) })
  // Codex or Grok with a server the person named "pm": the card move is seen, so the edit gate opens.
  run(root, 'post-tool', { ...asServer('pm', write('In-progress')), cwd: root })
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(root, 'packages/core/src/a.ts') }, cwd: root }
  assert.equal(run(root, 'pre-tool', edit, { at: T0 + MINUTE }).stdout, '', 'the active card was recorded')
  const body = { repo: { fullName: 'acme/widgets' }, match: 'linked', cursor: '2026-10-05T03:30:00.000Z', boards: [], items: [], gone: [], truncated: false }
  run(root, 'post-tool', { ...asServer('drg-pm', repoContext(body)), cwd: root })
  assert.equal(stateOf(root).syncedThrough, '2026-10-05T03:30:00.000Z')
  // Another MCP server with an "items" tool, answering about a board that is not this one.
  const foreign = asServer('jira', write('QA', 'req-9', JSON.stringify({ item: { id: 'item-aaaaaaaa', boardId: 'other-board-0000', groupId: QA_GROUP, status: 'QA' } })))
  run(root, 'post-tool', { ...foreign, cwd: root })
  assert.equal(stateOf(root).items['item-aaaaaaaa'].status, 'In-progress', 'a response about another board changes nothing')
  const text = context(run(root, 'session-start', { cwd: root }, { at: T0 + 2 * MINUTE }))
  assert.doesNotMatch(text, /auto(items|\*)/, 'no literal "auto" prefix in the instructions')
})

// --- requestId only where the server takes one ----------------------------------------------

test('a requestId is asked for only on create_item and add_comment, which the server de-duplicates', () => {
  // update_item, move_item and attach_file_from_url have strict schemas without requestId: passing one fails the call.
  const root = checkout()
  const text = context(run(root, 'session-start', { cwd: root }))
  assert.match(text, /create_item and add_comment carry a requestId/)
  assert.match(text, /never pass a requestId to update_item, move_item or attach_file_from_url/i)
  assert.doesNotMatch(text, /Every board write .* carries a requestId/)
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(root, 'packages/core/src/a.ts') }, cwd: root }
  assert.doesNotMatch(run(root, 'pre-tool', edit).stdout, /requestId on every write/)
})

test('a failed update_item is replayed as it was, without being told to add a requestId', () => {
  const root = checkout()
  const bare = { tool_name: `${CONNECTOR}items`, tool_input: { action: 'update_item', arguments: { itemId: 'item-aaaaaaaa', fields: { Status: 'QA' } } } }
  const failure = context(run(root, 'post-tool-failure', { ...bare, cwd: root }))
  assert.doesNotMatch(failure, /with a requestId/)
  const text = context(run(root, 'session-start', { cwd: root }, { at: T0 + MINUTE }))
  assert.doesNotMatch(text, /use a fresh one/)
  assert.match(text, /sets a value/)
  const comment = { tool_name: `${CONNECTOR}items`, tool_input: { action: 'add_comment', arguments: { itemId: 'item-aaaaaaaa', body: 'done' } } }
  assert.match(context(run(root, 'post-tool-failure', { ...comment, cwd: root })), /with a requestId/, 'a comment without one should get one')
})
