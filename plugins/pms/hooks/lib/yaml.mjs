// The small YAML subset the pm-sync config frontmatter is allowed to use, parsed here
// so the hooks stay dependency-free.
//
// Supported: `key: value`, maps nested by two-space indentation, lists of scalars
// (`- item`), `#` comments at line start or after whitespace outside quotes, and the
// scalars 'single' (with '' for a literal quote), "double" (JSON escapes), true,
// false, integers and decimals; anything else is a plain string.
//
// Everything else real YAML offers (tabs, flow maps and sequences, anchors and
// aliases, multi-line scalars, duplicate keys) is REFUSED, naming the line, rather
// than guessed at: a config is read by hooks that must never act on a misreading.
export class YamlError extends Error {
  constructor(message, line) { super(`line ${line}: ${message}`); this.name = 'YamlError'; this.line = line }
}

/** The line without its comment. Quote state is tracked so a `#` inside quotes survives. */
function stripComment(raw) {
  let single = false
  let double = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (single) {
      if (char === "'") { if (raw[index + 1] === "'") index += 1; else single = false }
      continue
    }
    if (double) {
      if (char === '\\') { index += 1; continue }
      if (char === '"') double = false
      continue
    }
    if (char === "'") { single = true; continue }
    if (char === '"') { double = true; continue }
    if (char === '#' && (index === 0 || raw[index - 1] === ' ')) return raw.slice(0, index)
  }
  return raw
}

/** Index of the `:` that separates a key from its value: outside quotes, and followed by whitespace or nothing. */
function separatorColon(text) {
  let single = false
  let double = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (single) {
      if (char === "'") { if (text[index + 1] === "'") index += 1; else single = false }
      continue
    }
    if (double) {
      if (char === '\\') { index += 1; continue }
      if (char === '"') double = false
      continue
    }
    if (char === "'") { single = true; continue }
    if (char === '"') { double = true; continue }
    if (char === ':' && (index + 1 === text.length || text[index + 1] === ' ')) return index
  }
  return -1
}

function unquoteKey(text, line) {
  if (text.startsWith("'") || text.startsWith('"')) return String(scalar(text, line))
  if (/[[\]{}&*]/.test(text[0] ?? '')) throw new YamlError(`"${text}" is not a plain key; quote it`, line)
  return text
}

function singleQuoted(text, line) {
  let out = ''
  let index = 1
  for (;;) {
    if (index >= text.length) throw new YamlError('unterminated single-quoted string', line)
    const char = text[index]
    if (char === "'") {
      if (text[index + 1] === "'") { out += "'"; index += 2; continue }
      index += 1
      break
    }
    out += char
    index += 1
  }
  if (text.slice(index).trim() !== '') throw new YamlError('unexpected text after a quoted value', line)
  return out
}

function doubleQuoted(text, line) {
  let index = 1
  for (;;) {
    if (index >= text.length) throw new YamlError('unterminated double-quoted string', line)
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === '"') { index += 1; break }
    index += 1
  }
  const token = text.slice(0, index)
  if (text.slice(index).trim() !== '') throw new YamlError('unexpected text after a quoted value', line)
  try { return JSON.parse(token) } catch { throw new YamlError('invalid escape in a double-quoted string', line) }
}

function scalar(text, line) {
  const first = text[0]
  if (first === '[' || first === '{') throw new YamlError('flow sequences and flow maps are not supported; use an indented block', line)
  if (first === '&' || first === '*') throw new YamlError('anchors and aliases are not supported', line)
  if (first === '|' || first === '>') throw new YamlError('multi-line scalars are not supported; put long text in the body below the frontmatter', line)
  if (first === "'") return singleQuoted(text, line)
  if (first === '"') return doubleQuoted(text, line)
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text) || /^-?\d+\.\d+$/.test(text)) return Number(text)
  return text
}

function tokenize(text) {
  const tokens = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, '')
    const line = index + 1
    if (raw.includes('\t')) throw new YamlError('tabs are not allowed; use two spaces per level (write \\t inside a double-quoted string)', line)
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    const indent = stripped.length - stripped.trimStart().length
    if (indent % 2 !== 0) throw new YamlError('indentation must be a multiple of two spaces', line)
    const content = stripped.trim()
    // Scalars are parsed here, not in the build pass, so an unsupported construct is
    // always reported at the first line that carries one.
    if (content === '-' || content.startsWith('- ')) {
      const value = content.slice(1).trim()
      if (value === '' || separatorColon(value) !== -1) {
        throw new YamlError('a list entry must be a scalar; maps and nested lists inside a list are not supported', line)
      }
      tokens.push({ kind: 'item', indent, scalar: scalar(value, line), line })
      continue
    }
    const colon = separatorColon(content)
    if (colon === -1) throw new YamlError('expected "key: value" or "- item"', line)
    const key = content.slice(0, colon).trim()
    if (key === '') throw new YamlError('a key is required before ":"', line)
    const value = content.slice(colon + 1).trim()
    tokens.push({ kind: 'map', indent, key: unquoteKey(key, line), empty: value === '', scalar: value === '' ? null : scalar(value, line), line })
  }
  return tokens
}

function buildList(tokens, cursor, indent) {
  const list = []
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]
    if (token.indent < indent) break
    if (token.indent > indent) throw new YamlError('unexpected indentation', token.line)
    if (token.kind !== 'item') break
    list.push(token.scalar)
    cursor.index += 1
  }
  return list
}

function buildMap(tokens, cursor, indent) {
  const map = {}
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]
    if (token.indent < indent) break
    if (token.indent > indent) throw new YamlError('unexpected indentation', token.line)
    if (token.kind !== 'map') throw new YamlError('a list cannot sit here; this block must be a map of keys', token.line)
    if (Object.prototype.hasOwnProperty.call(map, token.key)) throw new YamlError(`duplicate key "${token.key}"`, token.line)
    cursor.index += 1
    if (!token.empty) { map[token.key] = token.scalar; continue }
    const next = tokens[cursor.index]
    if (!next || next.indent <= indent) { map[token.key] = null; continue }
    if (next.indent !== indent + 2) throw new YamlError('indentation must be two spaces deeper than its key', next.line)
    map[token.key] = next.kind === 'item' ? buildList(tokens, cursor, next.indent) : buildMap(tokens, cursor, next.indent)
  }
  return map
}

/** The frontmatter block as a plain object. Throws a YamlError naming the line for anything outside the subset. */
export function parseYamlSubset(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return {}
  if (tokens[0].indent !== 0) throw new YamlError('unexpected indentation at the start of the block', tokens[0].line)
  if (tokens[0].kind === 'item') throw new YamlError('a list cannot be at the top level; the frontmatter must be a map of keys', tokens[0].line)
  const cursor = { index: 0 }
  const value = buildMap(tokens, cursor, 0)
  if (cursor.index < tokens.length) throw new YamlError('unexpected indentation', tokens[cursor.index].line)
  return value
}
