import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitEvent, isReadOnlyCommand } from '../lib/shell.mjs'

test('plain reads count as read-only', () => {
  for (const command of [
    'ls -la', 'cat packages/core/src/a.ts', 'rg -n foo src', 'grep -rn needle .', 'git status', 'git status --short',
    'git log --oneline -5', 'git diff HEAD~1 -- src', 'git show abc1234', 'head -5 a.ts | wc -l', 'rg foo 2>/dev/null',
    'cd src && ls', 'pwd', 'git --no-pager log -3', 'git -C sub status', 'wc -l a b', 'git rev-parse HEAD', 'find src -name "*.ts"',
  ]) assert.equal(isReadOnlyCommand(command), true, command)
})

test('anything that can write, run another command, or is not on the allowlist is not read-only', () => {
  for (const command of [
    '', 'ls > out.txt', 'ls >> out.txt', 'cat a | tee b', 'sed -i s/a/b/ f', 'sed -n 1p f', 'npm test', 'git commit -m x',
    'git status && rm -rf x', 'ls; touch x', 'echo $(touch x)', 'cat `touch x`', 'git diff --output=x', 'find . -delete',
    'find . -exec rm {} \\;', 'sort -o f f', 'FOO=1 ls', 'git log && git push', 'rg --pre ./x foo', 'git -c core.fsmonitor=x status',
    'ls\ntouch x', 'git branch -D x', 'git stash', 'git checkout main', 'cat <(touch x)', 'python3 -c "print(1)"',
  ]) assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command))
})

const out = (stdout, stderr = '') => ({ stdout, stderr, interrupted: false })

test('a successful gh pr create is a PR-open event carrying its url', () => {
  assert.deepEqual(gitEvent('gh pr create --fill', out('https://github.com/acme/widgets/pull/42\n')),
    { kind: 'pr-open', url: 'https://github.com/acme/widgets/pull/42' })
  assert.deepEqual(gitEvent('git push -u origin x && gh pr create --title t --body b', 'https://github.com/acme/widgets/pull/7'),
    { kind: 'pr-open', url: 'https://github.com/acme/widgets/pull/7' })
})

test('a failed or unrelated gh call is no event', () => {
  assert.equal(gitEvent('gh pr create --fill', out('', 'pull request create failed: GraphQL: No commits between main and x')), null)
  assert.equal(gitEvent('echo gh pr create', out('gh pr create')), null)
  assert.equal(gitEvent('gh pr view 42', out('https://github.com/acme/widgets/pull/42')), null)
  assert.equal(gitEvent('gh pr merge 42 --auto', out('Pull request acme/widgets#42 will be automatically merged when all requirements are met')), null)
})

test('gh pr merge and gh pr ready are recognised from their output', () => {
  assert.deepEqual(gitEvent('gh pr merge 42 --squash', out('Squashed and merged pull request acme/widgets#42 (Add drag)')),
    { kind: 'pr-merge', number: 42 })
  assert.deepEqual(gitEvent('gh pr merge https://github.com/acme/widgets/pull/42', out('Merged pull request acme/widgets#42')),
    { kind: 'pr-merge', number: 42, url: 'https://github.com/acme/widgets/pull/42' })
  assert.deepEqual(gitEvent('gh pr ready 42', out('Pull request acme/widgets#42 is marked as "ready for review"')),
    { kind: 'pr-ready', number: 42 })
  assert.equal(gitEvent('gh pr merge 42', out('', 'GraphQL: Pull request is not mergeable')), null)
})

test('git push and git commit are recognised only when they succeeded', () => {
  assert.deepEqual(gitEvent('git push -u origin feature', out('', 'To github.com:acme/widgets.git\n * [new branch]      feature -> feature\n'
    + "remote: Create a pull request for 'feature' on GitHub by visiting:\nremote:      https://github.com/acme/widgets/pull/new/feature")), { kind: 'push' })
  assert.equal(gitEvent('git push', out('', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs')), null)
  assert.deepEqual(gitEvent('git commit -m "Add drag"', out('[feature 1a2b3c4] Add drag\n 1 file changed, 2 insertions(+)')), { kind: 'commit' })
  assert.equal(gitEvent('git commit -m x', out('nothing to commit, working tree clean')), null)
  assert.equal(gitEvent('ls', out('[feature 1a2b3c4] Add drag')), null)
})
