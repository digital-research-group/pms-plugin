# pm-sync gotchas

Field-tested, in the order they tend to bite.

## Board calls

- **Short ids fail.** The tools want the full UUID; a truncated id is rejected. Copy the
  whole thing, including the dashes.
- **A failed board write changed nothing.** There is no partial write to inspect and
  nothing to reconcile: redo the call immediately, then confirm the card shows the lane
  you intended. Treat a connector error as blocking, not as noise.
- **Area and Priority are dropdowns, and they reject unknown values.** The error lists
  the allowed ones. Read it and retry with one of those rather than guessing a synonym.
- **Comments are capped.** A 10,000-character rejection was seen in the field, so split
  a long plan or a long evidence dump into numbered parts ("1 of 3") instead of trying
  one giant comment.
- **`get_board` responses can exceed the tool output limit.** Save the response to a
  file and parse it with `jq` or python. Do not try to read it inline, and do not retry
  the call hoping for a smaller answer.
- **Grouped and individual tool layouts change the tool names.** A connection may list
  one tool per area (`items` with `{ action, arguments }`) or one tool per action
  (`update_item` with the arguments at the top level). The hook handles both, which is
  why the PostToolUse matcher in `settings.hooks.json` is deliberately broad: narrowing
  it to the names you happen to see today silently turns the mirror off for anyone on
  the other layout.

## The mirror

- **It only knows what Claude wrote or read.** A card someone moved in the board UI is
  invisible here until Claude touches that card again, so the session-start list can be
  stale in exactly one direction: it may name a card that has since moved. Refresh the
  active-lane cards with one `search` or `get_item` before editing. The log says it is a
  local view for this reason.
- **A card in another board cannot clear this board's gates.** A write whose response
  only names a different `boardId` is ignored outright: not mirrored, not logged, and it
  does not reset the staleness clock. If a gate will not clear, check that you wrote to
  the board the config names.
- **Reads do not reset the clock.** Reading a card refreshes its lane and name in the
  mirror, but only a write (create, update, move, comment, attach) counts as recording
  work.

## The gates

- **While background agents keep editing tracked files, every Stop can block** until a
  write records the new state. The answer is to record real progress (what changed, what
  ran, what it proved), not to post a contentless note so the gate opens: a note with no
  content is how a tracker becomes decoration. If nothing on the board actually changed,
  say so in one line and stop, which the Stop message explicitly allows.
- **Hooks run for subagents too**, so an agent can be blocked by a staleness gate it
  cannot clear itself, because its agent type has no connector grant. Relay its
  milestones through the lead and post them there.
- **A re-entered Stop always passes** (`stop_hook_active`), so the gate can never loop.
  It blocks once per new body of unrecorded work.
- **Nothing outside `track` is seen.** If a gate seems not to fire, check the globs
  first: `*` does not cross a `/`, so `scripts/*builder*.mjs` does not match
  `scripts/x/builder.mjs`. Use `**` to cross directories.
- **A Bash command counts as a verification run only if it matches `verify_command`.**
  That shorter bound exists because the moment a test run finishes is the moment its
  result belongs on a card.

## Installing

- **A newly merged hook does not fire until the settings watcher reloads.** The
  pipe-tests can all pass while nothing happens in the live session. Only the user can
  fix that: they open `/hooks` once, or restart the session. Say so rather than
  re-installing.
- **A malformed settings file disables every setting in it**, not just the hooks. That is
  why `install.mjs` refuses one (exit 2, nothing written) instead of helpfully rewriting
  it: rewriting would hide the damage. Fix the JSON by hand first.
- **Never assign to `hooks.<Event>`.** Other hooks live in those arrays (security gates,
  notifiers, other tools' hooks) and one assignment drops them silently. Append, and let
  `install.mjs` do it.
- **An older in-repo install may be registered in the personal settings file**, not the
  shared one. Check both `.claude/settings.json` and `.claude/settings.local.json`.
- **The sandbox may refuse writes to `.claude/settings*.json`.** That is a permission
  boundary: ask the user to allow it or to run the command themselves. Do not look for
  another way in.
- **`jq` is often missing.** `command -v jq` first; every step in SKILL.md has a `node -e`
  form that needs nothing but Node.

## The config

- **The frontmatter is a small YAML subset, not YAML.** Two spaces per level, no tabs,
  no flow maps `{a: 1}` or flow lists `[a, b]`, no anchors, no `|` or `>` blocks. Quote
  anything starting with `*`, `&`, `[`, `{`, `|` or `>`. A duplicate key is an error
  rather than a silent overwrite, because a duplicated `enabled` would decide the whole
  feature invisibly.
- **A broken config never blocks work.** It costs one line at session start naming the
  file and the first error; every other hook mode stays silent. So if you see that line,
  nothing is syncing: fix the file.
- **`enabled` must be set explicitly.** A config with no `enabled` key is reported as
  invalid rather than quietly doing nothing, so a half-finished setup is visible.
- **The log path must stay inside the repo.** The hooks write that file, so an absolute
  path or one climbing out with `..` is refused.
- **An all-digit id parses as a number** and is accepted (some boards really do use
  numeric ids), but quote it if you want to be explicit.

## Codex and Grok

- **Codex skips changed hooks until they are re-trusted.** Trust is pinned to each hook's
  hash: after editing `.codex/hooks.json` or the pm-sync scripts, approve them again in
  `/hooks`, or nothing fires.
- **A Codex PostToolUse block replaces the tool output**, so pm-sync sends Codex its
  post-tool nudges as context instead. Stop still blocks.
- **Grok ignores everything but a PreToolUse deny.** On Grok there is no session-start
  context, no nudge and no Stop check: the edit gate is the only voice. Put the board
  rules where Grok's agent will read them.
- **One `.claude/settings.json` serves Claude and Grok.** Do not add `--client` to those
  commands; the payload shape tells the two apart.
