import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYamlSubset, YamlError } from '../lib/yaml.mjs'

/** The thrown error, so a test can assert its message and line. */
function thrown(text) {
  let error = null
  try { parseYamlSubset(text) } catch (caught) { error = caught }
  assert.ok(error instanceof YamlError, `expected a YamlError for ${JSON.stringify(text)}, got ${error}`)
  return error
}

test('an empty block is an empty map', () => {
  assert.deepEqual(parseYamlSubset(''), {})
  assert.deepEqual(parseYamlSubset('\n\n'), {})
})

test('every scalar form', () => {
  const value = parseYamlSubset([
    'plain: Acme Web',
    'spaced:   two words  ',
    "single: 'it''s quoted: yes'",
    'double: "a \\"quote\\" and a \\n newline"',
    'yes: true',
    'no: false',
    'count: 8',
    'negative: -3',
    'ratio: 2.5',
    'word_true: truthy',
    'hashless: a#b',
    'colonish: https://pm.example.com/boards/1',
  ].join('\n'))
  assert.deepEqual(value, {
    plain: 'Acme Web',
    spaced: 'two words',
    single: "it's quoted: yes",
    double: 'a "quote" and a \n newline',
    yes: true,
    no: false,
    count: 8,
    negative: -3,
    ratio: 2.5,
    word_true: 'truthy',
    hashless: 'a#b',
    colonish: 'https://pm.example.com/boards/1',
  })
})

test('comments at line start and after whitespace, never inside quotes', () => {
  const value = parseYamlSubset([
    '# a whole-line comment',
    '   # an indented comment',
    'enabled: true   # trailing comment',
    "regex: 'a # b'  # kept inside the quotes",
    'double: "c # d"',
  ].join('\n'))
  assert.deepEqual(value, { enabled: true, regex: 'a # b', double: 'c # d' })
})

test('nested maps by two-space indentation', () => {
  const value = parseYamlSubset([
    'board:',
    '  name: Acme Web',
    '  id: 5e1f0c2a-7b3d',
    '  nested:',
    '    deep: 1',
    'after: 2',
  ].join('\n'))
  assert.deepEqual(value, { board: { name: 'Acme Web', id: '5e1f0c2a-7b3d', nested: { deep: 1 } }, after: 2 })
})

test('a key with no value and no indented block is null', () => {
  assert.deepEqual(parseYamlSubset('lanes:\nother: 1'), { lanes: null, other: 1 })
  assert.deepEqual(parseYamlSubset('lanes:'), { lanes: null })
})

test('lists of scalars', () => {
  const value = parseYamlSubset([
    'track:',
    '  - packages/core/src/**',
    "  - 'scripts/*builder*.mjs'",
    '  - docs/a.md   # comment',
    'count: 3',
  ].join('\n'))
  assert.deepEqual(value, { track: ['packages/core/src/**', 'scripts/*builder*.mjs', 'docs/a.md'], count: 3 })
})

test('a list at the top level is rejected: the config is a map', () => {
  const error = thrown('- a\n- b')
  assert.ok(error instanceof YamlError)
  assert.match(error.message, /line 1: .*map/)
})

test('tabs are rejected and the line is named', () => {
  const error = thrown('board:\n\tname: x')
  assert.ok(error instanceof YamlError)
  assert.equal(error.line, 2)
  assert.match(error.message, /line 2: .*tab/i)
})

test('flow maps and flow sequences are rejected', () => {
  const map = thrown('enabled: true\nboard: { name: x }')
  assert.equal(map.line, 2)
  assert.match(map.message, /flow/i)
  const seq = thrown('track: [a, b]')
  assert.equal(seq.line, 1)
  assert.match(seq.message, /flow/i)
})

test('anchors and aliases are rejected', () => {
  const anchor = thrown('a: &base x')
  assert.equal(anchor.line, 1)
  assert.match(anchor.message, /anchor/i)
  const alias = thrown('a: 1\nb: *base')
  assert.equal(alias.line, 2)
  assert.match(alias.message, /anchor|alias/i)
})

test('multi-line scalars are rejected', () => {
  for (const [text, line] of [['body: |\n  x', 1], ['body: >-\n  x', 1], ['a: 1\nbody: |2\n  x', 2]]) {
    const error = thrown(text)
    assert.equal(error.line, line, text)
    assert.match(error.message, /multi-line/i)
  }
})

test('odd indentation is rejected', () => {
  const error = thrown('board:\n   name: x')
  assert.equal(error.line, 2)
  assert.match(error.message, /two spaces/i)
})

test('indentation that matches no open block is rejected', () => {
  const error = thrown('a: 1\n    b: 2')
  assert.equal(error.line, 2)
  assert.match(error.message, /indent/i)
})

test('a duplicate key is rejected rather than silently overwritten', () => {
  const error = thrown('enabled: true\nenabled: false')
  assert.equal(error.line, 2)
  assert.match(error.message, /duplicate key "enabled"/)
})

test('a line that is neither "key: value" nor "- item" is rejected', () => {
  const error = thrown('enabled: true\njust a sentence')
  assert.equal(error.line, 2)
  assert.match(error.message, /key: value/)
})

test('an unterminated quote is rejected', () => {
  assert.match(thrown("a: 'open").message, /line 1: .*unterminated/i)
  assert.match(thrown('a: "open').message, /line 1: .*unterminated/i)
  assert.match(thrown("a: 'x' trailing").message, /line 1: /)
})

test('a list of maps is rejected: only scalars are supported', () => {
  const error = thrown('track:\n  - name: a')
  assert.equal(error.line, 2)
  assert.match(error.message, /scalar/i)
  const bare = thrown('track:\n  -\n  - b')
  assert.equal(bare.line, 2)
  assert.match(bare.message, /scalar/i)
})

test('an empty key is rejected', () => {
  const error = thrown(': value')
  assert.equal(error.line, 1)
  assert.match(error.message, /key/i)
})
