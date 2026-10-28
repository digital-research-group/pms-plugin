import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globPrefix, matchGlob, matchesAny, repoRelative } from '../lib/glob.mjs'

test('** crosses segments', () => {
  assert.equal(matchGlob('packages/core/src/**', 'packages/core/src/a.ts'), true)
  assert.equal(matchGlob('packages/core/src/**', 'packages/core/src/deep/nest/a.ts'), true)
  assert.equal(matchGlob('packages/core/src/**', 'packages/core/tests/a.ts'), false)
  assert.equal(matchGlob('**/UPSTREAM.json', 'UPSTREAM.json'), true)
  assert.equal(matchGlob('**/UPSTREAM.json', 'a/b/UPSTREAM.json'), true)
  assert.equal(matchGlob('api/src/**/*builder*.ts', 'api/src/page/builder-routes.ts'), true)
  assert.equal(matchGlob('api/src/**/*builder*.ts', 'api/src/builder.ts'), true)
  assert.equal(matchGlob('api/src/**/*builder*.ts', 'api/src/routes.ts'), false)
})

test('* does not cross a slash', () => {
  assert.equal(matchGlob('scripts/*builder*.mjs', 'scripts/test-builder-dom.mjs'), true)
  assert.equal(matchGlob('scripts/*builder*.mjs', 'scripts/x/builder.mjs'), false)
  assert.equal(matchGlob('docs/instatic-*.md', 'docs/instatic-plan.md'), true)
  assert.equal(matchGlob('docs/instatic-*.md', 'docs/instatic/plan.md'), false)
})

test('? matches one character but never a slash', () => {
  assert.equal(matchGlob('docs/v?.md', 'docs/v2.md'), true)
  assert.equal(matchGlob('docs/v?.md', 'docs/v22.md'), false)
  assert.equal(matchGlob('a?b', 'a/b'), false)
})

test('a trailing slash is a directory prefix', () => {
  assert.equal(matchGlob('packages/editor/dev/', 'packages/editor/dev/server.mjs'), true)
  assert.equal(matchGlob('packages/editor/dev/', 'packages/editor/dev/a/b/c.ts'), true)
  assert.equal(matchGlob('packages/editor/dev/', 'packages/editor/devtools.ts'), false)
})

test('an exact file pattern matches only that file', () => {
  assert.equal(matchGlob('packages/core/README.md', 'packages/core/README.md'), true)
  assert.equal(matchGlob('packages/core/README.md', 'packages/core/README.md.bak'), false)
  assert.equal(matchGlob('packages/core/README.md', 'other/packages/core/README.md'), false)
})

test('regex metacharacters in a pattern are literal', () => {
  assert.equal(matchGlob('docs/a+b(c).md', 'docs/a+b(c).md'), true)
  assert.equal(matchGlob('docs/a.md', 'docs/aXmd'), false)
})

test('leading ./ and / are ignored on both sides', () => {
  assert.equal(matchGlob('./src/**', 'src/a.ts'), true)
  assert.equal(matchGlob('/src/**', './src/a.ts'), true)
})

test('matchesAny is true when any pattern matches', () => {
  const patterns = ['src/**', 'scripts/*builder*.mjs']
  assert.equal(matchesAny(patterns, 'scripts/x-builder.mjs'), true)
  assert.equal(matchesAny(patterns, 'src/deep/a.ts'), true)
  assert.equal(matchesAny(patterns, 'docs/a.md'), false)
  assert.equal(matchesAny(patterns, ''), false)
  assert.equal(matchesAny([], 'src/a.ts'), false)
})

test('globPrefix is the literal directory before the first wildcard', () => {
  assert.equal(globPrefix('packages/core/src/**'), 'packages/core/src')
  assert.equal(globPrefix('scripts/*builder*.mjs'), 'scripts')
  assert.equal(globPrefix('api/src/**/*builder*.ts'), 'api/src')
  assert.equal(globPrefix('packages/core/README.md'), 'packages/core')
  assert.equal(globPrefix('UPSTREAM.json'), '')
  assert.equal(globPrefix('**/a.ts'), '')
  assert.equal(globPrefix('docs/'), 'docs')
})

test('repoRelative resolves inside the root and refuses anything outside', () => {
  assert.equal(repoRelative('/repo', '/repo/src/a.ts'), 'src/a.ts')
  assert.equal(repoRelative('/repo', 'src/a.ts'), 'src/a.ts')
  assert.equal(repoRelative('/repo', './src/a.ts'), 'src/a.ts')
  assert.equal(repoRelative('/repo', '/elsewhere/a.ts'), null)
  assert.equal(repoRelative('/repo', '../a.ts'), null)
  assert.equal(repoRelative('/repo', ''), null)
  assert.equal(repoRelative('/repo', undefined), null)
})
