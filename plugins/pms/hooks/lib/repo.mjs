// Local git facts, read as cheaply as a hook can: one rev-parse per run, and the rest
// from the files git keeps (HEAD, refs, the HEAD reflog, config) wherever they can be
// read directly. A hook runs on every tool call, and each git spawn costs more than
// everything else it does.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { matchesAny } from './glob.mjs'

export const GIT_TIMEOUT_MS = 1000
const SHA40 = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const REFLOG_TAIL_BYTES = 256 * 1024
const COMMITS_MAX = 50
const TRUST = new Set(['personal', 'committed'])

export function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, maxBuffer: 32 << 20 })
}

/** One line of local git output, or '' on any failure: no git, no repo, no commits, too slow. */
export function gitLine(cwd, args) {
  try { return gitText(cwd, args).trim() } catch { return '' }
}

/**
 * Whether any of `names` exists in `cwd` or a parent, up to the first folder holding .git.
 * It lets a repository with no config stay silent without spawning git at all.
 */
export function configNearby(cwd, names) {
  let dir = resolve(cwd)
  for (;;) {
    if (names.some((name) => existsSync(join(dir, name)))) return true
    if (existsSync(join(dir, '.git'))) return false
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** { root, gitDir, commonDir } from one rev-parse; outside git (or with no git) only root, as the cwd. */
export function repoInfo(cwd) {
  try {
    const [root, gitDir, commonDir] = gitText(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
      .split('\n').map((line) => line.trim())
    if (root && gitDir && commonDir) return { root, gitDir, commonDir }
  } catch { /* Not a work tree, or no git. */ }
  return { root: cwd, gitDir: null, commonDir: null }
}

/** A short stable key for a checkout: the hash of its resolved root. */
export function rootKey(root) {
  let path = root
  try { path = realpathSync(root) } catch { /* Gone: the spelling will do. */ }
  return createHash('sha256').update(path).digest('hex').slice(0, 12)
}

/** { sha, branch } of HEAD, read from git's files; git is asked only for a reftable or an unusual layout. */
export function readHead(repo) {
  if (!repo.gitDir) return { sha: null, branch: null }
  const asked = (branch) => ({ sha: gitLine(repo.root, ['rev-parse', '--verify', '-q', 'HEAD']) || null, branch })
  let text
  try { text = readFileSync(join(repo.gitDir, 'HEAD'), 'utf8').trim() } catch { return asked(null) }
  if (SHA40.test(text)) return { sha: text, branch: null }
  const ref = /^ref: (refs\/\S+)$/.exec(text)?.[1]
  if (!ref) return asked(null)
  // A reftable repository keeps a placeholder here: the real branch is only known to git.
  if (ref === 'refs/heads/.invalid') return asked(gitLine(repo.root, ['symbolic-ref', '-q', '--short', 'HEAD']) || null)
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
  for (const dir of [repo.gitDir, repo.commonDir]) {
    try {
      const sha = readFileSync(join(dir, ref), 'utf8').trim()
      if (SHA40.test(sha)) return { sha, branch }
    } catch { /* Not a loose ref here. */ }
  }
  try {
    for (const line of readFileSync(join(repo.commonDir, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.split(' ')
      if (name === ref && SHA40.test(sha)) return { sha, branch }
    }
  } catch { /* No packed refs. */ }
  // An unborn branch has no commit yet; anything else is git's to answer.
  return asked(branch)
}

function readTail(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally { closeSync(fd) }
}

/**
 * Commits made IN THIS CHECKOUT since HEAD was at `base`, oldest first: the HEAD reflog's
 * "commit" entries after the last time it reached `base`. A merge, pull, rebase, checkout
 * or reset moves HEAD without one, so other people's work never counts. With `patterns`,
 * only commits touching a tracked path are kept (one git call, and only when there are any).
 */
export function ownCommits(repo, base, patterns = null) {
  if (!repo.gitDir || typeof base !== 'string' || !SHA40.test(base)) return []
  let lines
  try { lines = readTail(join(repo.gitDir, 'logs/HEAD'), REFLOG_TAIL_BYTES).split('\n') } catch { return [] }
  let start = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].split(' ')[1] === base) { start = index; break }
  }
  if (start === -1) return []
  const commits = []
  for (const line of lines.slice(start + 1)) {
    const tab = line.indexOf('\t')
    const sha = line.split(' ')[1]
    const message = /^commit(?: \((?:initial|amend)\))?: (.*)$/.exec(tab === -1 ? '' : line.slice(tab + 1))
    if (message && SHA40.test(sha ?? '')) commits.push({ sha, subject: message[1] })
  }
  if (!patterns || commits.length === 0) return commits
  let out
  try {
    out = gitText(repo.root, ['log', '--no-walk=unsorted', '-z', '--name-only', '--format=%x01%H', ...commits.slice(-COMMITS_MAX).map((commit) => commit.sha)])
  } catch { return [] }
  const touching = new Set()
  for (const chunk of out.split('\u0001')) {
    const [sha, ...names] = chunk.split('\0').map((part) => part.trim())
    if (sha && names.some((name) => name && matchesAny(patterns, name))) touching.add(sha)
  }
  return commits.filter((commit) => touching.has(commit.sha))
}

/** The origin remote's URL from the repository config, falling back to git for anything unusual. */
export function originUrl(repo) {
  if (!repo.commonDir) return ''
  try {
    const text = readFileSync(join(repo.commonDir, 'config'), 'utf8')
    // insteadOf rewrites and includes are git's to apply.
    if (!/insteadof|\[include/i.test(text)) {
      let inOrigin = false
      for (const line of text.split('\n')) {
        const section = /^\s*\[(.+)\]\s*$/.exec(line)
        if (section) { inOrigin = /^remote\s+"origin"$/.test(section[1].trim()); continue }
        const url = inOrigin && /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
        if (url) return url[1]
      }
      return ''
    }
  } catch { /* Fall through to git. */ }
  return gitLine(repo.root, ['remote', 'get-url', 'origin'])
}

const statKey = (path) => {
  try { const stats = statSync(path); return `${stats.mtimeMs}:${stats.ino}:${stats.size}` } catch { return 'none' }
}

/**
 * The trust verdict for a config, cached beside the state and re-checked whenever the
 * config file or this checkout's index changes (an edit, a git add, a git rm --cached).
 * 'unchecked' is never cached: git could not say, so it is asked again next time.
 */
export function cachedTrust(repo, path, check) {
  if (!repo.commonDir) return 'unchecked'
  const key = `${statKey(path)}|${statKey(join(repo.gitDir, 'index'))}`
  const file = join(repo.commonDir, `claude-pm-sync-trust-${rootKey(repo.root)}.json`)
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'))
    if (cached?.path === path && cached?.key === key && TRUST.has(cached?.trust)) return cached.trust
  } catch { /* No cache yet. */ }
  const trust = check()
  if (TRUST.has(trust)) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify({ path, key, trust }))
      renameSync(temp, file)
    } catch { /* Best effort: the check simply runs again. */ }
  }
  return trust
}
