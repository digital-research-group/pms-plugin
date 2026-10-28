// Repo-relative glob matching for the `track:` list, with no dependencies.
//
// The supported syntax is the small set a tracked-file list needs:
//   **       crosses path separators ("**/" is zero or more directories)
//   *        any run of characters inside one segment
//   ?        one character inside one segment
//   trailing /   a directory prefix, i.e. everything under it
// Paths and patterns are repo-relative, forward-slashed and case-sensitive.
import { relative, resolve } from 'node:path'

const cache = new Map()

/** Leading `./` and `/` carry no meaning in a repo-relative path. */
function normalize(value) {
  let text = String(value).replace(/\\/g, '/')
  while (text.startsWith('./')) text = text.slice(2)
  while (text.startsWith('/')) text = text.slice(1)
  return text
}

function compile(pattern) {
  let source = normalize(pattern)
  if (source.endsWith('/')) source += '**'
  let out = '^'
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (char === '*' && source[index + 1] === '*') {
      if (source[index + 2] === '/') { out += '(?:.*/)?'; index += 3; continue }
      out += '.*'; index += 2; continue
    }
    if (char === '*') { out += '[^/]*'; index += 1; continue }
    if (char === '?') { out += '[^/]'; index += 1; continue }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&'); index += 1
  }
  return new RegExp(`${out}$`)
}

function regexFor(pattern) {
  let compiled = cache.get(pattern)
  if (!compiled) { compiled = compile(pattern); cache.set(pattern, compiled) }
  return compiled
}

/** The literal directory a pattern starts with, so a fallback walk can skip the rest of the tree. */
export function globPrefix(pattern) {
  const source = normalize(pattern)
  const wildcard = source.search(/[*?]/)
  const literal = wildcard === -1 ? source : source.slice(0, wildcard)
  const slash = literal.lastIndexOf('/')
  return slash === -1 ? '' : literal.slice(0, slash)
}

export function matchGlob(pattern, path) {
  if (typeof pattern !== 'string' || !pattern || typeof path !== 'string' || !path) return false
  return regexFor(pattern).test(normalize(path))
}

export function matchesAny(patterns, path) {
  if (!Array.isArray(patterns)) return false
  return patterns.some((pattern) => matchGlob(pattern, path))
}

/** A tool's path as a repo-relative path, or null when it is not a path inside the repo. */
export function repoRelative(root, path) {
  if (typeof path !== 'string' || !path) return null
  const rel = relative(root, resolve(root, path)).replace(/\\/g, '/')
  if (!rel || rel === '..' || rel.startsWith('../')) return null
  return rel
}
