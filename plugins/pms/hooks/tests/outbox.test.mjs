import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearWrite, OUTBOX_LIMIT, OUTBOX_RELATIVE, queueWrite, readOutbox } from '../lib/outbox.mjs'

const root = () => mkdtempSync(join(tmpdir(), 'pm-sync-outbox-'))
const write = (n, requestId = `req-${n}`) => ({
  at: `2026-10-05T03:${String(n % 60).padStart(2, '0')}:00.000Z`,
  tool: 'mcp__pm__items',
  arguments: { action: 'update_item', arguments: { itemId: `item-${n}`, fields: { Status: 'QA' }, requestId } },
  requestId,
})

test('an empty or missing outbox reads as no entries', () => {
  assert.deepEqual(readOutbox(root()), [])
})

test('queueWrite appends one JSON line per failed write under .pm-sync/', () => {
  const dir = root()
  queueWrite(dir, write(1))
  queueWrite(dir, write(2))
  const lines = readFileSync(join(dir, OUTBOX_RELATIVE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), write(1))
  assert.deepEqual(readOutbox(dir).map((entry) => entry.requestId), ['req-1', 'req-2'])
})

test('the same write queued twice is kept once', () => {
  const dir = root()
  queueWrite(dir, write(1))
  queueWrite(dir, write(1))
  queueWrite(dir, { ...write(1), requestId: null, arguments: { ...write(1).arguments } })
  assert.equal(readOutbox(dir).length, 1)
})

test('corrupt lines are skipped, never fatal, and dropped on the next rewrite', () => {
  const dir = root()
  mkdirSync(join(dir, '.pm-sync'), { recursive: true })
  writeFileSync(join(dir, OUTBOX_RELATIVE), `${JSON.stringify(write(1))}\n{not json\n42\n"str"\n\n${JSON.stringify(write(2))}\n`)
  assert.deepEqual(readOutbox(dir).map((entry) => entry.requestId), ['req-1', 'req-2'])
  queueWrite(dir, write(3))
  assert.equal(readFileSync(join(dir, OUTBOX_RELATIVE), 'utf8').includes('not json'), false)
  assert.equal(readOutbox(dir).length, 3)
})

test('the outbox is capped: the oldest entries go, and the count dropped is returned', () => {
  const dir = root()
  let dropped = 0
  for (let n = 0; n < OUTBOX_LIMIT + 3; n += 1) dropped += queueWrite(dir, write(n)).dropped
  const entries = readOutbox(dir)
  assert.equal(OUTBOX_LIMIT, 50)
  assert.equal(entries.length, OUTBOX_LIMIT)
  assert.equal(dropped, 3)
  assert.equal(entries[0].requestId, 'req-3', 'the oldest three were dropped')
  assert.equal(entries.at(-1).requestId, `req-${OUTBOX_LIMIT + 2}`)
})

test('clearWrite removes the entry a successful replay matches by requestId', () => {
  const dir = root()
  queueWrite(dir, write(1))
  queueWrite(dir, write(2))
  assert.equal(clearWrite(dir, { tool: 'mcp__pm__items', arguments: { anything: true }, requestId: 'req-1' }), 1)
  assert.deepEqual(readOutbox(dir).map((entry) => entry.requestId), ['req-2'])
})

test('clearWrite also matches the same tool and arguments when no requestId was sent', () => {
  const dir = root()
  const entry = { ...write(1), requestId: null }
  entry.arguments = { action: 'update_item', arguments: { itemId: 'item-1', fields: { Status: 'QA' } } }
  queueWrite(dir, entry)
  assert.equal(clearWrite(dir, { tool: 'mcp__pm__items', arguments: { action: 'update_item', arguments: { itemId: 'item-1', fields: { Status: 'Complete' } } }, requestId: null }), 0,
    'different arguments are a different write')
  assert.equal(clearWrite(dir, { tool: 'mcp__pm__items', arguments: { arguments: { fields: { Status: 'QA' }, itemId: 'item-1' }, action: 'update_item' }, requestId: null }), 1,
    'key order does not matter')
  assert.deepEqual(readOutbox(dir), [])
})

test('a retry that succeeded under a NEW requestId still clears the queued copy, so it is never replayed twice', () => {
  const dir = root()
  queueWrite(dir, write(1))
  const retry = write(1, 'req-retry')
  assert.equal(clearWrite(dir, { tool: retry.tool, arguments: retry.arguments, requestId: 'req-retry' }), 1)
  assert.deepEqual(readOutbox(dir), [])
})

test('clearWrite on an empty outbox is a no-op that creates nothing', () => {
  const dir = root()
  assert.equal(clearWrite(dir, { tool: 't', arguments: {}, requestId: 'r' }), 0)
  assert.equal(existsSync(join(dir, '.pm-sync')), false)
})

test('an unwritable root never throws', () => {
  assert.doesNotThrow(() => queueWrite('/dev/null/nope', write(1)))
  assert.deepEqual(readOutbox('/dev/null/nope'), [])
})
