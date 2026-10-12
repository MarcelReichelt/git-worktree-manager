# Git workspace manager

git-worktree-manager is the desktop app for one workspace at a time, with a checkout per branch. The window holds the open repository tabs.

The project is git-worktree-manager. It was renamed from git-manager.
docs/research/, .cursor/plans/, and .scratch/ still use the old name.
Do not rename them. The app does not read or write the old config paths
or the GIT_MANAGER_* environment variables.

## Language

**Workspace**:
The view of the selected repository tab: the worktrees, the content, and the terminal section.
_Avoid_: workspaces

**Repository tab**:
A registered repository open in the window. Closing it leaves that registered repository in the registry.
_Avoid_: tab, project, session

**Terminals**:
The window-bar control before the repository tabs for the worktrees that have a terminal.
_Avoid_: terminals tab, terminal overview

**Repository card**:
The registered repositories that have no repository tab, together with Add repository. The start screen shows it. The + opens it over the workspace.
_Avoid_: switcher, repository menu

**Content**:
The region of a workspace beside the list of branches. It shows the branch heading, the changed files, the commits, and the diff.
_Avoid_: sheet

**Changes**:
The files that differ in the selected checkout.
_Avoid_: status, diff

**Diff**:
The view of one selected file in the content, from Changes or from a commit.
_Avoid_: patch, changes

**Folded**:
The diff mode in which unchanged stretches are folds.
_Avoid_: collapsed, compact

**Full file**:
The diff mode that shows the whole diff with no folds.
_Avoid_: expanded

**Fold**:
A hidden stretch of unchanged lines in the diff.
_Avoid_: collapse

**Context**:
The unchanged lines kept beside a change while the rest of the diff is folded.
_Avoid_: padding

**Inline**:
The diff layout with the old and new lines in one column.
_Avoid_: unified

**Side by side**:
The diff layout with the old file on the left and the new file on the right.
_Avoid_: split

**Commits**:
The commits of the selected branch. On the default branch, that is that branch's history. On any other branch, that is the commits that are not on the default branch.
_Avoid_: history, log

**Terminal section**:
The row under the content. It holds the terminal tabs for the selected worktree.
_Avoid_: terminal panel

**Arrangement**:
The app-wide sizes of the content and the terminal section.
_Avoid_: layout

**Registered repository**:
A local git repository the app knows how to open, recorded by its path and display name.
_Avoid_: project

**Primary checkout**:
The checkout at the registered repository's path.
_Avoid_: master tree, worktree, main repo

**Default branch**:
The branch this repository treats as its base. Update from master and Merge into master mean this branch, and merging another branch into it is how that branch is finished.
_Avoid_: master, main, primary branch

**Worktree**:
A checkout of a single branch, in either the sibling layout or the workspaces layout.
_Avoid_: workspace

**Hook**:
One step a repository runs before or after a worktree is created or removed. A shell command is one hook. A plugin method for that moment is one hook.
_Avoid_: script

**Terminal**:
A running shell for a worktree. It lives in a terminal tab.
_Avoid_: multiplexer, tab

**Terminal tab**:
A numbered view in the terminal section. It holds one terminal, or two side by side.
_Avoid_: session

**Terminal mode**:
The app setting that chooses which kind a new terminal is: an in-app terminal or a tmux session. None removes the terminal section. The default is an in-app terminal.
_Avoid_: shell mode

**Shell command**:
The program an in-app terminal runs. Tmux mode does not use it.
_Avoid_: terminal command

**Preset**:
A named set of terminal tabs to open in the selected worktree.
_Avoid_: session, action, layout, arrangement

**Startup command**:
The text a terminal runs after its shell starts.
_Avoid_: shell command

**Sibling**:
The worktree layout where the branch checkout is a folder next to the main repo folder, named from the branch.
_Avoid_: side-by-side

**Workspaces**:
The worktree layout where branch checkouts are subfolders under `.workspaces`.
_Avoid_: subfolder mode

**Repository layout**:
One registered repository's choice of Sibling or Workspaces. When it has none, create uses the app default.
_Avoid_: arrangement, app default

**App default**:
The layout used when a registered repository has not chosen Sibling or Workspaces.
_Avoid_: unset layout

**Sidebar color**:
The color of the worktrees region and of a repository tab. One registered repository may set its own. With none set, the app settings color is used.
_Avoid_: accent, theme

**Sidebar text**:
White or black writing on the sidebar color. One registered repository may set its own. With none set, the app settings choice is used.
_Avoid_: foreground

**App settings**:
The settings that apply to every registered repository: the app default, the terminal mode, the shell command, the sidebar color, the sidebar text, the content color, the terminal colors, the terminal font, and the IDE command.
_Avoid_: repository settings

**Repository settings**:
The location, the display name, the remotes, the sidebar color, and the sidebar text of one registered repository.
_Avoid_: app settings

**Remote**:
A name and a fetch URL on the open repository.
_Avoid_: origin, upstream
