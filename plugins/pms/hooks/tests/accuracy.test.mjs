// End to end: Finish-check accuracy, the content fingerprint, per-checkout state, whose
// card is active, git events, subtasks and freshness, each through pm-sync.mjs against
// a temporary git checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pm-sync.mjs')
const BOARD = '5e1f0c2a-7b3d-4c8e-9a10-2f4b6d8e0a11'
const QUEUE_GROUP = '8c4d3e5f-6a7b-4c8d-ae9f-1a2b3c4d5e66'
const ACTIVE_GROUP = '7b3c2d4e-5f6a-4b7c-9d8e-0f1a2b3c4d55'
const QA_GROUP = '6a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c44'
const DONE_GROUP = '9d5e4f6a-7b8c-4d9e-8f0a-2b3c4d5e6f77'
const CONNECTOR = 'mcp__claude_ai_Project_Management_System__'
const T0 = Date.parse('2026-10-05T03:00:00.000Z')
const MINUTE = 60_000
const CARD = 'item-aaaaaaaa'
const PR = 'https://github.com/acme/widgets/pull/42'

const CONFIG = [
  '---',
  'enabled: true',
  'board:',
  '  name: Acme Web',
  `  id: ${BOARD}`,
  'lanes:',
  `  Queue: ${QUEUE_GROUP}`,
  `  In-progress: ${ACTIVE_GROUP}`,
  `  QA: ${QA_GROUP}`,
  `  Complete: ${DONE_GROUP}`,
  'active_lane: In-progress',
  `connector: ${CONNECTOR}`,
  'track:',
  '  - packages/core/src/**',
  '  - scripts/*builder*.mjs',
  '---',
  '',
  'MY OWN BOARD RULES: one transition per call.',
  '- Never move a card to Complete; the orchestrator does that after review.',
].join('\n')

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const identity = (root) => {
  git(root, 'config', 'user.email', 'me@example.com')
  git(root, 'config', 'user.name', 'Me')
  git(root, 'config', 'commit.gpgsign', 'false')
}

function checkout({ config = CONFIG, remote = 'git@github.com:acme/widgets.git' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-acc-'))
  git(root, 'init', '-q', '-b', 'feature/drag')
  identity(root)
  for (const path of ['packages/core/src/a.ts', 'scripts/test-builder.mjs', 'docs/notes.md']) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), `// ${path}\n`)
  }
  if (remote) git(root, 'remote', 'add', 'origin', remote)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  writeFileSync(join(root, '.pm-sync.local.md'), config)
  return root
}

function run(root, mode, payload = {}, { at = T0, env = {} } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, mode], {
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, PM_SYNC_NOW: String(at), CLAUDE_PROJECT_DIR: root, ...env },
  })
  assert.equal(result.status, 0, `${mode} must exit 0: ${result.stderr}`)
  assert.equal(result.stderr, '', `${mode} must not write to stderr: ${result.stderr}`)
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
const blocked = (result) => {
  assert.equal(result.json?.decision, 'block', `expected a block, got ${result.stdout || '(no output)'}`)
  return String(result.json.reason ?? '')
}
const denied = (result) => result.json?.hookSpecificOutput?.permissionDecision === 'deny'

const GROUPS = { Queue: QUEUE_GROUP, 'In-progress': ACTIVE_GROUP, QA: QA_GROUP, Complete: DONE_GROUP }
const write = (status, { id = CARD, name = 'Builder drag and drop', groupId = GROUPS[status], action = 'update_item' } = {}) => ({
  tool_name: `${CONNECTOR}items`,
  tool_input: { action, arguments: { itemId: id, fields: { Status: status } } },
  tool_response: JSON.stringify({ item: { id, boardId: BOARD, groupId, status, untrusted_text: { name } } }),
})
const card = (overrides = {}) => ({
  id: CARD, boardId: BOARD, groupId: ACTIVE_GROUP, status: 'In-progress', updatedAt: '2026-10-05T02:59:00.000Z',
  linked: true, assignedToMe: false, branchMatch: true,
  untrusted_text: { name: 'Builder drag and drop', branches: ['feature/drag'] }, subitems: [], pullRequests: [],
  ...overrides,
})
const repoContext = (items, { args = {}, ...body } = {}) => ({
  tool_name: `${CONNECTOR}items`,
  tool_input: { action: 'repo_context', arguments: { remote: 'git@github.com:acme/widgets.git', ...args } },
  tool_response: JSON.stringify({
    repo: { fullName: 'acme/widgets' }, match: 'linked', cursor: '2026-10-05T02:59:55.000Z', truncated: false, nextPage: null,
    boards: [{ id: BOARD, lanes: [{ id: ACTIVE_GROUP, name: 'In-progress' }] }], items, gone: [], ...body,
  }),
})
const EDIT = { tool_name: 'Edit', tool_input: { file_path: 'packages/core/src/a.ts' } }
const bash = (command, stdout = '', stderr = '') => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr, interrupted: false } })

