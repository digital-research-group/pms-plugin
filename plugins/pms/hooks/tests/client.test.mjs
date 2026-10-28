import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blockOutput, contextOutput, denyOutput, detectClient, looksFailed, normalizeInput, patchPaths,
} from '../lib/client.mjs'

const PATCH = [
  '*** Begin Patch',
  '*** Add File: packages/core/src/new.ts',
  '+export const x = 1',
  '*** Update File: scripts/old-builder.mjs',
  '*** Move to: scripts/new-builder.mjs',
  '@@',
  '-a',
  '+b',
  '*** Delete File: docs/gone.md',
  '*** End Patch',
].join('\n')

test('the --client flag wins over the payload shape', () => {
  assert.equal(detectClient(['--client', 'codex'], { hookEventName: 'PreToolUse' }), 'codex')
  assert.equal(detectClient(['--client', 'grok'], { tool_name: 'Edit' }), 'grok')
  assert.equal(detectClient(['--client', 'claude-code'], { tool_name: 'apply_patch' }), 'claude-code')
})

test('an unknown --client value falls back to detection rather than failing', () => {
  assert.equal(detectClient(['--client', 'emacs'], { tool_name: 'Edit' }), 'claude-code')
  assert.equal(detectClient(['--client'], { toolName: 'Edit' }), 'grok')
})

test('the payload shape picks the client when no flag is given', () => {
  assert.equal(detectClient([], { hookEventName: 'PreToolUse', toolName: 'Edit' }), 'grok')
  assert.equal(detectClient([], { toolInput: {} }), 'grok')
  assert.equal(detectClient([], { tool_name: 'apply_patch', tool_input: { command: PATCH } }), 'codex')
  assert.equal(detectClient([], { hook_event_name: 'Stop', turn_id: 't1' }), 'codex')
  assert.equal(detectClient([], { hook_event_name: 'PreToolUse', tool_name: 'Edit' }), 'claude-code')
  assert.equal(detectClient([], {}), 'claude-code')
})

test('patchPaths reads every add, update, delete and move target, in order and once each', () => {
  assert.deepEqual(patchPaths(PATCH), [
    'packages/core/src/new.ts', 'scripts/old-builder.mjs', 'scripts/new-builder.mjs', 'docs/gone.md',
  ])
})

test('patchPaths copes with Windows CRLF patch text and trailing spaces', () => {
  const crlf = `${PATCH.split('\n').join('\r\n')}\r\n`
  assert.deepEqual(patchPaths(crlf), patchPaths(PATCH))
  assert.deepEqual(patchPaths('*** Update File: a b.ts  \r\n'), ['a b.ts'])
})

test('patchPaths ignores text that is not a patch', () => {
  assert.deepEqual(patchPaths(''), [])
  assert.deepEqual(patchPaths(undefined), [])
  assert.deepEqual(patchPaths({ not: 'text' }), [])
  assert.deepEqual(patchPaths('+*** Add File: inside/a/hunk.ts\n'), [], 'a hunk line that quotes a header is not a header')
})

test('a Claude payload normalises to the same fields it always had', () => {
  const input = normalizeInput({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' },
    tool_response: { ok: true }, stop_hook_active: false, cwd: '/r', source: 'compact',
  }, 'claude-code')
  assert.equal(input.event, 'PostToolUse')
  assert.equal(input.toolName, 'Edit')
  assert.deepEqual(input.toolInput, { file_path: '/r/a.ts' })
  assert.deepEqual(input.toolResponse, { ok: true })
  assert.equal(input.cwd, '/r')
  assert.equal(input.source, 'compact')
  assert.equal(input.isEdit, true)
  assert.deepEqual(input.editPaths, ['/r/a.ts'])
  const notebook = normalizeInput({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }, 'claude-code')
  assert.deepEqual(notebook.editPaths, ['n.ipynb'])
  assert.equal(normalizeInput({ tool_name: 'Read', tool_input: { file_path: 'a' } }, 'claude-code').isEdit, false)
})

