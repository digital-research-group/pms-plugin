// The outbox: board writes that failed, kept so they can be replayed after a disconnect.
//
// One JSON line per write in .pm-sync/outbox.jsonl under the repo root: { at, tool,
// arguments, requestId }. The server de-duplicates writes by (connection, requestId), so
// replaying with the ORIGINAL requestId is a no-op when the first attempt really landed.
// A corrupt line is skipped, never fatal, and the file is capped so a long outage cannot
// grow it without bound.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const OUTBOX_RELATIVE = '.pm-sync/outbox.jsonl'
export const OUTBOX_LIMIT = 50

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Key-sorted JSON with every requestId removed: the same write compares equal across retries. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!isMap(value)) return JSON.stringify(value ?? null)
  return `{${Object.keys(value).filter((key) => key !== 'requestId').sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/**
 * Same requestId, or the same tool with the same arguments. A retry that succeeded under a
 * fresh requestId must still clear the queued copy, or a later replay would apply it twice.
 */
export function sameWrite(left, right) {
  if (left.requestId && right.requestId && left.requestId === right.requestId) return true
  return left.tool === right.tool && canonical(left.arguments) === canonical(right.arguments)
}

export function readOutbox(root) {
  let text
  try { text = readFileSync(join(root, OUTBOX_RELATIVE), 'utf8') } catch { return [] }
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (isMap(value) && typeof value.tool === 'string') entries.push(value)
    } catch { /* A torn or hand-edited line is dropped, never fatal. */ }
  }
  return entries
}

function writeOutbox(root, entries) {
  const file = join(root, OUTBOX_RELATIVE)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
    renameSync(temp, file)
  } catch { /* Best effort: a hook never fails the tool call. */ }
}

/** Queue a failed write once. Returns how many of the oldest entries the cap dropped. */
export function queueWrite(root, entry) {
  const entries = readOutbox(root)
  if (!entries.some((queued) => sameWrite(queued, entry))) entries.push(entry)
  const dropped = Math.max(0, entries.length - OUTBOX_LIMIT)
  writeOutbox(root, entries.slice(dropped))
  return { dropped }
}

/** A write that succeeded clears the queued copy it matches. Returns how many were removed. */
export function clearWrite(root, write) {
  const entries = readOutbox(root)
  if (entries.length === 0) return 0
  const kept = entries.filter((queued) => !sameWrite(queued, write))
  if (kept.length !== entries.length) writeOutbox(root, kept)
  return entries.length - kept.length
}