// ---- A. The finish check -------------------------------------------------------------

test('A1: after Stop blocks once, later turns pass while tracked state is unchanged since that block', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  assert.equal(run(root, 'stop').stdout, '', 'the first Stop adopts')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed after the write\n')
  blocked(run(root, 'stop', {}, { at: T0 + MINUTE }))
  assert.equal(run(root, 'stop', {}, { at: T0 + 5 * MINUTE }).stdout, '', 'the next turn, nothing new: no second block')
  assert.equal(run(root, 'stop', {}, { at: T0 + 9 * MINUTE }).stdout, '')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed again\n')
  blocked(run(root, 'stop', {}, { at: T0 + 10 * MINUTE }))
})

test('A2: the Stop block names the changed tracked files and the commits since the last write', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// edited, not committed\n')
  writeFileSync(join(root, 'scripts/new-builder.mjs'), '// new\n')
  git(root, 'add', 'scripts/new-builder.mjs')
  git(root, 'commit', '-q', '-m', 'Add the new builder')
  writeFileSync(join(root, 'docs/notes.md'), 'untracked by the config\n')
  const reason = blocked(run(root, 'stop', {}, { at: T0 + MINUTE }))
  assert.match(reason, /packages\/core\/src\/a\.ts/)
  assert.match(reason, /Add the new builder/)
  assert.doesNotMatch(reason, /docs\/notes\.md/)
})

test('A2: a long list of changed files is capped', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  for (let index = 0; index < 30; index += 1) writeFileSync(join(root, `packages/core/src/f${index}.ts`), `// ${index}\n`)
  const reason = blocked(run(root, 'stop', {}, { at: T0 + MINUTE }))
  assert.match(reason, /\(\+\d+ more\)/)
  assert.ok((reason.match(/packages\/core\/src\/f\d+\.ts/g) ?? []).length <= 10)
})

// ---- B. The content fingerprint ------------------------------------------------------

test('B: a merge that only moves HEAD neither blocks Stop nor reads as stale work', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  // Someone else's commit, made in another clone and merged in here.
  const theirs = join(mkdtempSync(join(tmpdir(), 'pm-sync-theirs-')), 'clone')
  git(root, 'clone', '-q', root, theirs)
  identity(theirs)
  writeFileSync(join(theirs, 'packages/core/src/a.ts'), '// someone else\n')
  git(theirs, 'commit', '-q', '-am', 'Their change')
  git(root, 'fetch', '-q', theirs, 'feature/drag:other')
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'other')
  assert.equal(run(root, 'post-tool', bash('git merge other'), { at: T0 + 20 * MINUTE }).stdout, '', 'no stale nudge')
  assert.equal(run(root, 'stop', {}, { at: T0 + 21 * MINUTE }).stdout, '', 'no Stop block')
})

test('B: a checkout round trip, a stash round trip, and a formatter that changes nothing do not count as work', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  git(root, 'checkout', '-q', '-b', 'side')
  git(root, 'checkout', '-q', 'feature/drag')
  const file = join(root, 'packages/core/src/a.ts')
  writeFileSync(file, readFileSync(file, 'utf8'))
  utimesSync(file, new Date(T0 + 3600_000), new Date(T0 + 3600_000))
  writeFileSync(file, '// stashed\n')
  git(root, 'stash', '-q')
  git(root, 'stash', 'pop', '-q')
  git(root, 'checkout', '-q', '--', 'packages/core/src/a.ts')
  assert.equal(run(root, 'stop', {}, { at: T0 + MINUTE }).stdout, '')
  assert.equal(run(root, 'post-tool', bash('npx prettier --write .'), { at: T0 + 20 * MINUTE }).stdout, '')
})

test('B: a commit of my own after the last write still blocks Stop, even with a clean tree', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// mine\n')
  git(root, 'commit', '-q', '-am', 'My drag fix')
  assert.match(blocked(run(root, 'stop', {}, { at: T0 + MINUTE })), /My drag fix/)
})