test('a Codex apply_patch payload is an edit of every path in the patch', () => {
  const input = normalizeInput({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: PATCH }, cwd: '/r' }, 'codex')
  assert.equal(input.isEdit, true)
  assert.equal(input.editPaths.length, 4)
  const bare = normalizeInput({ tool_name: 'apply_patch', tool_input: PATCH }, 'codex')
  assert.equal(bare.editPaths.length, 4, 'a patch passed as the whole tool_input string is read too')
})

test('a Grok camelCase payload normalises, and missing fields become safe defaults', () => {
  const input = normalizeInput({
    hookEventName: 'PreToolUse', toolName: 'Edit', toolInput: { file_path: 'a.ts' }, workspaceRoot: '/w',
  }, 'grok')
  assert.equal(input.event, 'PreToolUse')
  assert.equal(input.toolName, 'Edit')
  assert.equal(input.cwd, '/w', 'workspaceRoot stands in when cwd is absent')
  assert.deepEqual(input.editPaths, ['a.ts'])
  const empty = normalizeInput({ hookEventName: 'Stop' }, 'grok')
  assert.equal(empty.toolName, '')
  assert.deepEqual(empty.toolInput, {})
  assert.equal(empty.toolResponse, undefined)
  assert.equal(empty.stopHookActive, false)
  assert.equal(empty.cwd, '')
  assert.deepEqual(empty.editPaths, [])
  const camelPath = normalizeInput({ toolName: 'Write', toolInput: { filePath: 'b.ts' } }, 'grok')
  assert.deepEqual(camelPath.editPaths, ['b.ts'])
})

test('a non-object payload normalises to an empty one', () => {
  for (const raw of [null, 42, 'text', [1, 2]]) {
    const input = normalizeInput(raw, 'claude-code')
    assert.equal(input.toolName, '')
    assert.deepEqual(input.editPaths, [])
  }
})

test('looksFailed spots an error-shaped tool response and nothing else', () => {
  assert.equal(looksFailed({ isError: true, content: [{ type: 'text', text: 'boom' }] }), true)
  assert.equal(looksFailed({ is_error: true }), true)
  assert.equal(looksFailed({ error: 'Item not found' }), true)
  assert.equal(looksFailed({ error: { code: 'TIMEOUT' } }), true)
  assert.equal(looksFailed({ Err: 'connection reset' }), true)
  assert.equal(looksFailed(JSON.stringify({ error: 'x' })), true)
  assert.equal(looksFailed({ isError: false, content: [] }), false)
  assert.equal(looksFailed({ error: null, item: {} }), false)
  assert.equal(looksFailed('{"item":{"id":"a"}}'), false)
  assert.equal(looksFailed('not json'), false)
  assert.equal(looksFailed(undefined), false)
})

test('outputs: Claude and Codex share the JSON shapes, Grok only ever denies', () => {
  assert.deepEqual(contextOutput('claude-code', 'SessionStart', 'hi'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } })
  assert.deepEqual(contextOutput('codex', 'SessionStart', 'hi'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } })
  assert.equal(contextOutput('grok', 'SessionStart', 'hi'), null)
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }
  assert.deepEqual(denyOutput('claude-code', 'no'), deny)
  assert.deepEqual(denyOutput('codex', 'no'), deny)
  assert.deepEqual(denyOutput('grok', 'no'), { decision: 'deny', reason: 'no' })
  assert.deepEqual(blockOutput('claude-code', 'Stop', 'r'), { decision: 'block', reason: 'r' })
  assert.deepEqual(blockOutput('claude-code', 'PostToolUse', 'r'), { decision: 'block', reason: 'r' })
  assert.deepEqual(blockOutput('codex', 'Stop', 'r'), { decision: 'block', reason: 'r' })
  // A Codex PostToolUse block replaces the tool result, which would hide a test run's output.
  assert.deepEqual(blockOutput('codex', 'PostToolUse', 'r'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'r' } })
  assert.equal(blockOutput('grok', 'Stop', 'r'), null)
  assert.equal(blockOutput('grok', 'PostToolUse', 'r'), null)
})
