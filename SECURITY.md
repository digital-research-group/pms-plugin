# Security

## Reporting a vulnerability

Report it privately through this repository's **Security** tab ("Report a
vulnerability"). Do not open a public issue.

## What this plugin holds

- No keys, tokens or passwords. Signing in to the MCP server stores your own token in
  Claude Code; the plugin only names the server's public address.
- Access is decided by the server: your connection's role and granted tools in the
  Project Management System. Installing the plugin grants nothing.

## What it runs

The pm-sync hooks run on every installer's machine, in every repository, so changes to
`main` are protected: pull requests with passing CI only, no force pushes, no deletion.
In a repository that has not opted in, the hooks print nothing and write nothing. A
config is read only when git confirms it is untracked, so a cloned repository cannot switch
the hooks on or inject text, and the log path cannot point inside `.git`.
