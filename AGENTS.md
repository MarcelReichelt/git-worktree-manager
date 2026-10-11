## Language

The chat follows the user's language. Comments, code, issues, commits, and pull requests are English.

## Name

The project is git-worktree-manager. It was renamed from git-manager.
docs/research/, .cursor/plans/, and .scratch/ still use the old name.
Do not rename them. The app does not read or write the old config paths
or the GIT_MANAGER_* environment variables.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Newer branch

When a newer branch than the checkout is detected, ask whether to work on that branch before editing.

## Cursor Cloud specific instructions

`.yarnrc.yml` interpolates `NPM_TOKEN` on every Yarn command. Login shells set `NPM_TOKEN` to `local-dev` when it is unset. Publishing needs a real token in that variable.

One Vitest case spawns `node` with an empty environment. That lookup uses `/usr/bin/node`. The install script links the Node binary there.

`yarn desktop` opens the Electron window and needs a display. Install prepares the Electron binary and `native/electron`.