/** A git on PATH that logs every call, so a test can count them. */
function countingGit() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-sync-git-'))
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const log = join(dir, 'calls.log')
  writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`)
  chmodSync(join(dir, 'git'), 0o755)
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
  return { env: { PATH: `${dir}:${process.env.PATH}` }, calls, reset: () => writeFileSync(log, '') }
}

test('B: with no config anywhere up the tree, no git is spawned at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-sync-none-'))
  git(root, 'init', '-q')
  const counter = countingGit()
  for (const mode of ['session-start', 'pre-tool', 'post-tool', 'stop', 'user-prompt']) {
    assert.equal(run(root, mode, bash('npm test'), { env: counter.env }).stdout, '', mode)
  }
  assert.deepEqual(counter.calls(), [])
})

test('B: a read-only Bash command skips the fingerprint; a writing one does not', () => {
  const root = checkout()
  const counter = countingGit()
  run(root, 'post-tool', write('In-progress'), { env: counter.env })
  run(root, 'post-tool', bash('sed -i s/a/b/ x'), { env: counter.env })
  counter.reset()
  for (const command of ['git status', 'rg -n foo packages', 'ls -la', 'cat packages/core/src/a.ts | head -3']) {
    run(root, 'post-tool', bash(command), { env: counter.env })
  }
  const calls = counter.calls()
  assert.ok(calls.every((call) => call.includes('rev-parse')), `read-only commands ran only rev-parse, got ${calls.join(' | ')}`)
  assert.ok(calls.length <= 4, `at most one git call per hook, got ${calls.length}`)
  counter.reset()
  run(root, 'post-tool', bash('sed -i s/a/b/ x'), { env: counter.env })
  assert.ok(counter.calls().some((call) => /\bstatus\b/.test(call)), 'a writing command fingerprints')
})

test('B: a read-only command does not see a change as this call\'s edit', () => {
  const root = checkout()
  run(root, 'post-tool', bash('sed -i s/a/b/ x'))
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// changed elsewhere\n')
  assert.equal(run(root, 'post-tool', bash('cat packages/core/src/a.ts'), { at: T0 + MINUTE }).stdout, '', 'cat changed nothing')
  assert.match(blocked(run(root, 'post-tool', bash('sed -i s/x/y/ packages/core/src/a.ts'), { at: T0 + 2 * MINUTE })), /no Acme Web card/)
})

test('B: the trust check is cached, and checked again when the config or the index changes', () => {
  const root = checkout()
  const counter = countingGit()
  run(root, 'pre-tool', EDIT, { env: counter.env })
  counter.reset()
  run(root, 'pre-tool', EDIT, { env: counter.env })
  assert.equal(counter.calls().filter((call) => call.includes('ls-files')).length, 0, 'the second run uses the cached trust')
  git(root, 'add', '-f', '.pm-sync.local.md')
  assert.match(context(run(root, 'session-start')), /committed to git/)
})

// ---- C. Per-checkout state -----------------------------------------------------------

test('C: two worktrees share the card mirror but keep their own gate, clocks and Stop state', () => {
  const main = checkout()
  const other = join(mkdtempSync(join(tmpdir(), 'pm-sync-wt-')), 'b')
  git(main, 'worktree', 'add', '-q', '-b', 'feature/other', other)
  writeFileSync(join(other, '.pm-sync.local.md'), CONFIG)
  run(main, 'post-tool', write('In-progress'))
  assert.equal(run(main, 'pre-tool', EDIT).stdout, '', 'the writing checkout may edit')
  assert.equal(denied(run(other, 'pre-tool', EDIT)), true, 'a card the other checkout took does not open this gate')
  assert.equal(run(main, 'stop').stdout, '')
  assert.equal(run(other, 'stop').stdout, '')
  writeFileSync(join(other, 'packages/core/src/a.ts'), '// only in b\n')
  assert.equal(run(main, 'stop', {}, { at: T0 + MINUTE }).stdout, '', 'the main checkout did nothing')
  blocked(run(other, 'stop', {}, { at: T0 + MINUTE }))
  const common = join(main, '.git')
  const files = readdirSync(common).filter((name) => name.startsWith('claude-pm-sync-5e1f0c2a'))
  assert.ok(files.includes('claude-pm-sync-5e1f0c2a.json'), 'one shared mirror')
  assert.ok(files.filter((name) => /-wt-[0-9a-f]+\.json$/.test(name)).length >= 2, `one state per checkout, got ${files.join(', ')}`)
  const shared = JSON.parse(readFileSync(join(common, 'claude-pm-sync-5e1f0c2a.json'), 'utf8'))
  assert.ok(shared.items[CARD], 'the card is in the shared mirror')
  assert.equal(shared.lastWriteAt, undefined, 'clocks are per checkout')
})

test('C: an old shared state file is migrated without a spurious block', () => {
  const root = checkout()
  const at = new Date(T0 - 10 * MINUTE).toISOString()
  writeFileSync(join(root, '.git/claude-pm-sync-5e1f0c2a.json'), JSON.stringify({
    items: { [CARD]: { status: 'In-progress', name: 'Old card', groupId: ACTIVE_GROUP, at } },
    activity: [{ at, action: 'update_item', itemId: CARD, name: 'Old card', status: 'In-progress' }],
    lastWriteAt: at, fingerprintAtWrite: 'f'.repeat(64), fingerprint: 'f'.repeat(64), stopFingerprint: 'e'.repeat(64),
    headAtWrite: git(root, 'rev-parse', 'HEAD'),
  }))
  assert.equal(run(root, 'pre-tool', EDIT).stdout, '', 'the card this checkout wrote still opens the gate')
  assert.equal(run(root, 'stop').stdout, '', 'an old-format fingerprint is adopted, not compared')
  assert.equal(run(root, 'post-tool', bash('npm run build'), { at: T0 + 30 * MINUTE }).stdout, '')
  const shared = JSON.parse(readFileSync(join(root, '.git/claude-pm-sync-5e1f0c2a.json'), 'utf8'))
  assert.equal(shared.lastWriteAt, undefined)
  assert.ok(shared.items[CARD])
})

// ---- D. Whose card is active ---------------------------------------------------------

test('D: a card in the active lane opens the gate only for this checkout\'s writes, this branch, or assigned with nothing better', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card({ untrusted_text: { name: 'Theirs', branches: ['someone/else'] }, branchMatch: false })]))
  assert.equal(denied(run(root, 'pre-tool', EDIT)), true, 'a card on another branch is not this session\'s')
  run(root, 'post-tool', repoContext([card({ untrusted_text: { name: 'Mine by branch', branches: ['feature/drag'] } })]))
  assert.equal(run(root, 'pre-tool', EDIT).stdout, '', 'a card linked to this branch is')
  const assigned = checkout()
  run(assigned, 'post-tool', repoContext([card({ untrusted_text: { name: 'Assigned', branches: [] }, branchMatch: false, assignedToMe: true })]))
  assert.equal(run(assigned, 'pre-tool', EDIT).stdout, '', 'assigned to me, with no better signal')
})

test('D: moving a card into the active lane without a branch link asks once to link it', () => {
  const root = checkout()
  const text = context(run(root, 'post-tool', write('In-progress')))
  assert.match(text, /link_item_github/)
  assert.match(text, /feature\/drag/)
  assert.match(text, /acme\/widgets/)
  assert.equal(run(root, 'post-tool', write('In-progress'), { at: T0 + MINUTE }).stdout, '', 'asked once')
  const linked = checkout()
  run(linked, 'post-tool', repoContext([card({ groupId: QUEUE_GROUP, status: 'Queue' })]))
  assert.equal(run(linked, 'post-tool', write('In-progress')).stdout, '', 'already linked to this branch')
})

// ---- E. Lane vs Status ---------------------------------------------------------------

test('E: a write that leaves the lane and the Status disagreeing warns once', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card()]))
  const text = context(run(root, 'post-tool', write('In-progress', { groupId: QA_GROUP })))
  assert.match(text, /lane "QA"/)
  assert.match(text, /Status is "In-progress"/)
  assert.equal(run(root, 'post-tool', write('In-progress', { groupId: QA_GROUP }), { at: T0 + MINUTE }).stdout, '')
  const spelled = checkout({ config: CONFIG.replace('  In-progress:', '  In Progress:').replace('active_lane: In-progress', 'active_lane: In Progress') })
  run(spelled, 'post-tool', repoContext([card()]))
  assert.equal(run(spelled, 'post-tool', write('in-progress', { groupId: ACTIVE_GROUP })).stdout, '', 'case, hyphens and spaces do not count')
})

// ---- F. Git events -------------------------------------------------------------------

test('F: an opened PR asks to move the card to the review lane and link the PR, and Stop holds once until a write', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card()]))
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  const text = context(run(root, 'post-tool', bash('gh pr create --fill', `${PR}\n`), { at: T0 + MINUTE }))
  assert.ok(text.includes(PR), 'names the PR url')
  assert.match(text, /QA/)
  assert.match(text, new RegExp(QA_GROUP))
  assert.match(text, /link_item_github|update_item_github_link/)
  assert.match(text, /pullRequestUrl/)
  assert.match(blocked(run(root, 'stop', {}, { at: T0 + 2 * MINUTE })), /pull\/42/)
  assert.equal(run(root, 'stop', {}, { at: T0 + 3 * MINUTE }).stdout, '', 'once')
  const again = checkout()
  run(again, 'post-tool', repoContext([card()]))
  run(again, 'post-tool', write('In-progress'))
  run(again, 'stop')
  run(again, 'post-tool', bash('gh pr create --fill', `${PR}\n`), { at: T0 + MINUTE })
  run(again, 'post-tool', write('QA'), { at: T0 + 2 * MINUTE })
  assert.equal(run(again, 'stop', {}, { at: T0 + 3 * MINUTE }).stdout, '', 'a board write after the event clears it')
})

test('F: no nag when repo_context already lists the PR on the card, nor for a failed gh call', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card({ pullRequests: [{ url: PR, number: 42 }] })]))
  run(root, 'post-tool', write('In-progress'))
  assert.equal(run(root, 'post-tool', bash('gh pr create --fill', `${PR}\n`), { at: T0 + MINUTE }).stdout, '')
  assert.equal(run(root, 'post-tool', bash('gh pr create --fill', '', 'pull request create failed'), { at: T0 + MINUTE }).stdout, '')
})

test('F: a merged PR asks for the merge to be recorded', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card()]))
  const text = context(run(root, 'post-tool', bash('gh pr merge 42 --squash', 'Squashed and merged pull request acme/widgets#42 (Drag)')))
  assert.match(text, /merged/i)
  assert.match(text, /#42/)
})

// ---- G. Subtasks ---------------------------------------------------------------------

const SUBTASKS = [
  { id: 's1', status: 'Done', untrusted_text: { name: 'Write the tests' } },
  { id: 's2', status: 'Working on it', untrusted_text: { name: 'Wire the API' } },
  { id: 's3', status: null, untrusted_text: { name: 'Document it' } },
]

test('G: the Stop message names the active card\'s open subtasks', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card({ subitems: SUBTASKS })]))
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// more\n')
  const reason = blocked(run(root, 'stop', {}, { at: T0 + MINUTE }))
  assert.match(reason, /Wire the API/)
  assert.match(reason, /Document it/)
  assert.doesNotMatch(reason, /Write the tests/)
})

test('G: moving a card with open subtasks to QA or Complete warns once', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card({ subitems: SUBTASKS })]))
  const text = context(run(root, 'post-tool', write('QA')))
  assert.match(text, /2 open subtasks/)
  assert.match(text, /Wire the API/)
  assert.doesNotMatch(run(root, 'post-tool', write('QA'), { at: T0 + MINUTE }).stdout, /open subtasks/)
})

// ---- H. Freshness --------------------------------------------------------------------

test('H: a card moved out of the active lane by someone else is reported and leaves the active set', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card()]))
  run(root, 'post-tool', write('In-progress'))
  assert.equal(run(root, 'pre-tool', EDIT).stdout, '')
  const text = context(run(root, 'post-tool', repoContext([card({ groupId: QA_GROUP, status: 'QA' })], { args: { since: '2026-10-05T02:59:55.000Z' } }), { at: T0 + 5 * MINUTE }))
  assert.match(text, /Builder drag and drop/)
  assert.match(text, /moved to QA/)
  assert.equal(denied(run(root, 'pre-tool', EDIT, { at: T0 + 6 * MINUTE })), true)
})

test('H: a full call with nextPage asks for the next page, and the cursor is kept only from the last page', () => {
  const root = checkout()
  const first = context(run(root, 'post-tool', repoContext([card()], { truncated: true, nextPage: 'page-2-token', cursor: '2026-10-05T02:59:00.000Z' })))
  assert.match(first, /page "page-2-token"/)
  assert.match(context(run(root, 'session-start', {}, { at: T0 + MINUTE })), /No sync cursor is recorded/)
  run(root, 'post-tool', repoContext([card({ id: 'item-bbbbbbbb' })], { args: { page: 'page-2-token' }, cursor: '2026-10-05T02:59:00.000Z' }), { at: T0 + MINUTE })
  assert.match(context(run(root, 'session-start', {}, { at: T0 + 2 * MINUTE })), /since "2026-10-05T02:59:00\.000Z"/)
})

test('H: an old-server repo_context answer (no nextPage, lanes, pullRequests or subitems) still works', () => {
  const root = checkout()
  const old = {
    tool_name: `${CONNECTOR}items`,
    tool_input: { action: 'repo_context', arguments: { remote: 'git@github.com:acme/widgets.git' } },
    tool_response: JSON.stringify({
      repo: { fullName: 'acme/widgets' }, match: 'linked', cursor: '2026-10-05T02:59:55.000Z', truncated: true,
      boards: [{ id: BOARD, url: 'u', untrusted_text: { name: 'Acme Web' } }],
      items: [{ id: CARD, boardId: BOARD, groupId: ACTIVE_GROUP, status: 'In-progress', linked: true, assignedToMe: false, branchMatch: true,
        untrusted_text: { name: 'Builder drag and drop', branches: ['feature/drag'] } }],
      gone: [],
    }),
  }
  assert.equal(run(root, 'post-tool', old).stdout, '')
  assert.equal(run(root, 'pre-tool', EDIT).stdout, '', 'the branch-linked card is active')
  assert.match(context(run(root, 'session-start', {}, { at: T0 + MINUTE })), /since "2026-10-05T02:59:55\.000Z"/)
})

test('H: UserPromptSubmit asks for a delta repo_context when the view is stale, with a cooldown', () => {
  const root = checkout()
  const first = context(run(root, 'user-prompt', { prompt: 'go' }))
  assert.match(first, /repo_context/)
  assert.equal(run(root, 'user-prompt', { prompt: 'go' }, { at: T0 + 2 * MINUTE }).stdout, '', 'cooldown')
  run(root, 'post-tool', repoContext([card()]), { at: T0 + 3 * MINUTE })
  assert.equal(run(root, 'user-prompt', { prompt: 'go' }, { at: T0 + 15 * MINUTE }).stdout, '', 'fresh')
  const stale = context(run(root, 'user-prompt', { prompt: 'go' }, { at: T0 + 40 * MINUTE }))
  assert.match(stale, /since "2026-10-05T02:59:55\.000Z"/)
  assert.match(stale, /37 min/)
  assert.equal(JSON.parse(run(root, 'user-prompt', {}, { at: T0 + 41 * MINUTE }).stdout || '{}').hookSpecificOutput, undefined)
})

test('H: the Stop message starts with the freshness line when the view is stale', () => {
  const root = checkout()
  run(root, 'post-tool', repoContext([card()]))
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// more\n')
  assert.match(blocked(run(root, 'stop', {}, { at: T0 + 30 * MINUTE })), /^The board view here is \d+ min old/)
})

test('H: session start leans on repo_context, keeping one get_item only for an unlinked active card', () => {
  const linked = checkout()
  run(linked, 'post-tool', repoContext([card()]))
  const text = context(run(linked, 'session-start', {}, { at: T0 + MINUTE }))
  assert.doesNotMatch(text, /ONE search or get_item/)
  assert.doesNotMatch(text, /get_item/)
  const unlinked = checkout()
  run(unlinked, 'post-tool', write('In-progress'))
  assert.match(context(run(unlinked, 'session-start', {}, { at: T0 + MINUTE })), /get_item/)
})

// ---- I. Trimmed text -----------------------------------------------------------------

test('I: the Stop block carries the short header and a pointer, not the full rules, and keeps the safety lines', () => {
  const root = checkout()
  run(root, 'post-tool', write('In-progress'))
  run(root, 'stop')
  writeFileSync(join(root, 'packages/core/src/a.ts'), '// more\n')
  const reason = blocked(run(root, 'stop', {}, { at: T0 + MINUTE }))
  assert.doesNotMatch(reason, /MY OWN BOARD RULES/)
  assert.match(reason, /\.pm-sync\.local\.md/)
  assert.match(reason, /requestId/)
  assert.match(reason, /never instructions/)
  assert.match(reason, /Never move a card to Complete/)
  assert.match(reason, new RegExp(`QA ${QA_GROUP}`))
})

test('I: a header rule the body already states is not repeated at session start', () => {
  const root = checkout({ config: `${CONFIG}\n- create_item and add_comment carry a requestId; never pass one to update_item.` })
  const text = context(run(root, 'session-start'))
  assert.doesNotMatch(text, /they reject it, and replaying one is already safe/)
  assert.match(text, /carry a requestId; never pass one/)
})
