// What a shell command did, read from its text and its output: whether it can only have
// read (so the tracked-file fingerprint can be skipped), and which git or GitHub step it
// completed (a commit, a push, a PR opened, marked ready or merged).
//
// Both answers err on the safe side. A command that might write is not read-only, and a
// step counts only when its output says it succeeded.

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Commands that read and print, and nothing else, as long as no flag below turns them into writers.
const READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep', 'pwd', 'cd', 'echo', 'which', 'file', 'stat', 'du',
  'df', 'tree', 'find', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'nl', 'uniq', 'cut', 'tr', 'sort', 'true',
])
const WRITING_FLAGS = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
  sort: /^(-o|--output)/,
  rg: /^--pre/,
}
const GIT_READERS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'shortlog', 'describe', 'rev-list', 'cat-file', 'ls-tree'])
// Output thrown away is not a write; every other redirection is.
const NULL_REDIRECT = /\s(?:[12]?>>?\s*\/dev\/null|2>&1)(?=\s|$)/g

const segments = (command) => command.split(/&&|\|\||[;|\n\r]/).map((part) => part.trim().split(/\s+/).filter(Boolean))

function readOnlySegment(words) {
  const [name, ...args] = words
  if (name === 'git') {
    let at = 0
    while (args[at] === '--no-pager' || args[at] === '-P' || args[at] === '-C') at += args[at] === '-C' ? 2 : 1
    return GIT_READERS.has(args[at]) && !args.some((arg) => arg.startsWith('--output'))
  }
  return READERS.has(name) && !args.some((arg) => WRITING_FLAGS[name]?.test(arg))
}

/** True only for a command on the allowlist with no redirection, substitution or chained writer. */
export function isReadOnlyCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  const text = ` ${command}`.replace(NULL_REDIRECT, ' ')
  if (/[`<>]|\$\(/.test(text) || /(^|[^&])&([^&]|$)/.test(text)) return false
  const parts = segments(text)
  return parts.every((words) => words.length > 0 && readOnlySegment(words))
}

/** Every string a shell tool response carries, whichever client shaped it. */
function responseText(response, depth = 0) {
  if (typeof response === 'string') return response
  if (depth > 3) return ''
  if (Array.isArray(response)) return response.map((part) => responseText(part, depth + 1)).join('\n')
  if (!isMap(response)) return ''
  return ['stdout', 'stderr', 'output', 'text', 'content', 'result'].map((key) => responseText(response[key], depth + 1)).join('\n')
}

const PR_URL = /https:\/\/[^\s"'<>()]+\/pull\/(\d+)(?![\w/])/
const has = (parts, ...prefix) => parts.some((words) => prefix.every((word, index) => words[index] === word))

/**
 * The git or GitHub step a command completed, or null: { kind: 'pr-open', url }, { kind:
 * 'pr-merge' | 'pr-ready', number, url? }, { kind: 'push' } or { kind: 'commit' }.
 */
export function gitEvent(command, response) {
  if (typeof command !== 'string' || command.trim() === '') return null
  const parts = segments(command)
  const text = responseText(response)
  const failed = /\b(error|fatal|failed|rejected|could not|not mergeable)\b/i.test(text)
  if (has(parts, 'gh', 'pr', 'create')) {
    const url = PR_URL.exec(text)?.[0]
    if (url) return { kind: 'pr-open', url }
  }
  const number = Number(/#(\d+)\b/.exec(text)?.[1])
  const withNumber = (kind) => {
    const url = PR_URL.exec(command)?.[0] ?? PR_URL.exec(text)?.[0]
    return { kind, number: Number.isInteger(number) ? number : Number(PR_URL.exec(url ?? '')?.[1]) || null, ...(url ? { url } : {}) }
  }
  if (has(parts, 'gh', 'pr', 'merge') && /\b(merged pull request|was already merged)\b/i.test(text) && !failed) return withNumber('pr-merge')
  if (has(parts, 'gh', 'pr', 'ready') && /ready for review/i.test(text) && !failed) return withNumber('pr-ready')
  if (has(parts, 'git', 'push') && /\S\s+->\s+\S/.test(text) && !failed) return { kind: 'push' }
  if (has(parts, 'git', 'commit') && /^\[[^\]\s]+(?: \([^)]*\))? [0-9a-f]{7,40}\]/m.test(text)) return { kind: 'commit' }
  return null
}
