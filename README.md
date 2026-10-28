# PMS Plugin

A Claude Code plugin for the Digital Research Group Project Management System. One
install gives you:

- **The Project Management System MCP connection**: boards, items, comments and the
  other tools your connection is granted.
- **pm-sync**: hooks and a skill that keep a board in step with the git repository you
  work in. Session start shows the board and your active cards; edits to tracked files
  wait until a card is in your active lane; finished work is recorded on the card. The
  hooks stay silent in every repository that has not opted in.

Requirements: Claude Code, Node.js 20 or later on your `PATH`, and git.

## Install

```bash
claude plugin marketplace add digital-research-group/pms-plugin
claude plugin install pms@drg-pms
```

Restart Claude Code, then open `/mcp` and sign in to `plugin:pms:pms`.

### Which MCP address to use

The plugin connects to `https://pm.digitalresearchgroup.com/api/v1/platform-mcp` by
default. Signing in there creates a new connection for you, and you choose its role and
tools on the consent page. Only **organization owners and admins of client organizations,
and the agency owner**, can approve that.

Everyone else connects through a connection an owner or admin made for them in the app's
MCP tab: an agent connection that lists you as a manager. You can approve it only up to your
own role; an agent with a higher role needs an organization owner to approve it. Set its
address, which ends in `/c/<id>`:

```bash
claude plugin configure pms
```

### Tools to grant

Board sync needs `repo_context` on your connection. Tick it in the app's MCP tab (or on the
consent page), along with the item tools you want the agent to use.

### Already have the claude.ai connector?

Then every tool is listed twice. Turn one off in `/mcp`. pm-sync works with either: it
recognises board calls under any server name.

## Turn on board sync for a repository

In the repository, ask Claude to "turn on board sync" (the `pm-sync` skill). It finds the
board through `repo_context`, writes `.pm-sync.local.md` with the board's real ids, and
verifies it. The config is personal: keep it out of git. The hooks read it only when git
confirms it is an untracked file in a git repository, so a config that comes with a
cloned repository is ignored, and sync stays off where git is unavailable.

Turn it off with `enabled: false` in `.pm-sync.local.md`, or delete the file.

## Updates

Updates ship when the plugin's version changes. Turn on auto-update for the `drg-pms`
marketplace in `/plugin`, or run:

```bash
claude plugin update pms@drg-pms
```

then restart. Updates never touch a repository's `.pm-sync.local.md`.

## Uninstall

```bash
claude plugin uninstall pms@drg-pms
```

## What runs on your machine

The hooks are plain Node.js with no dependencies (`plugins/pms/hooks`). They make no
network calls: they read what Claude sent to and received from the board tools, and print
instructions back to Claude. In a repository with sync on they write a small state file in
`.git`, a log (`.pm-sync.log.md` by default, always a `.md` file outside `.git`) and a queue of
failed board writes in `.pm-sync/outbox.jsonl`. The agent makes every board call, with your connection's
permissions. The plugin holds no keys or tokens; signing in stores your own token in
Claude Code.

## Contributing

Changes go through a pull request to `main` with passing CI. To release, bump
`version` in `plugins/pms/.claude-plugin/plugin.json`: installed copies update only when
it changes. Run the tests with:

```bash
cd plugins/pms && node --test hooks/tests/*.test.mjs
```

See [SECURITY.md](SECURITY.md) to report a vulnerability.
