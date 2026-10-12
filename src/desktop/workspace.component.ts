import { NgTemplateOutlet } from '@angular/common';
import {
  AfterViewChecked,
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  NgZone,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { execFileSync } from 'node:child_process';
import { readdirSync, watch, type FSWatcher } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import {
  addRepository,
  findRepository,
  listRepositories,
  type RegisteredRepository,
} from '../registry.js';
import { mergeIntoMaster, updateFromMaster } from '../merge.js';
import {
  formatCreateLayout,
  pinWorktree,
  readAppSettings,
  readOpenRepositoryTabs,
  readRepositoryAppearance,
  resolveAppSettingsPath,
  resetAppColors,
  saveArrangement,
  saveContentColor,
  saveDefaultLayout,
  saveDiffLayout,
  saveDiffMode,
  saveDiffSideShare,
  saveIdeCommand,
  saveOpenRepositoryTabs,
  saveShellCommand,
  saveSidebarColor,
  saveSidebarText,
  saveTerminalBackground,
  saveTerminalFont,
  saveTerminalForeground,
  saveTerminalMode,
  unpinWorktree,
  type AppSettings,
  type DiffLayout,
  type DiffMode,
  type SidebarText,
  type TerminalMode,
} from '../app-settings.js';
import { pushBranch } from '../push.js';
import { createWorktree, findCheckout, removeWorktree } from '../worktrees.js';
import {
  contentSwatches,
  sidebarSwatches,
  terminalBackgroundSwatches as terminalBackgroundSwatchList,
  terminalForegroundSwatches as terminalForegroundSwatchList,
} from './color-swatches';
import { copyText } from './copy-text';
import { launchIde } from './ide-launch';
import { browseForFolder } from './folder-browser';
import { runAfterPaint } from './after-paint';
import { placeContextMenu, placeSubmenu } from './menu-placement';
import { requestWindowAction, type WindowAction } from './window-chrome';
import { RepositorySettings } from './repository-settings.component';
import { OverlayScroll } from './overlay-scrollbar';
import {
  TerminalHost,
  adoptedTmuxTerminal,
  liveTerminal,
  modeHasRunningTerminals,
  startTerminal,
  stopModeSessions,
  stopShellTerminals,
  stopTerminal,
  terminalsForMode,
} from './terminal-host';
import {
  editableName,
  emptyTerminals,
  mapTerminalCommand,
  tabChipModel,
  terminalDisplayName as formatTerminalName,
  terminalHostTitle as formatHostTitle,
  terminalMenuActions,
  terminalMoveTargets,
  withMoveInto,
  withNewTab,
  withRename,
  withSplit,
  withSwap,
  withUnsplit,
  withoutTab,
  withoutTerminal,
  type TerminalMenuActions,
  type TerminalMoveTarget,
  type TerminalTabView,
  type TerminalView,
  type WorktreeTerminalView,
} from './terminal-tabs';
import {
  ambiguousLegacySessions,
  claimUniqueLegacySessions,
  killTmuxSession,
  listTmuxSessionRecords,
  listTmuxSessionSnapshots,
  rememberSessionBranch,
  sessionsForBranch,
  tmuxOnPath,
  typeTmuxStartupCommand,
  type OldSessionChoice,
  type TmuxSessionRecord,
  type TmuxSessionSnapshot,
} from './tmux-sessions';
import { readCheckoutPresets, terminalDirectory, type CommittedPreset } from './terminal-presets';
import { typeStartupCommand } from './shell-host';
import {
  ensureGitRepository,
  listRemoteBranchesWithoutWorktree,
  refreshOpenRepositoryRemotes,
  pinDefaultBranch,
  countBranchCommits,
  countCommitsOnlyOnBranch,
  readChangedFiles,
  readCommitFileDiff,
  readCommitFileSides,
  readCommitFiles,
  readCommitsOnlyOnBranch,
  readDefaultBranch,
  readOpenBranches,
  readRecentCommits,
  withWorktreeList,
  recentCommitPageSize,
  readWorkingTreeDiff,
  readWorkingTreeFileSides,
  type BranchCommit,
  type ChangedFile,
} from '../branches.js';
import {
  diffLines,
  foldInlineDiff,
  fullFileLines,
  openFoldAll,
  openFoldMore,
  sideBySideRows,
  type DiffLine,
  type FoldedFoldRow,
  type FoldedRow,
  type FoldOpenings,
  type FullFileDiff,
  type SideBySideRow,
  type SideCell,
} from '../diff-lines.js';

type BranchStatus = 'local-only' | 'local-and-remote' | 'remote-only' | 'remote-deleted';

interface SampleFile {
  path: string;
  previousPath?: string;
  added: number | null;
  deleted: number | null;
  diff?: string;
}

interface SampleCommit {
  sha?: string;
  subject: string;
  files?: SampleFile[];
  diff?: string;
  onDefaultBranch?: boolean;
}

interface SampleBranch {
  name: string;
  status: BranchStatus;
  changedFileCount: number;
  ahead: number;
  behind: number;
  files?: SampleFile[];
  commits?: SampleCommit[];
}

interface SampleBranchList {
  defaultBranch?: string;
  branches: SampleBranch[];
}

function sampleAddedDiff(markedLine: string): string {
  const text = markedLine.startsWith('+') ? markedLine.slice(1) : markedLine;
  return [
    'diff --git a/sample b/sample',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/sample',
    '@@ -0,0 +1 @@',
    `+${text}`,
    '',
  ].join('\n');
}

const harborBranches: SampleBranch[] = [
  {
    name: 'feature/login',
    status: 'local-and-remote',
    changedFileCount: 2,
    ahead: 3,
    behind: 1,
    files: [
      { path: 'src/login.ts', added: 12, deleted: 3, diff: sampleAddedDiff('+export function login') },
      { path: 'README.md', added: 4, deleted: 1 },
    ],
    commits: [
      {
        subject: 'Add the login form',
        files: [{ path: 'src/login.ts', added: 10, deleted: 0 }],
        diff: sampleAddedDiff('+function login'),
      },
      {
        subject: 'Wire the session',
        files: [{ path: 'src/session.ts', added: 8, deleted: 2 }],
        diff: sampleAddedDiff('+export function session'),
      },
      {
        subject: 'Open the harbor',
        onDefaultBranch: true,
        files: [{ path: 'README.md', added: 1, deleted: 0 }],
        diff: sampleAddedDiff('+# harbor'),
      },
    ],
  },
  { name: 'wip', status: 'local-only', changedFileCount: 0, ahead: 0, behind: 0 },
  { name: 'origin/release', status: 'remote-only', changedFileCount: 0, ahead: 4, behind: 0 },
  {
    name: 'abandoned',
    status: 'remote-deleted',
    changedFileCount: 1,
    ahead: 2,
    behind: 0,
    files: [{ path: 'assets/logo.png', added: null, deleted: null }],
  },
  {
    name: 'rename-docs',
    status: 'local-and-remote',
    changedFileCount: 1,
    ahead: 1,
    behind: 0,
    files: [{ path: 'docs/guide.md', previousPath: 'docs/old-guide.md', added: 4, deleted: 1 }],
  },
];

const atlasBranches: SampleBranch[] = [
  {
    name: 'feature/login',
    status: 'local-only',
    changedFileCount: 0,
    ahead: 0,
    behind: 0,
    commits: [
      { subject: 'Sketch the login' },
      { subject: 'Open the atlas', onDefaultBranch: true },
    ],
  },
  {
    name: 'main',
    status: 'local-and-remote',
    changedFileCount: 0,
    ahead: 0,
    behind: 0,
    commits: [{ subject: 'Open the atlas' }, { subject: 'Chart the coast' }],
  },
  { name: 'wip', status: 'local-only', changedFileCount: 0, ahead: 0, behind: 0 },
];

const branchesByRepository: Record<string, SampleBranchList> = {
  Harbor: { branches: harborBranches },
  Atlas: { defaultBranch: 'main', branches: atlasBranches },
};

interface CardRepository {
  name: string;
  path: string | null;
}

interface RepositoryTab {
  path: string;
  name: string;
}

const sampleCard: CardRepository[] = [
  { name: 'Harbor', path: null },
  { name: 'Atlas', path: null },
];

@Component({
  selector: 'gm-workspace',
  standalone: true,
  imports: [NgTemplateOutlet, TerminalHost, RepositorySettings, OverlayScroll],
  styleUrl: './workspace-rail.css',
  host: {
    '[style.--forest]': 'paintedSidebarColor()',
    '[style.--paper]': 'contentColor()',
    '[style.--sidebar-text]': 'paintedSidebarTextColor()',
  },
  styles: [
    `
:host {
  --paper: #f7f7f5;
  --surface: #ffffff;
  --forest: #1a3c2b;
  --sidebar-text: #ffffff;
  --grid: #3a3a38;
  --coral: #ff8c69;
  display: block;
  min-height: 100vh;
  overflow: hidden;
  background-color: var(--forest);
  border-radius: 8px;
  color: var(--grid);
  font-family: "General Sans", "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.4;
}

h1, h2, h3, p { margin: 0; }

button, input { font: inherit; color: inherit; }

.start-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background-color: var(--forest);
}

.switching-overlay {
  position: fixed;
  inset: 0;
  z-index: 4;
  background: rgba(26, 60, 43, 0.2);
}

[data-testid='repository-card'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 22rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
}

[data-testid='opening-repository'] {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22rem;
  min-height: 5rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
}

[data-testid='repository-card'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-heading h2 {
  margin: 0;
}

.card-heading [data-testid='add-repository'] {
  width: 28px;
  height: 28px;
  padding: 0;
  text-align: center;
  font-size: 18px;
  line-height: 1;
}

[data-testid='repositories-empty'] {
  margin: 0;
  color: var(--ink);
}

[data-testid='repository'],
[data-testid='add-repository'],
[data-testid='close-repository-switcher'] {
  padding: 8px 12px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  text-align: left;
  cursor: pointer;
}

[data-testid='repository']:hover,
[data-testid='add-repository']:hover,
[data-testid='close-repository-switcher']:hover {
  background: var(--surface);
}

[data-testid='add-repository'] {
  background-color: var(--forest);
  color: white;
  border-color: var(--forest);
}

[data-testid='add-repository-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='add-repository-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 22rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='add-repository-dialog'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='add-repository-dialog'] label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

[data-testid='add-repository-dialog'] input,
[data-testid='browse-repository-folder'],
[data-testid='confirm-add-repository'],
[data-testid='cancel-add-repository'] {
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  text-align: left;
  cursor: pointer;
}

[data-testid='add-repository-dialog'] input {
  width: 100%;
  height: 36px;
  padding: 0 8px;
  border-radius: 0;
  background: var(--surface);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  cursor: text;
}

[data-testid='confirm-add-repository'] {
  background-color: var(--forest);
  color: white;
  border-color: var(--forest);
}

.location-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.location-field [data-testid='add-repository-path'] {
  flex: 1;
  min-width: 0;
  text-transform: none;
  letter-spacing: normal;
}

.location-field [data-testid='browse-repository-folder'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: none;
  padding: 0;
}

[data-testid='confirm-add-repository']:disabled {
  opacity: 0.45;
  cursor: default;
}

[data-testid='create-worktree-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='create-worktree-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 22rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='create-worktree-dialog'] h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='create-worktree-info'] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--forest);
  cursor: help;
}

[data-testid='create-worktree-info'] svg {
  display: block;
}

[data-testid='create-worktree-dialog'] label,
[data-testid='existing-branches-heading'] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  color: var(--grid);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.existing-branches {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

[data-testid='create-worktree-dialog'] input,
[data-testid='confirm-create-worktree'],
[data-testid='cancel-create-worktree'] {
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  text-align: left;
  cursor: pointer;
}

[data-testid='create-worktree-dialog'] input {
  width: 100%;
  height: 36px;
  padding: 0 8px;
  border-radius: 0;
  background: var(--surface);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  cursor: text;
}

[data-testid='confirm-create-worktree'] {
  background-color: var(--forest);
  color: white;
  border-color: var(--forest);
}

[data-testid='create-layout'] {
  margin: 0;
  color: var(--grid);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.4;
}

[data-testid='create-branch-options'] {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 9rem;
  overflow: auto;
  border: 1px solid rgba(58, 58, 56, 0.2);
  background: var(--surface);
}

[data-testid='create-branch-option'] {
  padding: 6px 8px;
  color: var(--grid);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
}

[data-testid='create-worktree-dialog'] [data-testid='workspace-error'],
[data-testid='merge-into-master-dialog'] [data-testid='workspace-error'],
[data-testid='remove-worktree-dialog'] [data-testid='workspace-error'] {
  color: var(--coral);
}

[data-testid='merge-into-master-dialog'],
[data-testid='remove-worktree-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='merge-into-master-dialog'] .dialog-panel,
[data-testid='remove-worktree-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 22rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='remove-worktree-dialog'] .dialog-panel {
  width: 32rem;
}

[data-testid='merge-into-master-dialog'] h2,
[data-testid='remove-worktree-dialog'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='merge-into-master-dialog'] label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
}

[data-testid='confirm-merge-into-master'],
[data-testid='cancel-merge-into-master'],
[data-testid='confirm-remove-worktree'],
[data-testid='confirm-delete-branch'],
[data-testid='cancel-remove-worktree'] {
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  text-align: left;
  cursor: pointer;
}

[data-testid='confirm-merge-into-master'],
[data-testid='confirm-remove-worktree'] {
  background-color: var(--forest);
  color: white;
  border-color: var(--forest);
}

[data-testid='confirm-delete-branch'].is-danger {
  background-color: #b42318;
  border-color: #b42318;
  color: #ffffff;
}

[data-testid='app-settings-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='app-settings-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 28rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='app-settings-dialog'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='app-settings-dialog'] h3 {
  margin: 8px 0 0;
  color: var(--grid);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

[data-testid='app-settings-dialog'] label,
[data-testid='app-settings-dialog'] .color-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--grid);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0;
  text-transform: none;
}

[data-testid='app-settings-dialog'] .color-choice {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.color-swatches,
.sidebar-text-choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.sidebar-text-choices {
  gap: 16px;
}

.color-swatches button {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(58, 58, 56, 0.35);
  border-radius: 999px;
  cursor: pointer;
}

.color-swatches button.is-selected {
  outline: 2px solid var(--grid);
  outline-offset: 2px;
}

.custom-color {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 2px;
}

[data-testid='app-settings-dialog'] input[type='color'] {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(58, 58, 56, 0.2);
  background-color: var(--paper);
  cursor: pointer;
}

[data-testid='app-settings-dialog'] label.ide-command-field,
[data-testid='app-settings-dialog'] label.terminal-font-field {
  align-items: stretch;
  flex-direction: column;
}

[data-testid='ide-command'],
[data-testid='terminal-font'],
[data-testid='terminal-shell-command'] {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 8px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  background: var(--surface);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0;
  text-transform: none;
}

.terminal-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.terminal-option label {
  flex: 1;
}

[data-testid='edit-shell-command'] {
  padding: 2px 8px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  cursor: pointer;
}

[data-testid='terminal-mode-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='terminal-mode-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 22rem;
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='terminal-mode-dialog'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='terminal-mode-dialog'] p,
[data-testid='old-session-dialog'] p {
  margin: 0;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
}

[data-testid='old-session-dialog'] {
  position: fixed;
  inset: 0;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 60, 43, 0.45);
}

[data-testid='old-session-dialog'] .dialog-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 32rem;
  max-width: calc(100vw - 32px);
  padding: 16px;
  background-color: var(--paper);
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 8px;
  color: var(--grid);
}

[data-testid='old-session-dialog'] h2 {
  margin-bottom: 4px;
  color: var(--forest);
  font-family: "Space Grotesk", sans-serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

[data-testid='old-session'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

[data-testid='old-session'] .dialog-actions {
  flex-wrap: wrap;
}

[data-testid='terminal-mode-keep'],
[data-testid='terminal-mode-kill'],
[data-testid='terminal-mode-cancel'],
[data-testid='old-session-branch'],
[data-testid='old-session-kill'],
[data-testid='old-session-leave'],
[data-testid='reset-colors'],
[data-testid='close-app-settings'] {
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid rgba(58, 58, 56, 0.2);
  border-radius: 2px;
  background-color: var(--paper);
  text-align: left;
  cursor: pointer;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

[data-testid='card-error'],
[data-testid='open-repository-error'] { color: var(--coral); }
    `,
  ],
  template: `
    <ng-template #repositoryCard>
      <section data-testid="repository-card">
        <div class="card-heading">
          <h2>Repositories</h2>
          @if (registryMode()) {
            <button type="button" data-testid="add-repository" aria-label="Add repository" (click)="openAddDialog()">+</button>
          }
        </div>
        @if (registryMode() && registered().length === 0) {
          <p data-testid="repositories-empty">A repository needs to be added.</p>
        }
        @if (openError(); as message) {
          <p data-testid="open-repository-error">{{ message }}</p>
        }
        @for (repository of cardRepositories(); track repository.name + (repository.path ?? '')) {
          <button
            type="button"
            data-testid="repository"
            [attr.data-name]="repository.name"
            (click)="choose(repository.name)"
          >
            {{ repository.name }}
          </button>
        }
        @if (overlayOpen()) {
          <button type="button" data-testid="close-repository-switcher" (click)="closeSwitch()">Close</button>
        }
      </section>
    </ng-template>

    @if (openingRepository(); as name) {
      <div class="start-screen">
        <section data-testid="opening-repository">
          <h2>Opening {{ name }}</h2>
        </section>
      </div>
    } @else if (repositoryPath() === null && selectedName() === null) {
      <div class="start-screen">
        <ng-container [ngTemplateOutlet]="repositoryCard" />
      </div>
    } @else {
      <main data-testid="workspace">
        <header class="window-bar" data-testid="window-bar" (pointerdown)="dragWindow($event)">
          <div class="window-title">
            <svg data-testid="app-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <rect width="16" height="16" rx="3.5" fill="#1a3c2b" />
              <path fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" d="M5.2 12V4" />
              <path fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" d="M5.2 8H11.4" />
              <circle cx="5.2" cy="4" r="1.6" fill="#ffffff" />
              <circle cx="5.2" cy="12" r="1.6" fill="#ffffff" />
              <circle cx="11.4" cy="8" r="1.6" fill="#ffffff" />
            </svg>
            <button
              type="button"
              data-testid="terminals"
              [class.is-idle]="terminalsTotal() === 0"
              [attr.aria-label]="terminalsTotal() + ' terminals'"
              [attr.aria-selected]="terminalsOpen()"
              [style.outline]="terminalsOpen() ? '2px solid #ffffff' : 'none'"
              (click)="chooseTerminals($event)"
              (keydown)="onTerminalsKeydown($event)"
              (contextmenu)="keepTerminalsMenuClosed($event)"
            >
              <svg data-testid="terminals-prompt" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.72 6.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z" />
              </svg>
              <span data-testid="terminals-count">{{ terminalsTotal() }}</span>
            </button>
            <div data-testid="repository-tabs">
              @for (tab of repositoryTabs(); track tab.path) {
                <button
                  type="button"
                  data-testid="repository-tab"
                  [attr.data-name]="tab.name"
                  [attr.data-path]="tab.path"
                  [attr.title]="tab.name"
                  [attr.aria-selected]="terminalsOpen() ? false : effectivePath() === tab.path"
                  [style.background-color]="repositoryTabSidebarColor(tab.path)"
                  [style.color]="repositoryTabSidebarTextColor(tab.path)"
                  [style.outline]="repositoryTabFrame(tab.path)"
                  (click)="selectRepositoryTab(tab.path, $event)"
                  (contextmenu)="openRepositoryTabMenu($event, tab.path)"
                >
                  {{ tab.name }}
                </button>
              }
              <button type="button" data-testid="open-repository-card" aria-label="Open repository" (click)="openSwitch()">+</button>
            </div>
          </div>
          <div class="window-controls">
            <button type="button" data-testid="app-settings" aria-label="App settings" (click)="openAppSettings()">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z" />
              </svg>
            </button>
            <button type="button" data-testid="window-minimize" aria-label="Minimize" (click)="controlWindow('minimize')">–</button>
            <button type="button" data-testid="window-maximize" aria-label="Maximize" (click)="controlWindow('maximize')">□</button>
            <button type="button" data-testid="window-close" aria-label="Close" (click)="controlWindow('close')">×</button>
          </div>
        </header>
        <aside>
          <p class="branch-label" [hidden]="terminalsOpen()">
            <span>Worktrees</span>
            <gm-repository-settings
              [repositoryPath]="effectivePath()"
              [showControl]="!terminalsOpen()"
              (appearanceChanged)="applyOpenRepositoryAppearance()"
              (displayNameChanged)="renameOpenRepository($event)"
            ></gm-repository-settings>
          </p>
          @if (terminalsOpen()) {
            <ul data-testid="terminals-list" gmOverlayScroll>
              @for (group of terminalGroups(); track group.path) {
                <li data-testid="terminals-group" [attr.data-path]="group.path" [attr.data-name]="group.name">
                  <p data-testid="terminals-group-name">{{ group.name }}</p>
                  <ul>
                    @for (row of group.rows; track row.name) {
                      <li
                        data-testid="terminals-worktree"
                        [class.is-selected]="isTerminalsWorktree(group.path, row.name)"
                        [attr.aria-selected]="isTerminalsWorktree(group.path, row.name)"
                        [attr.data-branch]="row.name"
                        (click)="chooseTerminalsWorktree(group.path, row.name)"
                      >
                        <span class="branch-name">{{ row.name }}</span>
                        <span
                          class="terminal-count"
                          data-testid="terminal-count"
                          [attr.aria-label]="row.count + ' terminals'"
                        >
                          {{ row.count }}
                        </span>
                      </li>
                    }
                  </ul>
                </li>
              }
            </ul>
          } @else {
          @if (worktreesLoading()) {
            <ul data-testid="worktree-skeleton" aria-busy="true" aria-label="Loading worktrees">
              @for (row of worktreeSkeleton; track row) {
                <li class="branch-row skeleton-row" aria-hidden="true"><span class="skeleton-bar"></span></li>
              }
            </ul>
          } @else {
          <ul data-testid="branch-list" gmOverlayScroll>
            @for (branch of branches(); track branch.name) {
              <li
                class="branch-row"
                data-testid="branch-row"
                [class.is-selected]="selectedBranchName() === branch.name"
                [attr.data-branch]="branch.name"
                [attr.data-status]="branch.status"
                (click)="selectBranch(branch.name)"
                (contextmenu)="openBranchMenu(branch.name, $event)"
              >
                <span class="status-color" data-testid="status-color" [attr.title]="statusLabel(branch.status)"></span>
                <button type="button" class="branch-name" (click)="selectBranch(branch.name, $event)">
                  {{ branch.name }}
                </button>
                @if (terminalCount(branch.name) > 0) {
                  <span
                    class="terminal-count"
                    data-testid="terminal-count"
                    [attr.aria-label]="terminalCount(branch.name) + ' terminals'"
                  >
                    {{ terminalCount(branch.name) }}
                  </span>
                }
                @if (pinnedWorktrees().includes(branch.name)) {
                  <svg
                    class="worktree-pin"
                    data-testid="worktree-pin"
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    aria-label="Pinned"
                  >
                    <g fill="currentColor" transform="rotate(-38 8 8)">
                      <path d="M7.35 6.4h1.3L8 13.6Z" />
                      <ellipse cx="8" cy="5.7" rx="5" ry="2.15" />
                      <ellipse cx="8" cy="4.85" rx="5" ry="2.35" />
                    </g>
                  </svg>
                }
                <span class="branch-stats">
                  @if (branchActivityLabel(branch.name); as label) {
                    <span data-testid="branch-activity">{{ label }}</span>
                  } @else {
                  <span>
                    <span
                      data-testid="changed-file-count"
                      [attr.aria-label]="branch.changedFileCount + ' changed files'"
                    >{{ branch.changedFileCount }}</span>
                    {{ branch.changedFileCount === 1 ? 'file' : 'files' }}
                  </span>
                  <span>
                    ↑<span data-testid="ahead" [attr.aria-label]="branch.ahead + ' commits ahead'">{{ branch.ahead }}</span>
                    ↓<span data-testid="behind" [attr.aria-label]="branch.behind + ' commits behind'">{{ branch.behind }}</span>
                  </span>
                  }
                </span>
                <div
                  data-testid="hover-menu"
                  class="branch-actions"
                  [class.is-open]="openBranch() === branch.name && branchHasActions(branch.name)"
                  (contextmenu)="keepBranchMenu($event)"
                >
                    @if (canPinWorktree(branch.name)) {
                      <button
                        type="button"
                        data-testid="pin-worktree"
                        (click)="toggleWorktreePin(branch.name, $event)"
                      >
                        {{ pinnedWorktrees().includes(branch.name) ? 'Unpin' : 'Pin' }}
                      </button>
                    }
                    @if (branch.name !== defaultBranchName()) {
                      <fieldset>
                        <legend>Merge</legend>
                        <button
                          type="button"
                          data-testid="update-from-master"
                          (click)="updateBranch(branch.name, $event)"
                        >
                          Update from master
                        </button>
                        <button
                          type="button"
                          data-testid="merge-into-master"
                          (click)="mergeBranch(branch.name, $event)"
                        >
                          Merge into master
                        </button>
                      </fieldset>
                    }
                    @if (branch.status === 'local-only') {
                      <button
                        type="button"
                        data-testid="push-branch"
                        (click)="publishBranch(branch.name, $event)"
                      >
                        Push
                      </button>
                    }
                    @if (canRemoveWorktree(branch.name)) {
                      <button
                        type="button"
                        data-testid="remove-worktree"
                        (click)="removeBranch(branch.name, $event)"
                      >
                        Remove worktree
                      </button>
                    }
                </div>
              </li>
            }
          </ul>
          }
          <div class="create-row">
            <button type="button" data-testid="create-worktree" (click)="openCreateDialog()">Create worktree</button>
          </div>
          @if (workspaceError(); as message) {
            @if (!createDialogOpen() && !mergeDialogBranch() && !removeDialogBranch()) {
              <p data-testid="workspace-error">{{ message }}</p>
            }
          }
          }
        </aside>
        <section class="content-sheet" data-testid="content-sheet">
          @if (!terminalsOpen()) {
          @if (selectedBranch(); as branch) {
            <ng-container
              [ngTemplateOutlet]="branchHeading"
              [ngTemplateOutletContext]="{ name: branch.name, summary: true }"
            />
            <div #sheetBody class="sheet-body" [style.grid-template-rows]="terminalRowTracks()">
            @if (!terminalMaximized()) {
            @if (contentLoading()) {
            <div
              class="sheet-columns"
              data-testid="content-loading"
              aria-busy="true"
              [attr.aria-label]="'Loading ' + branch.name"
              [style.grid-template-columns]="'minmax(0, 1fr)'"
            >
              <div class="sheet-stack" [style.grid-template-rows]="changesPaneHeight() + 'px 8px minmax(0, 1fr)'">
                <div data-testid="changes">
                  <h3>Changes</h3>
                  <ul class="skeleton-list" aria-hidden="true">
                    @for (row of contentSkeleton; track row) {
                      <li class="skeleton-row"><span class="skeleton-bar"></span></li>
                    }
                  </ul>
                </div>
                <div
                  class="splitter"
                  role="separator"
                  data-testid="commits-split"
                  aria-orientation="horizontal"
                  tabindex="0"
                  (pointerdown)="beginCommitsSplit($event)"
                  (pointermove)="moveSplit($event)"
                  (pointerup)="endSplit($event)"
                  (dblclick)="halveCommitsSplit()"
                ></div>
                <div data-testid="commits">
                  <h3>{{ branchIsDefault() ? 'Commits' : 'Commits only on this branch' }}</h3>
                  <ul class="skeleton-list" aria-hidden="true">
                    @for (row of contentSkeleton; track row) {
                      <li class="skeleton-row"><span class="skeleton-bar"></span></li>
                    }
                  </ul>
                </div>
              </div>
            </div>
            } @else {
            <div class="sheet-columns" [style.grid-template-columns]="sheetColumns()">
            <div class="sheet-stack" [style.grid-template-rows]="changesPaneHeight() + 'px 8px minmax(0, 1fr)'">
            <div data-testid="changes">
            <h3>Changes</h3>
            <ul data-testid="changed-files" gmOverlayScroll>
              @for (file of visibleFiles(); track file.path) {
                <li
                  data-testid="changed-file"
                  [class.is-selected]="isSelectedFile(file.path)"
                  [attr.data-path]="file.path"
                  [attr.data-previous-path]="file.previousPath ?? null"
                  (click)="selectFile(file.path)"
                >
                  <button type="button" (click)="selectFile(file.path)">{{ file.path }}</button>
                  @if (file.added !== null) {
                    <span data-testid="lines-added">{{ file.added }}</span>
                  }
                  @if (file.deleted !== null) {
                    <span data-testid="lines-deleted">{{ file.deleted }}</span>
                  }
                </li>
              }
            </ul>
            </div>
            <div
              class="splitter"
              role="separator"
              data-testid="commits-split"
              aria-orientation="horizontal"
              tabindex="0"
              (pointerdown)="beginCommitsSplit($event)"
              (pointermove)="moveSplit($event)"
              (pointerup)="endSplit($event)"
              (dblclick)="halveCommitsSplit()"
            ></div>
            <div data-testid="commits">
            @if (branchIsDefault()) {
              <h3>Commits</h3>
              <ul data-testid="recent-commits" gmOverlayScroll (scroll)="onCommitsScroll($event)">
                @for (commit of visibleRecentCommits(); track commit.sha ?? commit.subject) {
                  <li
                    data-testid="commit"
                    [class.is-selected]="isSelectedCommit(commit)"
                    [attr.data-sha]="commit.sha ?? null"
                    [attr.data-subject]="commit.subject"
                    (click)="selectCommit(commit.subject, commit.sha)"
                  >
                    <button type="button" (click)="selectCommit(commit.subject, commit.sha)">{{ commit.subject }}</button>
                  </li>
                }
              </ul>
            } @else {
              <h3>Commits only on this branch</h3>
              <ul data-testid="branch-commits" gmOverlayScroll (scroll)="onCommitsScroll($event)">
                @for (commit of visibleCommits(); track commit.sha ?? commit.subject) {
                  <li
                    data-testid="commit"
                    [class.is-selected]="isSelectedCommit(commit)"
                    [attr.data-sha]="commit.sha ?? null"
                    [attr.data-subject]="commit.subject"
                    (click)="selectCommit(commit.subject, commit.sha)"
                  >
                    <button type="button" (click)="selectCommit(commit.subject, commit.sha)">{{ commit.subject }}</button>
                  </li>
                }
              </ul>
            }
            </div>
            </div>
            @if (showDetail()) {
            <div
              class="splitter"
              role="separator"
              data-testid="changes-split"
              aria-orientation="vertical"
              tabindex="0"
              (pointerdown)="beginChangesSplit($event)"
              (pointermove)="moveSplit($event)"
              (pointerup)="endSplit($event)"
              (dblclick)="equalizeContentColumns($event)"
            ></div>
            @if (showingCommit() && visibleCommitFiles().length > 0) {
              <ul class="commit-files" data-testid="commit-files" gmOverlayScroll [style.width.px]="commitFileWidth()">
                @for (file of visibleCommitFiles(); track file.path) {
                  <li
                    data-testid="changed-file"
                    [class.is-selected]="isSelectedFile(file.path)"
                    [attr.data-path]="file.path"
                    [attr.data-previous-path]="file.previousPath ?? null"
                    (click)="selectCommitFile(file.path, $event)"
                  >
                    {{ file.path }}
                    @if (file.added !== null) {
                      <span data-testid="lines-added">{{ file.added }}</span>
                    }
                    @if (file.deleted !== null) {
                      <span data-testid="lines-deleted">{{ file.deleted }}</span>
                    }
                  </li>
                }
              </ul>
              <div
                class="splitter"
                role="separator"
                data-testid="commit-detail-split"
                aria-orientation="vertical"
                tabindex="0"
                (pointerdown)="beginCommitDetailSplit($event)"
                (pointermove)="moveSplit($event)"
                (pointerup)="endSplit($event)"
                (dblclick)="equalizeContentColumns($event)"
              ></div>
            }
            <div class="diff-pane">
              <div class="diff-toolbar">
                <div data-testid="diff-mode" role="group" aria-label="Diff">
                  <button type="button" data-testid="diff-mode-folded" [attr.aria-pressed]="diffMode() === 'folded'" (click)="chooseDiffMode('folded')">Folded</button>
                  <button type="button" data-testid="diff-mode-full" [attr.aria-pressed]="diffMode() === 'full'" (click)="chooseDiffMode('full')">Full file</button>
                </div>
                <div data-testid="diff-layout" role="group" aria-label="Layout">
                  <button type="button" data-testid="diff-layout-inline" [attr.aria-pressed]="diffLayout() === 'inline'" (click)="chooseDiffLayout('inline')">Inline</button>
                  <button type="button" data-testid="diff-layout-side" [attr.aria-pressed]="diffLayout() === 'side'" (click)="chooseDiffLayout('side')">Side by side</button>
                </div>
                @if (diffMode() === 'full') {
                  <div data-testid="diff-change-nav" role="group" aria-label="Change">
                    <button type="button" data-testid="diff-previous-change" [disabled]="!canJumpToChange('previous')" (click)="jumpToChange('previous')">Previous change</button>
                    <button type="button" data-testid="diff-next-change" [disabled]="!canJumpToChange('next')" (click)="jumpToChange('next')">Next change</button>
                  </div>
                }
              </div>
            @if (showDiffTooLarge()) {
              <p data-testid="diff-too-large">This file is too large to show</p>
            } @else if (showInlineDiff()) {
              <div class="diff-body">
              <div #diffScroller data-testid="diff" class="diff-view" [class.is-side]="diffLayout() === 'side'" gmOverlayScroll (scroll)="onDiffScroll($event)">
                @if (foldedDiff().previousPath; as previousPath) {
                  <p data-testid="diff-rename" [style.height.px]="diffRowHeight" [style.lineHeight.px]="diffRowHeight">Renamed from {{ previousPath }}</p>
                }
                @if (foldedDiff().binary) {
                  <p data-testid="diff-binary" [style.height.px]="diffRowHeight" [style.lineHeight.px]="diffRowHeight">Binary file</p>
                }
                @if (diffBodyHeight() > 0) {
                  <div class="diff-rows" [style.height.px]="diffBodyHeight()">
                    <div class="diff-window" [class.is-side]="diffLayout() === 'side'" [style.transform]="diffWindowTransform()">
                      @for (row of visibleDiffRows(); track row.index) {
                        @if (row.kind === 'fold') {
                          <div data-testid="diff-fold" [style.height.px]="diffFoldHeight" [style.lineHeight.px]="diffRowHeight">
                            @if (row.fold?.tooLarge) {
                              <div data-testid="diff-fold-too-large">This file is too large to show</div>
                            }
                            <div data-testid="diff-fold-count">{{ row.fold?.label }}</div>
                            <div>
                              <button type="button" data-testid="diff-fold-more" (click)="revealFold(row, 'more')">3 more lines</button>
                              <button type="button" data-testid="diff-fold-all" (click)="revealFold(row, 'all')">All lines</button>
                            </div>
                          </div>
                        } @else if (row.side; as side) {
                          <div
                            data-testid="diff-side-row"
                            [style.height.px]="diffRowHeight"
                            [style.lineHeight.px]="diffRowHeight"
                          >
                            <div data-testid="diff-side-old" [attr.data-kind]="side.old.kind" [style.width]="diffSideOldWidth()">
                              @if (side.old.kind !== 'empty') {
                                <span data-testid="diff-old-number">{{ side.old.number ?? '' }}</span>
                              }
                              <span class="diff-code" [style.transform]="diffSideShift()">
                                @for (span of side.old.spans; track $index) {
                                  <span [attr.data-changed]="span.changed ? 'true' : 'false'">{{ span.text }}</span>
                                }
                              </span>
                            </div>
                            <div
                              class="splitter"
                              role="separator"
                              data-testid="diff-side-split"
                              aria-orientation="vertical"
                              tabindex="0"
                              (pointerdown)="beginDiffSideSplit($event)"
                              (pointermove)="moveDiffSideSplit($event)"
                              (pointerup)="endDiffSideSplit($event)"
                              (dblclick)="equalizeDiffSides()"
                            ></div>
                            <div data-testid="diff-side-new" [attr.data-kind]="side.new.kind">
                              @if (side.new.kind !== 'empty') {
                                <span data-testid="diff-new-number">{{ side.new.number ?? '' }}</span>
                              }
                              <span class="diff-code" [style.transform]="diffSideShift()">
                                @for (span of side.new.spans; track $index) {
                                  <span [attr.data-changed]="span.changed ? 'true' : 'false'">{{ span.text }}</span>
                                }
                              </span>
                            </div>
                          </div>
                        } @else if (row.line; as line) {
                          <div
                            data-testid="diff-line"
                            [attr.data-kind]="line.kind"
                            [style.height.px]="diffRowHeight"
                            [style.lineHeight.px]="diffRowHeight"
                          >
                            <span data-testid="diff-old-number">{{ line.oldNumber ?? '' }}</span>
                            <span data-testid="diff-new-number">{{ line.newNumber ?? '' }}</span>
                            <span class="diff-code">
                              @for (span of line.spans; track $index) {
                                <span [attr.data-changed]="span.changed ? 'true' : 'false'">{{ span.text }}</span>
                              }
                            </span>
                          </div>
                        }
                      }
                    </div>
                  </div>
                }
              </div>
              @if (diffLayout() === 'side') {
                <div class="diff-side-scroll-row" [style.--diff-side-share]="diffSideShare()">
                  <div data-testid="diff-side-scroll" (scroll)="scrollDiffSides($event)">
                    <div [style.width.ch]="maxSideChars()"></div>
                  </div>
                </div>
              }
              </div>
            } @else {
              <p data-testid="empty-diff">No diff for this file</p>
            }
            </div>
            }
            </div>
            }
            }
            @if (showTerminalRow()) {
              <ng-container [ngTemplateOutlet]="worktreeTerminalSection" />
            }
            </div>
          } @else if (worktreesLoading()) {
            <div class="content-skeleton" data-testid="content-skeleton" aria-busy="true" aria-label="Loading worktree">
              <span class="skeleton-bar skeleton-title"></span>
              <span class="skeleton-bar"></span>
              <span class="skeleton-bar skeleton-short"></span>
            </div>
          } @else {
            <p class="empty-sheet">Select a branch</p>
          }
          } @else if (terminalsWorktree(); as chosen) {
            <ng-container
              [ngTemplateOutlet]="branchHeading"
              [ngTemplateOutletContext]="{ name: chosen.branch, summary: false }"
            />
            <div #sheetBody class="sheet-body" [style.grid-template-rows]="'minmax(0, 1fr)'">
              <ng-container [ngTemplateOutlet]="worktreeTerminalSection" />
            </div>
          }
          <ng-template #branchHeading let-name="name" let-summary="summary">
            <header
              class="branch-heading"
              data-testid="branch-heading"
              [attr.aria-busy]="summary && contentLoading() ? true : null"
            >
              <div class="branch-title">
                <h2>
                  <button
                    type="button"
                    data-testid="copy-branch-name"
                    title="Copy branch name"
                    (click)="copyBranchName(name)"
                  >
                    {{ name }}
                    <svg data-testid="copy-branch-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
                      <path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
                    </svg>
                  </button>
                </h2>
                <button type="button" data-testid="open-ide" [disabled]="ideCommand() === ''" (click)="openIde()">
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path fill="currentColor" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.5 0h3a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0V4.56L8.28 8.78a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l4.22-4.22H10.25a.75.75 0 0 1 0-1.5Z" />
                  </svg>
                  IDE
                </button>
              </div>
              @if (summary) {
                <p data-testid="heading-summary">
                  @if (contentLoading()) {
                    <span class="skeleton-bar heading-skeleton" data-testid="heading-skeleton" aria-hidden="true"></span>
                  } @else if (headingCommitCount() !== null) {
                    {{ headingCommitCount() }} commits · {{ visibleFiles().length }} changed files
                  } @else {
                    {{ visibleFiles().length }} changed files
                  }
                </p>
              }
            </header>
          </ng-template>
          <ng-template #worktreeTerminalSection>
              @if (terminalExpanded() && !terminalMaximized()) {
                <div
                  class="splitter"
                  role="separator"
                  data-testid="terminal-split"
                  aria-orientation="horizontal"
                  tabindex="0"
                  (pointerdown)="beginTerminalSplit($event)"
                  (pointermove)="moveSplit($event)"
                  (pointerup)="endSplit($event)"
                  (dblclick)="equalizeTerminalRow($event)"
                ></div>
              }
              <div class="terminal-row" data-testid="terminal-row">
                <div class="terminal-chrome" data-testid="terminal-header">
                  @if (!terminalsOpen()) {
                  <button
                    type="button"
                    data-testid="terminal-collapse"
                    [attr.aria-label]="terminalExpanded() ? 'Collapse terminal' : 'Expand terminal'"
                    (click)="toggleTerminalRow()"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      @if (terminalExpanded()) {
                        <path fill="currentColor" d="M4.47 5.47a.75.75 0 0 1 1.06 0L8 7.94l2.47-2.47a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 0-1.06Z" />
                      } @else {
                        <path fill="currentColor" d="M4.47 10.53a.75.75 0 0 0 1.06 0L8 8.06l2.47 2.47a.75.75 0 1 0 1.06-1.06l-3-3a.75.75 0 0 0-1.06 0l-3 3a.75.75 0 0 0 0 1.06Z" />
                      }
                    </svg>
                  </button>
                  }
                  @if (!terminalExpanded() && terminalCount(selectedBranchName() ?? '') > 0) {
                    <span data-testid="terminal-running-count">{{ terminalCount(selectedBranchName() ?? '') }}</span>
                  }
                  <div class="terminal-tabs" role="tablist">
                    @for (tab of terminalTabs(); track tab.id; let index = $index) {
                      <div
                        class="terminal-tab"
                        role="tab"
                        tabindex="0"
                        data-testid="terminal-tab"
                        [attr.aria-selected]="tab.id === focusedTerminalTab()?.id"
                        [attr.title]="tabTooltip(tab)"
                        [class.is-kill-visible]="isTabKillVisible(tab)"
                        (mouseenter)="hoverTab(tab.id)"
                        (mouseleave)="leaveTab(tab.id)"
                        (click)="focusTab(tab.id)"
                        (keydown)="onTabKeydown($event, tab.id)"
                        (contextmenu)="openTerminalMenu($event, tab.id, null)"
                      >
                        @if (isRenamingTab(tab)) {
                          <input
                            data-testid="terminal-name-input"
                            [value]="renameValue()"
                            (click)="$event.stopPropagation()"
                            (input)="setRenameValue($event)"
                            (keydown.enter)="commitRename($event)"
                            (keydown.escape)="cancelRename($event)"
                          />
                        } @else {
                          @if (tabChip(index + 1, tab); as chip) {
                            <span class="terminal-tab-label" data-testid="terminal-tab-label">
                              <span class="terminal-tab-index" data-testid="terminal-tab-index">{{ chip.positionText }}</span>
                              @if (chip.names; as names) {
                                <span class="terminal-tab-gap">{{ chipGap }}</span>
                                @for (name of names; track name.terminalId; let first = $first) {
                                  @if (!first) {
                                    <span class="terminal-tab-separator" data-testid="terminal-tab-separator">{{ chipSeparator }}</span>
                                  }
                                  <span
                                    class="terminal-tab-name"
                                    data-testid="terminal-tab-name"
                                    [attr.data-terminal-id]="name.terminalId"
                                    [class.is-pointed]="pointedTerminalId() === name.terminalId"
                                    (mouseenter)="pointTerminal(name.terminalId)"
                                    (mouseleave)="clearPointedTerminal(name.terminalId)"
                                    (click)="focusNamedTerminal($event, tab.id, name.terminalId)"
                                    (contextmenu)="openTerminalMenu($event, tab.id, name.terminalId)"
                                  >{{ name.text }}</span>
                                }
                              } @else if (chip.label; as label) {
                                <span class="terminal-tab-gap">{{ chipGap }}</span>
                                <span class="terminal-tab-text">{{ label }}</span>
                              }
                            </span>
                          }
                        }
                        <button
                          type="button"
                          class="terminal-tab-kill"
                          data-testid="terminal-tab-kill"
                          title="Kill"
                          aria-label="Kill"
                          [attr.tabindex]="isTabKillVisible(tab) ? 0 : -1"
                          [attr.aria-hidden]="isTabKillVisible(tab) ? null : true"
                          (click)="killTabFromButton($event, tab.id)"
                        >
                          <ng-container [ngTemplateOutlet]="terminalKillIcon" />
                        </button>
                      </div>
                    }
                  </div>
                  @if (showRunPreset()) {
                    <button
                      type="button"
                      class="terminal-icon terminal-run-preset"
                      data-testid="terminal-run-preset"
                      title="Run preset"
                      aria-label="Run preset"
                      (click)="runPreset($event)"
                    >
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path fill="currentColor" d="M4.5 2.2v11.6L13.2 8Z" />
                      </svg>
                    </button>
                  }
                  <button
                    type="button"
                    class="terminal-icon"
                    data-testid="terminal-split-button"
                    title="Split"
                    aria-label="Split"
                    [disabled]="splitUnavailable()"
                    (click)="splitTerminal()"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M1.5 1.75A1.75 1.75 0 0 1 3.25 0h9.5C13.216 0 14 .784 14 1.75v12.5A1.75 1.75 0 0 1 12.75 16h-9.5A1.75 1.75 0 0 1 1.5 14.25ZM3.25 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25H7v-13Zm9.5 13a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H8.5v13Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="terminal-icon"
                    data-testid="terminal-new"
                    title="New"
                    aria-label="New"
                    (click)="newTerminal()"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
                    </svg>
                  </button>
                  @if (!terminalsOpen()) {
                  <button
                    type="button"
                    class="terminal-icon"
                    data-testid="terminal-maximize"
                    [attr.title]="terminalMaximized() ? 'Restore terminal' : 'Maximize terminal'"
                    [attr.aria-label]="terminalMaximized() ? 'Restore terminal' : 'Maximize terminal'"
                    (click)="toggleTerminalMaximize()"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      @if (terminalMaximized()) {
                        <path fill="currentColor" d="M5.25 2A1.75 1.75 0 0 0 3.5 3.75v.5a.75.75 0 0 1-1.5 0v-.5C2 2.231 3.231 1 4.75 1h.5a.75.75 0 0 1 0 1.5h-.5ZM2 6.25a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 2 6.25Zm0 3.5a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Zm.75 2.75a.75.75 0 0 0-1.5 0v.5c0 1.519 1.231 2.75 2.75 2.75h.5a.75.75 0 0 0 0-1.5h-.5a1.25 1.25 0 0 1-1.25-1.25v-.5ZM6.25 14a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1-.75-.75Zm4.5 0a.75.75 0 0 1 .75-.75h.5a1.25 1.25 0 0 0 1.25-1.25v-.5a.75.75 0 0 1 1.5 0v.5A2.75 2.75 0 0 1 11.75 15h-.5a.75.75 0 0 1-.75-.75Zm3.25-9.5a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75ZM14 6.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75Zm0 3.5a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75ZM8.75 2a.75.75 0 0 1 0-1.5h2A2.75 2.75 0 0 1 13.5 3.25v.5a.75.75 0 0 1-1.5 0v-.5c0-.69-.56-1.25-1.25-1.25h-2Z" />
                      } @else {
                        <path fill="currentColor" d="M1.75 10a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5a.75.75 0 0 1 .75-.75Zm12.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 13.25 15h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 .75-.75ZM4.25 2a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0v-2.5C2.5 1.784 3.284 1 4.25 1h2.5a.75.75 0 0 1 0 1.5ZM10 1.75a.75.75 0 0 1 .75-.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1-.75-.75Z" />
                      }
                    </svg>
                  </button>
                  }
                  <button
                    type="button"
                    class="terminal-icon"
                    data-testid="terminal-kill"
                    title="Kill"
                    aria-label="Kill"
                    (click)="killFocusedTerminal()"
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
                    </svg>
                  </button>
                </div>
                @if (terminalExpanded()) {
                  @if (focusedTerminalTab(); as tab) {
                    @if (tab.terminals.length < 2) {
                      @for (terminal of tab.terminals; track terminal.id) {
                        <ng-container
                          [ngTemplateOutlet]="terminalHost"
                          [ngTemplateOutletContext]="{ terminal: terminal, tab: tab, column: 0 }"
                        />
                      }
                    } @else {
                      <div class="terminal-panes" [style.height.px]="terminalBodyHeight()">
                        @for (terminal of tab.terminals; track terminal.id; let index = $index; let last = $last) {
                          <div class="terminal-pane-column" [style.flex-grow]="columnGrow(tab, index)">
                            <div
                              class="terminal-pane-header"
                              data-testid="terminal-pane-header"
                              [attr.title]="terminalHostTitle(terminal.host)"
                              [class.is-kill-visible]="isPaneKillVisible(tab.id, terminal.id)"
                              (mouseenter)="hoverPane(terminal.id)"
                              (mouseleave)="leavePane(terminal.id)"
                              (contextmenu)="openTerminalMenu($event, tab.id, terminal.id)"
                            >
                              @if (isRenamingTerminal(tab.id, terminal.id)) {
                                <input
                                  data-testid="terminal-name-input"
                                  [value]="renameValue()"
                                  (input)="setRenameValue($event)"
                                  (keydown.enter)="commitRename($event)"
                                  (keydown.escape)="cancelRename($event)"
                                />
                              } @else {
                                <span class="terminal-pane-name">{{ terminalDisplayName(terminal) }}</span>
                              }
                              <button
                                type="button"
                                class="terminal-pane-kill"
                                data-testid="terminal-pane-kill"
                                title="Kill"
                                aria-label="Kill"
                                [attr.tabindex]="isPaneKillVisible(tab.id, terminal.id) ? 0 : -1"
                                [attr.aria-hidden]="isPaneKillVisible(tab.id, terminal.id) ? null : true"
                                (click)="killPaneFromButton($event, tab.id, terminal.id)"
                              >
                                <ng-container [ngTemplateOutlet]="terminalKillIcon" />
                              </button>
                            </div>
                            <ng-container
                              [ngTemplateOutlet]="terminalHost"
                              [ngTemplateOutletContext]="{ terminal: terminal, tab: tab, column: index }"
                            />
                          </div>
                          @if (!last) {
                            <div
                              class="splitter"
                              role="separator"
                              data-testid="terminal-pane-split"
                              aria-orientation="vertical"
                              tabindex="0"
                              (pointerdown)="beginPaneSplit($event)"
                              (dblclick)="equalizePaneSplit()"
                            ></div>
                          }
                        }
                      </div>
                    }
                  }
                }
              </div>
              <ng-template #terminalKillIcon>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </ng-template>
              <ng-template #terminalHost let-terminal="terminal" let-tab="tab" let-column="column">
                <gm-terminal-host
                  [terminal]="terminal"
                  [background]="terminalBackground()"
                  [foreground]="terminalForeground()"
                  [fontFamily]="terminalFontFamily()"
                  [paneHeight]="terminalPaneHeight()"
                  [column]="column"
                  [active]="tab.focusedTerminalId === terminal.id"
                  (terminalEnded)="onTerminalEnded(terminal.id)"
                  (contextMenu)="openPaneMenu($event, tab, terminal.id)"
                  (paneFocus)="focusTerminal(tab.id, terminal.id)"
                />
              </ng-template>
          </ng-template>
        </section>
      </main>
      @if (overlayOpen()) {
        <div class="start-screen switching-overlay" data-testid="switching-overlay" (click)="closeSwitchOutside($event)">
          <ng-container [ngTemplateOutlet]="repositoryCard" />
        </div>
      }
    }
    @if (createDialogOpen()) {
      <div data-testid="create-worktree-dialog" role="dialog" aria-label="Create worktree" (click)="dismissCreateFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll [attr.aria-busy]="branchNamesLoading() || creatingWorktree() ? true : null" (click)="$event.stopPropagation()">
          <h2>Create worktree<button type="button" data-testid="create-worktree-info" title="A new name creates a local branch from the primary checkout, with no upstream. A remote-only branch is fetched first. Pre-create hooks run before the worktree is added. Post-create hooks run after checkout." aria-label="About creating a worktree"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path fill="currentColor" d="M7.2 7.1h1.6V12H7.2zM7.2 4.2h1.6v1.6H7.2z"></path></svg></button></h2>
          <label>
            New branch
            <input
              data-testid="create-branch"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="create-branch-options"
              placeholder="New branch name"
              [disabled]="branchNamesLoading()"
              [value]="createBranchName()"
              (input)="setCreateBranchName($event)"
            />
          </label>
          @if (branchNamesLoading()) {
            <p data-testid="loading-branches">Loading branches</p>
          } @else if (createBranchOptions().length > 0) {
            <div class="existing-branches">
              <h3 id="existing-branches-heading" data-testid="existing-branches-heading">Existing branches</h3>
              <ul
                id="create-branch-options"
                data-testid="create-branch-options"
                gmOverlayScroll
                role="listbox"
                aria-labelledby="existing-branches-heading"
              >
                @for (name of createBranchOptions(); track name) {
                  <li
                    data-testid="create-branch-option"
                    role="option"
                    [attr.data-branch]="name"
                    (click)="chooseCreateBranch(name)"
                  >{{ name }}</li>
                }
              </ul>
            </div>
          }
          <p data-testid="create-layout">{{ createLayoutLine() }}</p>
          @if (workspaceError(); as message) {
            <p data-testid="workspace-error">{{ message }}</p>
          }
          <div class="dialog-actions">
            <button type="button" data-testid="confirm-create-worktree" [disabled]="branchNamesLoading()" (click)="createBranch()">{{ creatingWorktree() ? 'Creating worktree' : 'Create worktree' }}</button>
            <button type="button" data-testid="cancel-create-worktree" (click)="cancelCreate()">Cancel</button>
          </div>
        </section>
      </div>
    }
    @if (mergeDialogBranch()) {
      <div data-testid="merge-into-master-dialog" role="dialog" aria-label="Merge into master" (click)="dismissMergeFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>Merge into master</h2>
          @if (branchActivity()?.label === 'Merging into master') {
            <p data-testid="merge-activity">Merging into master</p>
          }
          <label>
            Squash
            <input
              data-testid="squash"
              type="checkbox"
              [checked]="mergeSquash()"
              (change)="setMergeSquash($event)"
            />
          </label>
          @if (workspaceError(); as message) {
            <p data-testid="workspace-error">{{ message }}</p>
          }
          <div class="dialog-actions">
            <button type="button" data-testid="confirm-merge-into-master" (click)="confirmMerge()">{{ branchActivity()?.label === 'Merging into master' ? 'Merging into master' : 'Merge into master' }}</button>
            <button type="button" data-testid="cancel-merge-into-master" (click)="cancelMerge()">Cancel</button>
          </div>
        </section>
      </div>
    }
    @if (removeDialogBranch(); as branch) {
      <div data-testid="remove-worktree-dialog" role="dialog" aria-label="Remove worktree" (click)="dismissRemoveFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>Remove worktree</h2>
          @if (branchActivity()?.label === 'Removing worktree') {
            <p data-testid="remove-activity">Removing worktree</p>
          }
          <p data-testid="remove-worktree-branch">{{ branch }}</p>
          <p data-testid="remove-worktree-note">
            The checkout goes away. Keep the local branch, or delete it. A remote branch stays. Deleting the local branch removes it even when it is not merged. Pre-remove hooks run before the checkout is deleted. Post-remove hooks run after.
          </p>
          @if (workspaceError(); as message) {
            <p data-testid="workspace-error">{{ message }}</p>
          }
          <div class="dialog-actions">
            <button type="button" data-testid="confirm-remove-worktree" [disabled]="branchActivity()?.label === 'Removing worktree'" (click)="confirmRemoveWorktree(false)">Keep branch</button>
            <button type="button" data-testid="confirm-delete-branch" [class.is-danger]="removeForceDelete()" [disabled]="branchActivity()?.label === 'Removing worktree'" (click)="confirmRemoveWorktree(true)">{{ removeForceDelete() ? 'Force delete branch' : 'Delete local branch' }}</button>
            <button type="button" data-testid="cancel-remove-worktree" [disabled]="branchActivity()?.label === 'Removing worktree'" (click)="cancelRemove()">Cancel</button>
          </div>
        </section>
      </div>
    }
    @if (appSettingsOpen()) {
      <div data-testid="app-settings-dialog" role="dialog" aria-label="App settings" (click)="dismissAppSettingsFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>App settings</h2>
          <h3 data-testid="default-layout-heading">Default layout</h3>
          <label>
            <input
              type="radio"
              name="default-layout"
              value="workspaces"
              [checked]="defaultLayout() === 'workspaces'"
              (change)="chooseDefaultLayout('workspaces')"
            />
            Workspaces
          </label>
          <label>
            <input
              type="radio"
              name="default-layout"
              value="sibling"
              [checked]="defaultLayout() === 'sibling'"
              (change)="chooseDefaultLayout('sibling')"
            />
            Sibling
          </label>
          <h3 data-testid="terminal-mode-heading">Terminal mode</h3>
          <label>
            <input
              type="radio"
              name="terminal-mode"
              data-testid="terminal-mode-none"
              [checked]="terminalMode() === 'none'"
              (click)="requestTerminalMode('none', $event)"
            />
            None
          </label>
          <div class="terminal-option">
            <label>
              <input
                type="radio"
                name="terminal-mode"
                data-testid="terminal-mode-terminal"
                [checked]="terminalMode() === 'terminal'"
                (click)="requestTerminalMode('terminal', $event)"
              />
              Terminal
            </label>
            <button type="button" data-testid="edit-shell-command" (click)="beginShellCommandEdit($event)">Edit</button>
          </div>
          @if (shellCommandEditing()) {
            <label class="terminal-font-field">
              Shell command
              <input
                type="text"
                data-testid="terminal-shell-command"
                [value]="shellCommandDraft()"
                (input)="chooseShellCommand($event)"
              />
            </label>
          }
          <label [attr.title]="tmuxInstalled() ? null : 'tmux is not installed'">
            <input
              type="radio"
              name="terminal-mode"
              data-testid="terminal-mode-tmux"
              [disabled]="!tmuxInstalled()"
              [attr.title]="tmuxInstalled() ? null : 'tmux is not installed'"
              [checked]="terminalMode() === 'tmux'"
              (click)="requestTerminalMode('tmux', $event)"
            />
            Tmux
          </label>
          <label class="ide-command-field">
            IDE command
            <input
              type="text"
              data-testid="ide-command"
              [value]="ideCommand()"
              (input)="chooseIdeCommand($event)"
            />
          </label>
          <label class="terminal-font-field">
            Font family
            <input
              type="text"
              data-testid="terminal-font"
              [value]="terminalFont()"
              (input)="chooseTerminalFont($event)"
            />
          </label>
          <h3 data-testid="colors-heading">Colors</h3>
          <div class="color-choice">
            <span>Sidebar</span>
            <div class="color-swatches">
              @for (swatch of sidebarColorSwatches; track swatch.color) {
                <button
                  type="button"
                  data-testid="sidebar-swatch"
                  [attr.data-color]="swatch.color"
                  [attr.aria-label]="swatch.name"
                  [class.is-selected]="isSelectedColor(sidebarColor(), swatch.color)"
                  [style.background-color]="swatch.color"
                  (click)="chooseSidebarSwatch(swatch.color)"
                ></button>
              }
              <span class="custom-color">
                Custom
                <input
                  type="color"
                  data-testid="sidebar-color"
                  aria-label="Custom sidebar color"
                  [value]="sidebarColor()"
                  (input)="chooseSidebarColor($event)"
                  (change)="chooseSidebarColor($event)"
                />
              </span>
            </div>
          </div>
          <div class="color-choice">
            <span>Sidebar text</span>
            <div class="sidebar-text-choices">
              <label>
                <input
                  type="radio"
                  name="sidebar-text"
                  data-testid="sidebar-text-white"
                  [checked]="sidebarText() === 'white'"
                  (click)="chooseSidebarText('white')"
                />
                White
              </label>
              <label>
                <input
                  type="radio"
                  name="sidebar-text"
                  data-testid="sidebar-text-black"
                  [checked]="sidebarText() === 'black'"
                  (click)="chooseSidebarText('black')"
                />
                Black
              </label>
            </div>
          </div>
          <div class="color-choice">
            <span>Content</span>
            <div class="color-swatches">
              @for (swatch of contentColorSwatches; track swatch.color) {
                <button
                  type="button"
                  data-testid="content-swatch"
                  [attr.data-color]="swatch.color"
                  [attr.aria-label]="swatch.name"
                  [class.is-selected]="isSelectedColor(contentColor(), swatch.color)"
                  [style.background-color]="swatch.color"
                  (click)="chooseContentSwatch(swatch.color)"
                ></button>
              }
              <span class="custom-color">
                Custom
                <input
                  type="color"
                  data-testid="content-color"
                  aria-label="Custom content color"
                  [value]="contentColor()"
                  (input)="chooseContentColor($event)"
                  (change)="chooseContentColor($event)"
                />
              </span>
            </div>
          </div>
          <div class="color-choice">
            <span>Terminal background</span>
            <div class="color-swatches">
              @for (swatch of terminalBackgroundSwatches; track swatch.color) {
                <button
                  type="button"
                  data-testid="terminal-background-swatch"
                  [attr.data-color]="swatch.color"
                  [attr.aria-label]="swatch.name"
                  [class.is-selected]="isSelectedColor(terminalBackground(), swatch.color)"
                  [style.background-color]="swatch.color"
                  (click)="chooseTerminalBackgroundSwatch(swatch.color)"
                ></button>
              }
              <span class="custom-color">
                Custom
                <input
                  type="color"
                  data-testid="terminal-background-color"
                  aria-label="Custom terminal background"
                  [value]="terminalBackground()"
                  (input)="chooseTerminalBackground($event)"
                  (change)="chooseTerminalBackground($event)"
                />
              </span>
            </div>
          </div>
          <div class="color-choice">
            <span>Terminal foreground</span>
            <div class="color-swatches">
              @for (swatch of terminalForegroundSwatches; track swatch.color) {
                <button
                  type="button"
                  data-testid="terminal-foreground-swatch"
                  [attr.data-color]="swatch.color"
                  [attr.aria-label]="swatch.name"
                  [class.is-selected]="isSelectedColor(terminalForeground(), swatch.color)"
                  [style.background-color]="swatch.color"
                  (click)="chooseTerminalForegroundSwatch(swatch.color)"
                ></button>
              }
              <span class="custom-color">
                Custom
                <input
                  type="color"
                  data-testid="terminal-foreground-color"
                  aria-label="Custom terminal foreground"
                  [value]="terminalForeground()"
                  (input)="chooseTerminalForeground($event)"
                  (change)="chooseTerminalForeground($event)"
                />
              </span>
            </div>
          </div>
          <div class="dialog-actions">
            <button type="button" data-testid="reset-colors" (click)="resetColors()">Reset</button>
            <button type="button" data-testid="close-app-settings" (click)="closeAppSettings()">Close</button>
          </div>
        </section>
      </div>
    }
    @if (oldSessionChoices().length > 0) {
      <div data-testid="old-session-dialog" role="dialog" aria-label="Old tmux sessions" (click)="dismissOldSessionsFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>Old tmux sessions</h2>
          <p>These sessions were created before a branch was recorded, and each name matches more than one branch.</p>
          @for (session of oldSessionChoices(); track session.name) {
            <div data-testid="old-session" [attr.data-session]="session.name">
              <p>{{ session.name }}</p>
              <div class="dialog-actions">
                @for (branch of session.branches; track branch) {
                  <button type="button" data-testid="old-session-branch" [attr.data-branch]="branch" (click)="keepOldSession(session.name, branch)">{{ branch }}</button>
                }
                <button type="button" data-testid="old-session-kill" (click)="killOldSession(session.name)">Kill</button>
                <button type="button" data-testid="old-session-leave" (click)="leaveOldSession(session.name)">Leave unchanged</button>
              </div>
            </div>
          }
        </section>
      </div>
    }
    @if (pendingTerminalMode() !== null) {
      <div data-testid="terminal-mode-dialog" role="dialog" aria-label="Terminal mode" (click)="dismissTerminalModeFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>Terminal mode</h2>
          <p>Keep the terminals that are still running, or kill them?</p>
          <div class="dialog-actions">
            <button type="button" data-testid="terminal-mode-keep" (click)="keepTerminalMode()">Keep</button>
            <button type="button" data-testid="terminal-mode-kill" (click)="killTerminalMode()">Kill</button>
            <button type="button" data-testid="terminal-mode-cancel" (click)="cancelTerminalMode()">Cancel</button>
          </div>
        </section>
      </div>
    }
    @if (addDialogOpen()) {
      <div data-testid="add-repository-dialog" role="dialog" aria-label="Add repository" (click)="dismissAddFromBackdrop($event)">
        <section class="dialog-panel" gmOverlayScroll (click)="$event.stopPropagation()">
          <h2>Add repository</h2>
          <label>
            Location
            <span class="location-field">
              <input
                data-testid="add-repository-path"
                [value]="addPath()"
                placeholder="Choose folder"
                (input)="setAddPath($event)"
              />
              <button type="button" data-testid="browse-repository-folder" aria-label="Choose folder" (click)="browseFolder()">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M1.75 1.5h3.13c.6 0 1.17.3 1.5.8l.72 1.08a.25.25 0 0 0 .21.12h7a1.75 1.75 0 0 1 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 14.5H1.75A1.75 1.75 0 0 1 0 12.75v-9.5A1.75 1.75 0 0 1 1.75 1.5z" />
                </svg>
              </button>
            </span>
          </label>
          @if (cardError(); as message) {
            <p data-testid="card-error">{{ message }}</p>
          }
          <label>
            Display name
            <input data-testid="add-repository-name" [value]="addName()" (input)="setAddName($event)" />
          </label>
          <div class="dialog-actions">
            <button type="button" data-testid="confirm-add-repository" [disabled]="cardError() !== null" (click)="addRegistered()">Add repository</button>
            <button type="button" data-testid="cancel-add-repository" (click)="cancelAdd()">Cancel</button>
          </div>
        </section>
      </div>
    }
    @if (repositoryTabMenu(); as menu) {
      <div
        class="repository-tab-menu"
        data-testid="repository-tab-menu"
        role="menu"
        [style.left.px]="menu.x"
        [style.top.px]="menu.y"
      >
        <button type="button" role="menuitem" data-testid="repository-tab-settings" (click)="openRepositoryTabSettings()">
          Repository settings
        </button>
        <button type="button" role="menuitem" data-testid="repository-tab-close" (click)="closeRepositoryTab(menu.path)">
          Close
        </button>
      </div>
    }
    @if (presetMenu(); as menu) {
      <div
        class="terminal-menu"
        data-testid="preset-menu"
        role="menu"
        aria-label="Run preset"
        [style.left.px]="menu.x"
        [style.top.px]="menu.y"
      >
        @for (name of menu.names; track $index) {
          <button type="button" role="menuitem" data-testid="preset-menu-item" (click)="choosePreset($index)">
            {{ name }}
          </button>
        }
      </div>
    }
    @if (terminalMenu(); as menu) {
      @if (menuActions(); as actions) {
        <div
          class="terminal-menu"
          data-testid="terminal-menu"
          role="menu"
          [style.left.px]="menu.x"
          [style.top.px]="menu.y"
          (mouseover)="hoverTerminalMenu($event)"
        >
          <button type="button" role="menuitem" data-testid="terminal-rename" (click)="beginRename()">Rename</button>
          <button type="button" role="menuitem" data-testid="terminal-menu-kill" (click)="killFromMenu()">Kill</button>
          @if (actions.split) {
            <button
              type="button"
              role="menuitem"
              data-testid="terminal-menu-split"
              [disabled]="actions.splitDisabled"
              (click)="splitFromMenu()"
            >
              Split
            </button>
          }
          @if (actions.unsplit) {
            <button type="button" role="menuitem" data-testid="terminal-menu-unsplit" (click)="unsplitFromMenu()">
              Unsplit
            </button>
          }
          @if (actions.swap) {
            <button type="button" role="menuitem" data-testid="terminal-menu-swap" (click)="swapFromMenu()">
              Swap
            </button>
          }
          @if (moveTargets().length > 0) {
            <button
              type="button"
              role="menuitem"
              data-testid="terminal-menu-move"
              aria-haspopup="menu"
              [attr.aria-expanded]="moveSubmenuOpen()"
              (mouseenter)="showMoveSubmenu()"
              (mouseleave)="scheduleHideMoveSubmenu()"
            >
              Move to
            </button>
          }
        </div>
        @if (moveSubmenuOpen() && moveTargets().length > 0) {
          <div
            class="terminal-menu terminal-submenu"
            data-testid="terminal-menu-move-submenu"
            role="menu"
            aria-label="Move to"
            (mouseenter)="showMoveSubmenu()"
            (mouseleave)="scheduleHideMoveSubmenu()"
          >
            @for (target of moveTargets(); track target.tabId) {
              <button
                type="button"
                role="menuitem"
                data-testid="terminal-menu-move-target"
                (click)="moveTerminalTo(target.tabId)"
              >
                {{ target.label }}
              </button>
            }
          </div>
        }
      }
    }
    @if (repositorySettings()?.settingsDialog(); as settingsDialog) {
      <ng-container [ngTemplateOutlet]="settingsDialog" />
    }
  `,
})
export class WorkspaceComponent implements OnInit, OnDestroy, AfterViewInit, AfterViewChecked {
  private readonly zone = inject(NgZone);
  private readonly repositorySettings = viewChild(RepositorySettings);
  readonly repositoryPath = input<string | null>(null);
  readonly liveRegistry = input(false);
  readonly platform = input(hostPlatform());
  readonly tmuxInstalled = input(tmuxIsInstalled());
  readonly selectedName = signal<string | null>(null);
  readonly openedPath = signal<string | null>(null);
  readonly registered = signal<RegisteredRepository[]>([]);
  readonly addDialogOpen = signal(false);
  readonly addPath = signal('');
  readonly addName = signal('');
  readonly addNameTouched = signal(false);
  readonly cardError = signal<string | null>(null);
  readonly openError = signal<string | null>(null);
  readonly openingRepository = signal<string | null>(null);
  readonly branchNamesLoading = signal(false);
  readonly creatingWorktree = signal(false);
  readonly contentLoading = signal(false);
  readonly branchActivity = signal<{ branch: string; label: string } | null>(null);
  readonly tmuxSessionRecords = signal<TmuxSessionRecord[]>([]);
  readonly overlayOpen = signal(false);
  readonly repositoryTabs = signal<RepositoryTab[]>([]);
  readonly terminalsOpen = signal(false);
  readonly terminalGroups = computed(() => {
    this.storedTerminalEpoch();
    const sessions = this.tmuxSessionRecords();
    const current = this.effectivePath();
    const liveTerminals = this.terminalsByBranch();
    const liveBranches = this.branches();
    return this.repositoryTabs().flatMap((tab) => {
      const saved = this.repositoryWorkspaces.get(tab.path);
      const branches = tab.path === current ? liveBranches : (saved?.branches ?? []);
      const terminals = tab.path === current ? liveTerminals : (saved?.terminalsByBranch ?? {});
      const rows = branches.flatMap((branch) => {
        const count = countBranchTerminals(tab.path, branch.name, terminals[branch.name], sessions);
        return count > 0 ? [{ name: branch.name, count }] : [];
      });
      return rows.length > 0 ? [{ path: tab.path, name: tab.name, rows }] : [];
    });
  });
  readonly terminalsWorktree = signal<{ path: string; branch: string } | null>(null);
  private readonly terminalsReturnPath = signal<string | null>(null);
  private readonly storedTerminalEpoch = signal(0);
  private tabToReveal: string | null = null;
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly openBranch = signal<string | null>(null);
  readonly selectedBranchName = signal<string | null>(null);
  readonly selectedFilePath = signal<string | null>(null);
  readonly selectedCommitSubject = signal<string | null>(null);
  readonly realBranches = signal<SampleBranch[]>([]);
  readonly pinnedWorktrees = signal<string[]>([]);
  readonly primaryBranchName = signal<string | undefined>(undefined);
  readonly loadedFiles = signal<ChangedFile[]>([]);
  readonly loadedCommits = signal<BranchCommit[]>([]);
  readonly loadedRecentCommits = signal<BranchCommit[]>([]);
  readonly commitListComplete = signal(false);
  readonly commitTotal = signal<number | null>(null);
  readonly loadedCommitFiles = signal<ChangedFile[]>([]);
  readonly loadedDiff = signal<string | null>(null);
  private readonly fullFileSides = signal<{ oldText: string; newText: string; tooLarge: boolean }>({
    oldText: '',
    newText: '',
    tooLarge: false,
  });
  readonly diffRowHeight = 20;
  readonly diffFoldHeight = 60;
  private readonly foldMemory = signal<ReadonlyMap<string, FoldOpenings>>(new Map());
  private readonly diffScrollTop = signal(0);
  private readonly diffClientHeight = signal(0);
  readonly appSettingsOpen = signal(false);
  readonly defaultLayout = signal<AppSettings['defaultLayout']>('workspaces');
  readonly sidebarColorSwatches = sidebarSwatches;
  readonly contentColorSwatches = contentSwatches;
  readonly terminalBackgroundSwatches = terminalBackgroundSwatchList;
  readonly terminalForegroundSwatches = terminalForegroundSwatchList;
  private readonly initialSettings = readAppSettings();
  readonly sidebarColor = signal(this.initialSettings.sidebarColor);
  readonly sidebarText = signal<SidebarText>(this.initialSettings.sidebarText);
  readonly paintedSidebarColor = signal(this.initialSettings.sidebarColor);
  readonly paintedSidebarText = signal<SidebarText>(this.initialSettings.sidebarText);
  readonly paintedSidebarTextColor = computed(() => (this.paintedSidebarText() === 'black' ? '#000000' : '#ffffff'));
  readonly contentColor = signal(this.initialSettings.contentColor);
  readonly ideCommand = signal(this.initialSettings.ideCommand);
  readonly terminalMode = signal<TerminalMode>(this.initialSettings.terminalMode);
  readonly diffMode = signal<DiffMode>(this.initialSettings.diffMode);
  readonly diffLayout = signal<DiffLayout>(this.initialSettings.diffLayout);
  readonly diffSideShare = signal(this.initialSettings.diffSideShare);
  private readonly diffSideScroll = signal(0);
  readonly shellCommand = signal(this.initialSettings.shellCommand);
  readonly shellCommandDraft = signal(this.initialSettings.shellCommand);
  readonly shellCommandEditing = signal(false);
  readonly pendingTerminalMode = signal<TerminalMode | null>(null);
  readonly oldSessionChoices = signal<OldSessionChoice[]>([]);
  private dismissedOldSessions = new Set<string>();
  private oldSessionRepo: string | null = null;
  private readonly repositoryWorkspaces = new Map<string, RepositoryWorkspace>();
  private readonly appSettingsEnv: NodeJS.ProcessEnv = {
    GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: resolveAppSettingsPath(),
  };
  private persistOpenTabs = false;
  readonly terminalFont = signal(this.initialSettings.terminalFont);
  readonly terminalFontFamily = computed(() => `${this.terminalFont()}, monospace`);
  readonly terminalBackground = signal(this.initialSettings.terminalBackground);
  readonly terminalForeground = signal(this.initialSettings.terminalForeground);
  readonly createDialogOpen = signal(false);
  readonly createBranchName = signal('');
  readonly createBranchOptions = signal<string[]>([]);
  readonly mergeDialogBranch = signal<string | null>(null);
  readonly removeDialogBranch = signal<string | null>(null);
  readonly removeForceDelete = signal(false);
  readonly mergeSquash = signal(false);
  readonly workspaceError = signal<string | null>(null);
  readonly worktreePath = signal('');
  readonly terminalsByBranch = signal<Record<string, WorktreeTerminalView>>({});
  readonly terminalMenu = signal<TerminalMenuState | null>(null);
  readonly presetMenu = signal<{ x: number; y: number; names: string[] } | null>(null);
  private readonly shownPresets = signal<CommittedPreset[] | null>(null);
  readonly moveSubmenuOpen = signal(false);
  private moveSubmenuTimer: ReturnType<typeof setTimeout> | null = null;
  readonly repositoryTabMenu = signal<{ path: string; x: number; y: number } | null>(null);
  readonly renaming = signal<{ tabId: string; terminalId: string | null } | null>(null);
  readonly renameValue = signal('');
  readonly hoveredTabId = signal<string | null>(null);
  readonly hoveredPaneId = signal<string | null>(null);
  readonly pointedTerminalId = signal<string | null>(null);
  readonly tabChip = tabChipModel;
  readonly chipGap = ' ';
  readonly chipSeparator = ' · ';
  readonly terminalDisplayName = formatTerminalName;
  readonly terminalHostTitle = formatHostTitle;
  readonly changesFileWidth = signal(this.initialSettings.changesFileWidth);
  readonly changesPaneHeight = signal(280);
  readonly changesShare = signal<number | null>(this.initialSettings.changesShare);
  readonly commitFileWidth = signal(this.initialSettings.commitFileWidth);
  readonly terminalRowHeight = signal(this.initialSettings.terminalRowHeight);
  private readonly terminalSectionByBranch = signal<Record<string, TerminalSection>>({});
  readonly terminalExpanded = computed(() => {
    if (this.terminalsOpen() && this.terminalsWorktree()) {
      return true;
    }
    return this.sectionFor(this.selectedBranchName()) !== 'collapsed';
  });
  private arrangedTerminalRowHeight = this.initialSettings.terminalRowHeight;
  readonly terminalMaximized = computed(() => {
    if (this.terminalsOpen() && this.terminalsWorktree()) {
      return true;
    }
    return this.sectionFor(this.selectedBranchName()) === 'maximized';
  });
  private readonly sheetBody = viewChild<ElementRef<HTMLElement>>('sheetBody');
  private readonly diffScroller = viewChild<ElementRef<HTMLElement>>('diffScroller');
  private readonly maximizedBodyHeight = signal<number | null>(null);
  private terminalSerial = 0;
  private terminalsPresetCheckout = '';
  private commandPoll: ReturnType<typeof setInterval> | null = null;
  private remoteFollow = 0;
  private readonly gitWatchers = new Map<string, FSWatcher>();
  private gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private gitWatchGeneration = 0;
  private gitWatchActive = false;
  private gitWatchCheckouts: { path: string; measured: boolean; primary: boolean; presets: boolean }[] = [];
  private readonly worktreeChangedAt = new Map<string, Map<string, number>>();
  private paneSplitDrag: {
    pointerId: number;
    startX: number;
    width: number;
    origin: number;
    tabId: string;
  } | null = null;
  private diffSideDrag: { pointerId: number; startX: number; width: number; origin: number } | null = null;
  private sideWheelTarget: HTMLElement | null = null;
  private splitDrag: {
    pointerId: number;
    axis: 'x' | 'y';
    start: number;
    origin: number;
    limit: number | undefined;
    invert: boolean;
    rememberTerminal: boolean;
    apply: (value: number) => void;
  } | null = null;
  readonly terminalState = computed(() => {
    const chosen = this.terminalsOpen() ? this.terminalsWorktree() : null;
    if (chosen) {
      this.storedTerminalEpoch();
      this.terminalsByBranch();
      return this.readBranchTerminals(chosen.path, chosen.branch);
    }
    const branch = this.selectedBranchName();
    if (!branch) {
      return emptyTerminals();
    }
    return this.terminalsByBranch()[branch] ?? emptyTerminals();
  });
  readonly terminalTabs = computed(() => this.terminalState().tabs);
  readonly focusedTerminalTab = computed(() => {
    const state = this.terminalState();
    return state.tabs.find((tab) => tab.id === state.focusedTabId) ?? null;
  });
  readonly registryMode = computed(() => this.liveRegistry() || liveQueryFlag());
  readonly effectivePath = computed(() => this.repositoryPath() ?? this.openedPath());
  readonly cardRepositories = computed((): CardRepository[] => {
    if (!this.registryMode()) {
      return sampleCard;
    }
    const openPaths = new Set(this.repositoryTabs().map((tab) => tab.path));
    return this.registered()
      .filter((repository) => !openPaths.has(repository.path))
      .map((repository) => ({
        name: repository.displayName,
        path: repository.path,
      }));
  });
  readonly workspaceTitle = computed(() => {
    const path = this.effectivePath();
    if (path === null) {
      return this.selectedName();
    }
    return findRepository(path)?.displayName ?? basename(path);
  });
  readonly branches = computed(() => {
    if (this.effectivePath() !== null) {
      return this.realBranches();
    }
    const sample = branchesByRepository[this.selectedName() ?? ''];
    if (!sample) {
      return [];
    }
    return pinDefaultBranch(sample.branches, sample.defaultBranch);
  });
  readonly worktreesLoading = computed(
    () => this.effectivePath() !== null && this.realBranches().length === 0,
  );
  readonly worktreeSkeleton = [0, 1, 2, 3, 4, 5];
  readonly contentSkeleton = [0, 1, 2, 3, 4];
  readonly selectedBranch = computed(
    () => this.branches().find((branch) => branch.name === this.selectedBranchName()) ?? null,
  );
  private readonly defaultBranchEpoch = signal(0);
  readonly defaultBranchName = computed(() => {
    this.defaultBranchEpoch();
    const path = this.effectivePath();
    if (path !== null) {
      return readDefaultBranch(path);
    }
    return branchesByRepository[this.selectedName() ?? '']?.defaultBranch;
  });
  readonly branchIsDefault = computed(() => {
    const name = this.selectedBranchName();
    const base = this.defaultBranchName();
    return name !== null && base !== undefined && name === base;
  });
  readonly selectedDiff = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedDiff();
    }
    const file = this.selectedBranch()?.files?.find((item) => item.path === this.selectedFilePath());
    return file?.diff ?? null;
  });
  readonly selectedCommit = computed(
    () => this.selectedBranch()?.commits?.find((commit) => commit.subject === this.selectedCommitSubject()) ?? null,
  );
  readonly visibleFiles = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedFiles();
    }
    return this.selectedBranch()?.files ?? [];
  });
  readonly visibleRecentCommits = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedRecentCommits();
    }
    return this.selectedBranch()?.commits ?? [];
  });
  readonly visibleCommits = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedCommits();
    }
    return (this.selectedBranch()?.commits ?? []).filter((commit) => !commit.onDefaultBranch);
  });
  readonly headingCommitCount = computed((): number | null => {
    if (this.effectivePath() === null) {
      return this.branchIsDefault() ? this.visibleRecentCommits().length : this.visibleCommits().length;
    }
    return this.commitTotal();
  });
  readonly showingCommit = computed(() => {
    if (this.selectedCommitSubject() === null) {
      return false;
    }
    if (this.effectivePath() !== null) {
      return true;
    }
    return this.selectedCommit() !== null;
  });
  readonly visibleCommitFiles = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedCommitFiles();
    }
    return this.selectedCommit()?.files ?? [];
  });
  readonly visibleCommitDiff = computed(() => {
    if (this.effectivePath() !== null) {
      return this.loadedDiff() ?? '';
    }
    return this.selectedCommit()?.diff ?? '';
  });

  branchActivityLabel(name: string): string | null {
    const activity = this.branchActivity();
    if (activity?.branch === name) {
      return activity.label;
    }
    if (this.contentLoading() && this.terminalMaximized() && this.selectedBranchName() === name) {
      return `Loading ${name}`;
    }
    return null;
  }

  statusLabel(status: BranchStatus): string {
    switch (status) {
      case 'local-only':
        return 'Local only';
      case 'local-and-remote':
        return 'Local and remote';
      case 'remote-only':
        return 'Remote only';
      case 'remote-deleted':
        return 'Remote deleted';
    }
  }

  ngOnInit(): void {
    this.persistOpenTabs = this.registryMode() && this.repositoryPath() === null;
    if (this.registryMode()) {
      this.registered.set(listRepositories());
    }
    const path = this.effectivePath();
    if (path !== null) {
      const name = this.workspaceTitle();
      if (name !== null) {
        this.appendRepositoryTab(path, name);
      }
      this.followRemote(path);
    } else if (this.persistOpenTabs) {
      this.restoreOpenRepositoryTabs();
    }
    this.refreshBranches();
    this.applyOpenRepositoryAppearance();
    this.startCommandPoll();
  }

  ngAfterViewInit(): void {
    this.fitDockedTerminal();
    this.applyChangesShare();
  }

  ngAfterViewChecked(): void {
    this.captureMaximizedBody();
    this.scheduleDiffViewport();
    this.bindSideWheel();
    this.revealPendingTab();
    this.fitAnchoredMenu('[data-testid="terminal-menu"]', this.terminalMenu());
    this.fitAnchoredMenu('[data-testid="preset-menu"]', this.presetMenu());
    this.fitAnchoredMenu('[data-testid="repository-tab-menu"]', this.repositoryTabMenu());
    this.fitMoveSubmenu();
  }

  ngOnDestroy(): void {
    this.sideWheelTarget?.removeEventListener('wheel', this.onSideWheel);
    this.sideWheelTarget = null;
    this.hideMoveSubmenu();
    this.clearGitWatch();
    this.remoteFollow += 1;
    this.rememberOpenRepositoryTabs();
    if (this.commandPoll !== null) {
      clearInterval(this.commandPoll);
      this.commandPoll = null;
    }
    stopShellTerminals(this.terminalsByBranch());
    for (const workspace of this.repositoryWorkspaces.values()) {
      stopShellTerminals(workspace.terminalsByBranch);
    }
  }

  choose(name: string): void {
    const entry = this.cardRepositories().find((repository) => repository.name === name);
    const path = entry?.path ?? null;
    if (path !== null && this.effectivePath() === path) {
      this.overlayOpen.set(false);
      return;
    }
    if (path === null) {
      this.finishChoose(name, null);
      return;
    }
    this.openRepository(name, path);
  }

  openRepositoryTabMenu(event: MouseEvent, path: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.repositoryTabMenu.set({
      path,
      x: event.clientX,
      y: event.clientY,
    });
  }

  openRepositoryTabSettings(): void {
    const menu = this.repositoryTabMenu();
    if (!menu) {
      return;
    }
    this.repositoryTabMenu.set(null);
    this.repositorySettings()?.openForPath(menu.path);
  }

  closeRepositoryTab(path: string): void {
    this.repositoryTabMenu.set(null);
    const tabs = this.repositoryTabs();
    const index = tabs.findIndex((tab) => tab.path === path);
    if (index < 0) {
      return;
    }
    this.endRepositoryTerminals(path);
    if (this.terminalsWorktree()?.path === path) {
      this.terminalsWorktree.set(null);
    }
    this.repositoryWorkspaces.delete(path);
    this.worktreeChangedAt.delete(path);
    const remaining = tabs.filter((tab) => tab.path !== path);
    this.repositoryTabs.set(remaining);
    if (this.terminalsOpen() && this.terminalsReturnPath() === path) {
      const nextReturn = remaining[index] ?? remaining[index - 1] ?? null;
      this.terminalsReturnPath.set(nextReturn?.path ?? null);
    }
    if (this.effectivePath() !== path) {
      this.rememberOpenRepositoryTabs();
      this.leaveTerminalsIfCountReachesZero();
      return;
    }
    const next = remaining[index] ?? remaining[index - 1];
    if (!next) {
      this.terminalsOpen.set(false);
      this.terminalsWorktree.set(null);
      this.selectedName.set(null);
      this.openedPath.set(null);
      this.overlayOpen.set(false);
      this.openBranch.set(null);
      this.openingRepository.set(null);
      this.clearBranchSelection();
      this.clearTerminals();
      this.clearGitWatch();
      this.applyOpenRepositoryAppearance();
      this.rememberOpenRepositoryTabs();
      return;
    }
    this.tabToReveal = next.path;
    this.showKeptRepository(next);
    this.rememberOpenRepositoryTabs();
    this.leaveTerminalsIfCountReachesZero();
  }

  private leaveTerminalsIfCountReachesZero(): void {
    if (this.terminalsOpen() && this.terminalsTotal() === 0) {
      this.leaveTerminals();
    }
  }

  private leaveTerminals(): void {
    this.terminalsOpen.set(false);
    this.terminalsWorktree.set(null);
    this.terminalsPresetCheckout = '';
    const tabs = this.repositoryTabs();
    const remembered = this.terminalsReturnPath();
    const rememberedTab = remembered === null ? undefined : tabs.find((tab) => tab.path === remembered);
    const current = this.effectivePath();
    const currentTab = current === null ? undefined : tabs.find((tab) => tab.path === current);
    const tab = rememberedTab ?? currentTab;
    if (!tab) {
      this.selectedName.set(null);
      this.openedPath.set(null);
      this.overlayOpen.set(false);
      this.openBranch.set(null);
      this.openingRepository.set(null);
      this.clearBranchSelection();
      this.clearTerminals();
      this.clearGitWatch();
      this.applyOpenRepositoryAppearance();
      this.rememberOpenRepositoryTabs();
      return;
    }
    if (this.effectivePath() !== tab.path) {
      this.showKeptRepository(tab);
      return;
    }
    this.applyOpenRepositoryAppearance();
    const checkout = this.worktreePath();
    if (checkout !== '') {
      this.syncCommittedPreset(checkout);
    }
  }

  selectRepositoryTab(path: string, event: Event): void {
    const current = event.currentTarget;
    if (current instanceof HTMLElement && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const leavingTerminals = this.terminalsOpen();
    if (leavingTerminals) {
      this.terminalsOpen.set(false);
    }
    if (this.effectivePath() === path) {
      if (leavingTerminals) {
        this.applyOpenRepositoryAppearance();
      }
      return;
    }
    const tab = this.repositoryTabs().find((item) => item.path === path);
    if (!tab) {
      return;
    }
    if (this.repositoryWorkspaces.has(path)) {
      this.activateKeptRepository(tab);
      return;
    }
    this.openRepository(tab.name, path);
  }

  private activateKeptRepository(tab: RepositoryTab): void {
    this.rememberWorkspace(this.effectivePath());
    this.tabToReveal = tab.path;
    this.showKeptRepository(tab);
    this.rememberOpenRepositoryTabs();
  }

  private rememberWorkspace(path: string | null): void {
    if (path === null) {
      return;
    }
    this.repositoryWorkspaces.set(path, {
      view: this.snapshotBranchView(),
      terminalsByBranch: this.terminalsByBranch(),
      worktreePath: this.worktreePath(),
      branches: this.realBranches(),
      terminalSectionByBranch: this.terminalSectionByBranch(),
    });
  }

  private openRepository(name: string, path: string, whenOpenFails?: (path: string) => void): void {
    this.overlayOpen.set(false);
    this.openError.set(null);
    if (this.repositoryPath() === null && this.selectedName() === null) {
      this.openingRepository.set(name);
    }
    this.runWhenPainted(() => {
      try {
        ensureGitRepository(path);
        this.finishChoose(name, path);
        this.openingRepository.set(null);
        this.followRemote(path);
      } catch (error) {
        this.openingRepository.set(null);
        if (whenOpenFails) {
          whenOpenFails(path);
          return;
        }
        const message = errorText(error);
        if (this.effectivePath() === null && this.selectedName() === null) {
          this.openError.set(message);
        } else {
          this.workspaceError.set(message);
        }
      }
    });
  }

  private appendRepositoryTab(path: string, name: string): void {
    if (this.repositoryTabs().some((tab) => tab.path === path)) {
      return;
    }
    this.repositoryTabs.update((tabs) => [...tabs, { path, name }]);
    this.tabToReveal = path;
  }

  private revealPendingTab(): void {
    const path = this.tabToReveal;
    if (path === null) {
      return;
    }
    const tab = this.repositoryTabElement(path);
    if (tab === null) {
      return;
    }
    this.tabToReveal = null;
    if (typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private repositoryTabElement(path: string): HTMLElement | null {
    const tabs = this.hostElement.nativeElement.querySelectorAll('[data-testid="repository-tab"]');
    for (const tab of tabs) {
      if (tab instanceof HTMLElement && tab.getAttribute('data-path') === path) {
        return tab;
      }
    }
    return null;
  }

  openAddDialog(): void {
    this.cardError.set(null);
    this.addPath.set('');
    this.addName.set('');
    this.addNameTouched.set(false);
    this.addDialogOpen.set(true);
  }

  setAddName(event: Event): void {
    this.addNameTouched.set(true);
    const name = inputValue(event);
    this.addName.set(name);
    if (this.cardError() === 'Enter a display name' && name.trim() !== '') {
      this.cardError.set(null);
    }
  }

  setAddPath(event: Event): void {
    this.applyRepositoryPath(inputValue(event));
  }

  async browseFolder(): Promise<void> {
    const chosen = await browseForFolder();
    this.zone.run(() => {
      if (!chosen) {
        return;
      }
      this.applyRepositoryPath(chosen);
    });
  }

  private applyRepositoryPath(path: string): void {
    this.addPath.set(path);
    const trimmed = path.trim();
    if (trimmed === '') {
      this.cardError.set(null);
      if (!this.addNameTouched()) {
        this.addName.set('');
      }
      return;
    }
    let name = '';
    try {
      name = readRepositoryName(trimmed);
      this.cardError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cardError.set(message);
    }
    if (!this.addNameTouched()) {
      this.addName.set(name);
    }
  }

  cancelAdd(): void {
    this.cardError.set(null);
    this.addPath.set('');
    this.addName.set('');
    this.addNameTouched.set(false);
    this.addDialogOpen.set(false);
  }

  dismissAddFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.cancelAdd();
    }
  }

  addRegistered(): void {
    this.cardError.set(null);
    if (this.addPath().trim() === '') {
      this.cardError.set('Choose a repository folder');
      return;
    }
    try {
      readRepositoryName(this.addPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cardError.set(message);
      return;
    }
    const displayName = this.addName().trim();
    if (displayName === '') {
      this.cardError.set('Enter a display name');
      return;
    }
    try {
      addRepository(this.addPath(), displayName);
      this.addPath.set('');
      this.addName.set('');
      this.addNameTouched.set(false);
      this.addDialogOpen.set(false);
      this.registered.set(listRepositories());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cardError.set(message);
    }
  }

  selectFile(path: string): void {
    this.resetDiffScroll();
    this.selectedFilePath.set(path);
    this.selectedCommitSubject.set(null);
    const repo = this.effectivePath();
    const branch = this.selectedBranchName();
    if (repo && branch) {
      const previousPath = this.loadedFiles().find((file) => file.path === path)?.previousPath;
      this.loadedDiff.set(readWorkingTreeDiff(repo, branch, path, previousPath));
    }
    this.refreshFullFileSides();
  }

  selectCommit(subject: string, sha?: string): void {
    this.resetDiffScroll();
    this.selectedCommitSubject.set(sha ?? subject);
    const repo = this.effectivePath();
    if (!repo) {
      this.selectedFilePath.set(this.selectedCommit()?.files?.[0]?.path ?? null);
      this.refreshFullFileSides();
      return;
    }
    const commit = this.commitByIdentity(subject, sha);
    if (!commit) {
      this.selectedFilePath.set(null);
      this.loadedCommitFiles.set([]);
      this.loadedDiff.set(null);
      this.refreshFullFileSides();
      return;
    }
    const files = readCommitFiles(repo, commit.sha);
    this.loadedCommitFiles.set(files);
    const first = files[0];
    this.selectedFilePath.set(first?.path ?? null);
    this.loadedDiff.set(first ? readCommitFileDiff(repo, commit.sha, first.path, first.previousPath) : '');
    this.refreshFullFileSides();
  }

  selectCommitFile(path: string, event: Event): void {
    event.stopPropagation();
    this.resetDiffScroll();
    this.selectedFilePath.set(path);
    const repo = this.effectivePath();
    const identity = this.selectedCommitSubject();
    if (!repo || !identity) {
      this.refreshFullFileSides();
      return;
    }
    const commit = this.commitByIdentity(identity, identity);
    if (!commit) {
      this.refreshFullFileSides();
      return;
    }
    const previousPath = this.loadedCommitFiles().find((file) => file.path === path)?.previousPath;
    this.loadedDiff.set(readCommitFileDiff(repo, commit.sha, path, previousPath));
    this.refreshFullFileSides();
  }

  chooseDiffMode(mode: DiffMode): void {
    this.diffMode.set(mode);
    saveDiffMode(mode);
    this.resetDiffScroll();
    this.refreshFullFileSides();
  }

  chooseDiffLayout(layout: DiffLayout): void {
    this.diffLayout.set(layout);
    saveDiffLayout(layout);
    this.resetDiffScroll();
  }

  diffSideOldWidth(): string {
    return `calc(${this.diffSideShare()} * (100% - 8px))`;
  }

  diffSideShift(): string {
    const offset = this.diffSideScroll();
    return offset === 0 ? '' : `translateX(${-offset}px)`;
  }

  onDiffSideWheel(event: WheelEvent): void {
    if (this.diffLayout() !== 'side') {
      return;
    }
    const delta = event.shiftKey
      ? event.deltaY
      : Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : 0;
    if (delta === 0) {
      return;
    }
    const bar = this.sideScrollBar();
    if (!(bar instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    bar.scrollLeft += delta;
    this.rememberSideScroll(bar.scrollLeft);
  }

  scrollDiffSides(event: Event): void {
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    this.rememberSideScroll(element.scrollLeft);
  }

  beginDiffSideSplit(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const row = (event.currentTarget as HTMLElement | null)?.parentElement;
    this.captureSplit(event);
    this.diffSideDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width: row?.clientWidth ?? 0,
      origin: this.diffSideShare(),
    };
  }

  moveDiffSideSplit(event: PointerEvent): void {
    const drag = this.diffSideDrag;
    if (!drag || drag.pointerId !== event.pointerId || drag.width <= 0) {
      return;
    }
    const ratio = drag.origin + (event.clientX - drag.startX) / drag.width;
    this.diffSideShare.set(clampDiffSideShare(ratio, drag.width));
  }

  endDiffSideSplit(event: PointerEvent): void {
    if (this.diffSideDrag?.pointerId !== event.pointerId) {
      return;
    }
    this.diffSideDrag = null;
    saveDiffSideShare(this.diffSideShare());
  }

  equalizeDiffSides(): void {
    this.diffSideShare.set(0.5);
    saveDiffSideShare(0.5);
  }

  canJumpToChange(direction: 'next' | 'previous'): boolean {
    return this.changeTarget(direction) !== undefined;
  }

  jumpToChange(direction: 'next' | 'previous'): void {
    const target = this.changeTarget(direction);
    if (target === undefined) {
      return;
    }
    const top = this.diffHeaderHeight() + target;
    const element = this.diffScroller()?.nativeElement;
    if (element) {
      element.scrollTop = top;
    }
    this.diffScrollTop.set(top);
  }

  isSelectedCommit(commit: { sha?: string; subject: string }): boolean {
    const selected = this.selectedCommitSubject();
    return selected !== null && (selected === commit.sha || selected === commit.subject);
  }

  isSelectedFile(path: string): boolean {
    return this.selectedFilePath() === path;
  }

  private commitByIdentity(subject: string, sha?: string): BranchCommit | undefined {
    const recent = this.loadedRecentCommits();
    const only = this.loadedCommits();
    if (sha) {
      return recent.find((item) => item.sha === sha) ?? only.find((item) => item.sha === sha);
    }
    return recent.find((item) => item.subject === subject) ?? only.find((item) => item.subject === subject);
  }

  openBranchMenu(name: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.branchHasActions(name)) {
      this.openBranch.set(null);
      return;
    }
    this.openBranch.set(this.openBranch() === name ? null : name);
  }

  branchHasActions(name: string): boolean {
    if (name !== this.defaultBranchName()) {
      return true;
    }
    return this.branches().find((branch) => branch.name === name)?.status === 'local-only';
  }

  keepBranchMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  selectBranch(name: string, event?: Event): void {
    event?.stopPropagation();
    this.closeTerminalMenu();
    this.renaming.set(null);
    const path = this.effectivePath();
    if (path === null) {
      this.selectedBranchName.set(name);
      this.clearLoadedBranch();
      return;
    }
    const previous = this.snapshotBranchView();
    this.selectedBranchName.set(name);
    if (!this.terminalMaximized()) {
      this.maximizedBodyHeight.set(null);
    }
    this.clearLoadedBranch();
    this.contentLoading.set(true);
    this.runWhenPainted(() => {
      try {
        this.refreshBranches();
        this.loadBranchContent(name);
        this.contentLoading.set(false);
      } catch (error) {
        this.restoreBranchView(previous);
        this.contentLoading.set(false);
        this.workspaceError.set(errorText(error));
      }
    });
  }

  onCommitsScroll(event: Event): void {
    const list = event.currentTarget as HTMLElement;
    if (list.scrollTop + list.clientHeight < list.scrollHeight) {
      return;
    }
    if (this.commitListComplete()) {
      return;
    }
    const path = this.effectivePath();
    const branch = this.selectedBranchName();
    if (!path || !branch) {
      return;
    }
    const onDefault = this.branchIsDefault();
    const page = onDefault
      ? readRecentCommits(path, branch, this.loadedRecentCommits().length)
      : readCommitsOnlyOnBranch(path, branch, this.loadedCommits().length);
    if (onDefault) {
      this.loadedRecentCommits.update((current) => [...current, ...page]);
    } else {
      this.loadedCommits.update((current) => [...current, ...page]);
    }
    if (page.length < recentCommitPageSize) {
      this.commitListComplete.set(true);
    }
  }

  terminalsTotal(): number {
    this.storedTerminalEpoch();
    const current = this.effectivePath();
    const tabs = this.repositoryTabs();
    if (tabs.length === 0) {
      return this.branches().reduce((sum, branch) => sum + this.terminalCount(branch.name), 0);
    }
    let total = 0;
    for (const tab of tabs) {
      if (tab.path === current) {
        total += this.branches().reduce((sum, branch) => sum + this.terminalCount(branch.name), 0);
        continue;
      }
      const saved = this.repositoryWorkspaces.get(tab.path);
      if (!saved) {
        continue;
      }
      total += saved.branches.reduce(
        (sum, branch) =>
          sum +
          countBranchTerminals(tab.path, branch.name, saved.terminalsByBranch[branch.name], this.tmuxSessionRecords()),
        0,
      );
    }
    return total;
  }

  isTerminalsWorktree(path: string, branch: string): boolean {
    const chosen = this.terminalsWorktree();
    return chosen !== null && chosen.path === path && chosen.branch === branch;
  }

  chooseTerminalsWorktree(path: string, branch: string): void {
    this.adoptCountedSessions(path, branch);
    this.terminalsPresetCheckout = findCheckout(path, branch) ?? '';
    this.presetMenu.set(null);
    this.terminalsWorktree.set({ path, branch });
    if (this.terminalsPresetCheckout !== '') {
      this.syncCommittedPreset(this.terminalsPresetCheckout);
    }
    this.applyGitWatchTargets();
  }

  private adoptCountedSessions(path: string, branch: string): void {
    const cwd = findCheckout(path, branch);
    if (!cwd) {
      return;
    }
    const existing = this.readBranchTerminals(path, branch);
    if (existing.tabs.length > 0) {
      return;
    }
    if (this.activeTerminalMode() === 'none') {
      return;
    }
    if (sessionsForBranch(path, branch).length === 0) {
      return;
    }
    this.writeBranchTerminals(path, branch, this.adoptTmuxSessions(path, branch, cwd));
  }

  private dropRememberedWorktreeIfGone(): void {
    const chosen = this.terminalsWorktree();
    if (chosen === null) {
      return;
    }
    const listed = this.terminalGroups().some(
      (group) => group.path === chosen.path && group.rows.some((row) => row.name === chosen.branch),
    );
    if (!listed) {
      this.terminalsWorktree.set(null);
    }
  }

  chooseTerminals(event: Event): void {
    if (this.terminalsTotal() === 0 || this.terminalsOpen()) {
      event.preventDefault();
      return;
    }
    this.terminalsReturnPath.set(this.effectivePath());
    this.dropRememberedWorktreeIfGone();
    this.terminalsOpen.set(true);
    this.applyOpenRepositoryAppearance();
  }

  keepTerminalsMenuClosed(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onTerminalsKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    this.chooseTerminals(event);
  }

  terminalCount(name: string): number {
    return countBranchTerminals(
      this.effectivePath(),
      name,
      this.terminalsByBranch()[name],
      this.tmuxSessionRecords(),
    );
  }

  focusTab(tabId: string): void {
    this.updateSelected((state) => ({ ...state, focusedTabId: tabId }));
  }

  onTabKeydown(event: KeyboardEvent, tabId: string): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    this.focusTab(tabId);
  }

  focusNamedTerminal(event: MouseEvent, tabId: string, terminalId: string): void {
    event.stopPropagation();
    this.focusTerminal(tabId, terminalId);
  }

  hoverTab(tabId: string): void {
    this.hoveredTabId.set(tabId);
  }

  leaveTab(tabId: string): void {
    if (this.hoveredTabId() === tabId) {
      this.hoveredTabId.set(null);
    }
  }

  hoverPane(terminalId: string): void {
    this.hoveredPaneId.set(terminalId);
  }

  leavePane(terminalId: string): void {
    if (this.hoveredPaneId() === terminalId) {
      this.hoveredPaneId.set(null);
    }
  }

  pointTerminal(terminalId: string): void {
    this.pointedTerminalId.set(terminalId);
  }

  clearPointedTerminal(terminalId: string): void {
    if (this.pointedTerminalId() === terminalId) {
      this.pointedTerminalId.set(null);
    }
  }

  isTabKillVisible(tab: TerminalTabView): boolean {
    return tab.id === this.focusedTerminalTab()?.id || this.hoveredTabId() === tab.id || this.isRenamingTab(tab);
  }

  isPaneKillVisible(tabId: string, terminalId: string): boolean {
    return this.hoveredPaneId() === terminalId || this.isRenamingTerminal(tabId, terminalId);
  }

  killTabFromButton(event: MouseEvent, tabId: string): void {
    event.preventDefault();
    event.stopPropagation();
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    if (!branch) {
      return;
    }
    if (this.renaming()?.tabId === tabId) {
      this.renaming.set(null);
    }
    this.removeTab(branch, tabId, chosen?.path);
  }

  killPaneFromButton(event: MouseEvent, tabId: string, terminalId: string): void {
    event.preventDefault();
    event.stopPropagation();
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    if (!branch) {
      return;
    }
    const renaming = this.renaming();
    if (renaming?.tabId === tabId && renaming.terminalId === terminalId) {
      this.renaming.set(null);
    }
    this.removeTerminal(branch, tabId, terminalId, chosen?.path);
  }

  focusTerminal(tabId: string, terminalId: string): void {
    this.updateSelected((state) => ({
      ...state,
      focusedTabId: tabId,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, focusedTerminalId: terminalId } : tab,
      ),
    }));
  }

  showRunPreset(): boolean {
    const checkout = this.presetCheckout();
    const presets = this.shownPresets();
    if (checkout === '') {
      return false;
    }
    return presets !== null;
  }

  runPreset(event: Event): void {
    event.stopPropagation();
    const presets = this.readPresetsForRun();
    if (!presets) {
      return;
    }
    const current = event.currentTarget;
    const rect = current instanceof HTMLElement ? current.getBoundingClientRect() : { left: 0, bottom: 0 };
    this.closeTerminalMenu();
    this.presetMenu.set({
      x: rect.left,
      y: rect.bottom,
      names: presets.map((preset) => preset.name),
    });
  }

  choosePreset(index: number): void {
    const menu = this.presetMenu();
    this.presetMenu.set(null);
    if (!menu) {
      return;
    }
    const presets = this.readPresetsForRun();
    const preset = presets?.[index];
    if (!preset) {
      return;
    }
    this.appendPreset(preset);
  }

  newTerminal(): void {
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    const terminal = this.spawnTerminal();
    if (!terminal || !branch) {
      return;
    }
    const tab = this.makeTab([terminal]);
    this.updateSelected((state) => withNewTab(state, tab));
    if (!chosen && this.sectionFor(branch) !== 'maximized') {
      this.setSection(branch, 'docked');
    }
    this.closeTerminalMenu();
  }

  splitTerminal(tabId?: string): void {
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    const path = chosen?.path ?? this.effectivePath();
    const state = branch && path ? this.readBranchTerminals(path, branch) : undefined;
    if (!branch || !state) {
      return;
    }
    const id = tabId ?? state.focusedTabId;
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab || tab.terminals.length >= 2) {
      return;
    }
    const terminal = this.spawnTerminal();
    if (!terminal) {
      return;
    }
    this.updateSelected((current) => withSplit(current, tab.id, terminal));
    this.closeTerminalMenu();
  }

  killFocusedTerminal(): void {
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    const tab = this.focusedTerminalTab();
    if (!branch || !tab) {
      return;
    }
    const terminal = tab.terminals.find((item) => item.id === tab.focusedTerminalId) ?? tab.terminals[0];
    if (!terminal) {
      return;
    }
    this.removeTerminal(branch, tab.id, terminal.id, chosen?.path);
  }

  onTerminalEnded(terminalId: string): void {
    const located = this.locateTerminal(terminalId);
    if (!located) {
      return;
    }
    this.removeTerminal(located.branch, located.tabId, terminalId);
  }

  splitUnavailable(): boolean {
    const tab = this.focusedTerminalTab();
    return tab === null || tab.terminals.length >= 2;
  }

  tabTooltip(tab: TerminalTabView): string | null {
    const only = tab.terminals.length === 1 ? tab.terminals[0] : undefined;
    return only ? formatHostTitle(only.host) : null;
  }

  isRenamingTab(tab: TerminalTabView): boolean {
    const renaming = this.renaming();
    return renaming !== null && renaming.tabId === tab.id && renaming.terminalId === null;
  }

  isRenamingTerminal(tabId: string, terminalId: string): boolean {
    const renaming = this.renaming();
    return renaming !== null && renaming.tabId === tabId && renaming.terminalId === terminalId;
  }

  columnGrow(tab: TerminalTabView, index: number): number {
    return index === 0 ? tab.splitRatio : 1 - tab.splitRatio;
  }

  openTerminalMenu(event: MouseEvent, tabId: string, terminalId: string | null): void {
    event.preventDefault();
    event.stopPropagation();
    this.hideMoveSubmenu();
    this.renaming.set(null);
    this.terminalMenu.set({
      tabId,
      terminalId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  hoverTerminalMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest('[data-testid="terminal-menu-move"]')) {
      this.showMoveSubmenu();
      return;
    }
    this.hideMoveSubmenu();
  }

  showMoveSubmenu(): void {
    this.clearMoveSubmenuTimer();
    this.moveSubmenuOpen.set(true);
  }

  hideMoveSubmenu(): void {
    this.clearMoveSubmenuTimer();
    this.moveSubmenuOpen.set(false);
  }

  scheduleHideMoveSubmenu(): void {
    this.clearMoveSubmenuTimer();
    this.moveSubmenuTimer = setTimeout(() => {
      this.moveSubmenuTimer = null;
      this.moveSubmenuOpen.set(false);
    }, 150);
  }

  openPaneMenu(event: MouseEvent, tab: TerminalTabView, terminalId: string): void {
    this.focusTerminal(tab.id, terminalId);
    this.openTerminalMenu(event, tab.id, tab.terminals.length > 1 ? terminalId : null);
  }

  menuActions(): TerminalMenuActions | null {
    const menu = this.terminalMenu();
    const tab = menu ? this.terminalTabs().find((item) => item.id === menu.tabId) : undefined;
    if (!menu || !tab) {
      return null;
    }
    return terminalMenuActions(tab, menu.terminalId);
  }

  beginRename(): void {
    const menu = this.terminalMenu();
    const tab = menu ? this.terminalTabs().find((item) => item.id === menu.tabId) : undefined;
    if (!menu || !tab) {
      return;
    }
    this.renameValue.set(editableName(tab, menu.terminalId));
    this.renaming.set({ tabId: menu.tabId, terminalId: menu.terminalId });
    this.closeTerminalMenu();
    queueMicrotask(() => {
      const input = document.querySelector('[data-testid="terminal-name-input"]');
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
    });
  }

  setRenameValue(event: Event): void {
    this.renameValue.set(inputValue(event));
  }

  commitRename(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const renaming = this.renaming();
    const branch = this.chosenTerminalWorktree()?.branch ?? this.selectedBranchName();
    if (!renaming || !branch) {
      this.renaming.set(null);
      return;
    }
    this.updateSelected((state) => withRename(state, renaming.tabId, renaming.terminalId, this.renameValue()));
    this.renaming.set(null);
  }

  cancelRename(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.renaming.set(null);
  }

  killFromMenu(): void {
    const menu = this.terminalMenu();
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    if (!menu || !branch) {
      return;
    }
    if (menu.terminalId === null) {
      this.removeTab(branch, menu.tabId, chosen?.path);
      return;
    }
    this.removeTerminal(branch, menu.tabId, menu.terminalId, chosen?.path);
  }

  splitFromMenu(): void {
    const menu = this.terminalMenu();
    if (!menu || menu.terminalId !== null) {
      return;
    }
    this.splitTerminal(menu.tabId);
  }

  swapFromMenu(): void {
    const menu = this.terminalMenu();
    if (!menu || !this.selectedBranchName()) {
      return;
    }
    this.updateSelected((state) => withSwap(state, menu.tabId));
    this.closeTerminalMenu();
  }

  unsplitFromMenu(): void {
    const menu = this.terminalMenu();
    const terminalId = menu?.terminalId;
    if (!menu || !this.selectedBranchName() || terminalId === undefined || terminalId === null) {
      return;
    }
    const newTabId = this.nextTerminalKey('tab');
    this.updateSelected((state) => withUnsplit(state, menu.tabId, terminalId, newTabId));
    this.closeTerminalMenu();
  }

  moveTargets(): TerminalMoveTarget[] {
    const menu = this.terminalMenu();
    if (!menu) {
      return [];
    }
    return terminalMoveTargets(this.terminalState(), menu.tabId, menu.terminalId);
  }

  moveTerminalTo(targetTabId: string): void {
    const menu = this.terminalMenu();
    if (!menu || !this.selectedBranchName()) {
      return;
    }
    this.updateSelected((state) => withMoveInto(state, menu.tabId, menu.terminalId, targetTabId));
    this.closeTerminalMenu();
  }

  beginPaneSplit(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const tab = this.focusedTerminalTab();
    const parent = (event.currentTarget as HTMLElement | null)?.parentElement;
    if (!tab || !parent) {
      return;
    }
    event.preventDefault();
    const width = parent.clientWidth || parent.offsetWidth || 1;
    this.paneSplitDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width,
      origin: tab.splitRatio,
      tabId: tab.id,
    };
    this.captureSplit(event);
  }

  @HostListener('document:pointermove', ['$event'])
  movePaneSplit(event: PointerEvent): void {
    const drag = this.paneSplitDrag;
    if (!drag || drag.pointerId !== event.pointerId || drag.width <= 0) {
      return;
    }
    const ratio = Math.min(0.8, Math.max(0.2, drag.origin + (event.clientX - drag.startX) / drag.width));
    this.updateSelected((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === drag.tabId ? { ...tab, splitRatio: ratio } : tab)),
    }));
  }

  @HostListener('document:pointerup', ['$event'])
  endPaneSplit(event: PointerEvent): void {
    if (this.paneSplitDrag?.pointerId === event.pointerId) {
      this.paneSplitDrag = null;
    }
  }

  equalizePaneSplit(): void {
    const tab = this.focusedTerminalTab();
    if (!tab) {
      return;
    }
    this.updateSelected((state) => ({
      ...state,
      tabs: state.tabs.map((item) => (item.id === tab.id ? { ...item, splitRatio: 0.5 } : item)),
    }));
  }

  controlWindow(action: WindowAction): void {
    requestWindowAction(action);
  }

  beginChangesSplit(event: PointerEvent): void {
    this.beginSplit(event, 'x', this.changesFileWidth(), (value) => this.changesFileWidth.set(value));
  }

  equalizeContentColumns(event: MouseEvent): void {
    const columns = (event.currentTarget as HTMLElement | null)?.parentElement;
    const width = columns?.clientWidth ?? 0;
    if (this.showingCommit() && this.visibleCommitFiles().length > 0) {
      const column = (width - 16) / 3;
      this.changesFileWidth.set(column);
      this.commitFileWidth.set(column);
      this.persistArrangement();
      return;
    }
    this.changesFileWidth.set((width - 8) / 2);
    this.persistArrangement();
  }

  beginCommitsSplit(event: PointerEvent): void {
    const stack = (event.currentTarget as HTMLElement | null)?.parentElement?.clientHeight ?? 0;
    this.beginSplit(event, 'y', this.changesPaneHeight(), (value) => {
      this.changesPaneHeight.set(this.clampChangesDrag(value, stack));
      this.rememberChangesShare();
    });
  }

  halveCommitsSplit(): void {
    this.changesShare.set(0.5);
    this.applyChangesShare();
    this.persistArrangement();
  }

  beginCommitDetailSplit(event: PointerEvent): void {
    this.beginSplit(
      event,
      'x',
      this.commitFileWidth(),
      (value) => this.commitFileWidth.set(value),
      this.changesFileWidth() + 8,
    );
  }

  beginTerminalSplit(event: PointerEvent): void {
    this.captureChangesShare();
    this.beginSplit(
      event,
      'y',
      this.terminalRowHeight(),
      (value) => {
        this.terminalRowHeight.set(value);
        this.applyChangesShare();
      },
      0,
      true,
      0,
      true,
    );
  }

  equalizeTerminalRow(event: MouseEvent): void {
    this.captureChangesShare();
    const body = (event.currentTarget as HTMLElement | null)?.parentElement;
    const span = body?.clientHeight ?? 0;
    const room = span - 8 - 80;
    this.terminalRowHeight.set(clampSplit(span / 3, room >= 80 ? room : undefined));
    this.applyChangesShare();
    this.arrangedTerminalRowHeight = this.terminalRowHeight();
    this.persistArrangement();
  }

  terminalRowTracks(): string {
    if (!this.showTerminalRow() || this.terminalMaximized()) {
      return 'minmax(0, 1fr)';
    }
    if (!this.terminalExpanded()) {
      return 'minmax(0, 1fr) auto';
    }
    return `minmax(0, 1fr) 8px ${this.terminalRowHeight()}px`;
  }

  terminalBodyHeight(): number {
    if (this.terminalMaximized()) {
      const measured = this.maximizedBodyHeight();
      if (measured !== null) {
        return measured;
      }
    }
    return Math.max(1, this.terminalRowHeight() - terminalHeaderHeight);
  }

  terminalPaneHeight(): number {
    const available = this.terminalBodyHeight();
    const tab = this.focusedTerminalTab();
    if (tab && tab.terminals.length > 1) {
      return Math.max(1, available - terminalPaneHeaderHeight);
    }
    return available;
  }

  toggleTerminalRow(): void {
    const branch = this.selectedBranchName();
    if (!branch) {
      return;
    }
    const expanding = this.sectionFor(branch) === 'collapsed';
    const keepShare = this.changesShare() !== null;
    if (expanding) {
      this.attachTerminalForOpenSection(branch);
      if (this.terminalViewCount(branch) === 0) {
        return;
      }
      this.setSection(branch, 'docked');
    } else {
      this.setSection(branch, 'collapsed');
    }
    this.fitDockedTerminal();
    if (keepShare) {
      this.applyChangesShare();
    } else {
      this.rememberChangesShare();
    }
    this.persistArrangement();
  }

  @HostListener('window:resize')
  reapplyChangesShare(): void {
    this.fitDockedTerminal();
    this.applyChangesShare();
    this.refreshMaximizedTerminal();
  }

  private captureChangesShare(): void {
    if (this.changesShare() !== null) {
      return;
    }
    this.rememberChangesShare();
  }

  private rememberChangesShare(): void {
    const room = this.paneRoom();
    if (room > 0) {
      this.changesShare.set(this.changesPaneHeight() / room);
    }
  }

  private applyChangesShare(): void {
    const room = this.paneRoom();
    if (room <= 0) {
      return;
    }
    const share = this.changesShare();
    if (share === null) {
      this.rememberChangesShare();
      return;
    }
    let changesPx = Math.round(share * room);
    if (room >= headingMinHeight * 2) {
      changesPx = Math.min(room - headingMinHeight, Math.max(headingMinHeight, changesPx));
    }
    this.changesPaneHeight.set(changesPx);
  }

  private paneRoom(): number {
    const stack = this.stackHeight();
    if (stack <= 8) {
      return 0;
    }
    return stack - 8;
  }

  private stackHeight(): number {
    if (this.terminalMaximized()) {
      return 0;
    }
    const body = this.sheetBody()?.nativeElement.clientHeight ?? 0;
    if (body <= 0) {
      return 0;
    }
    if (!this.showTerminalRow()) {
      return body;
    }
    if (!this.terminalExpanded()) {
      return body - terminalHeaderHeight;
    }
    return body - 8 - this.terminalRowHeight();
  }

  private clampChangesDrag(value: number, stack: number): number {
    if (stack < headingMinHeight * 2 + 8) {
      return value;
    }
    return Math.min(stack - 8 - headingMinHeight, Math.max(headingMinHeight, value));
  }

  private fitDockedTerminal(): void {
    if (this.terminalMaximized() || !this.terminalExpanded()) {
      return;
    }
    const body = this.sheetBody()?.nativeElement.clientHeight ?? 0;
    if (body <= 0) {
      return;
    }
    const roomForTerminal = body - 8 - (headingMinHeight * 2 + 8);
    if (roomForTerminal >= 80 && this.arrangedTerminalRowHeight > roomForTerminal) {
      this.terminalRowHeight.set(roomForTerminal);
      return;
    }
    this.terminalRowHeight.set(this.arrangedTerminalRowHeight);
  }

  private persistArrangement(): void {
    saveArrangement({
      changesShare: this.changesShare(),
      terminalRowHeight: this.arrangedTerminalRowHeight,
      changesFileWidth: this.changesFileWidth(),
      commitFileWidth: this.commitFileWidth(),
    });
  }

  private sectionFor(branch: string | null): TerminalSection {
    if (!branch) {
      return 'collapsed';
    }
    return this.terminalSectionByBranch()[branch] ?? 'collapsed';
  }

  private setSection(branch: string, section: TerminalSection): void {
    if (section !== 'collapsed' && this.terminalViewCount(branch) === 0) {
      return;
    }
    this.terminalSectionByBranch.update((current) => {
      if (section === 'collapsed') {
        if (!(branch in current)) {
          return current;
        }
        const next = { ...current };
        delete next[branch];
        return next;
      }
      if (current[branch] === section) {
        return current;
      }
      return { ...current, [branch]: section };
    });
    if (branch === this.selectedBranchName() && section !== 'maximized') {
      this.maximizedBodyHeight.set(null);
    }
  }

  toggleTerminalMaximize(): void {
    const branch = this.selectedBranchName();
    if (!branch) {
      return;
    }
    if (this.sectionFor(branch) === 'maximized') {
      if (this.terminalViewCount(branch) === 0) {
        this.setSection(branch, 'collapsed');
        return;
      }
      this.setSection(branch, 'docked');
      this.fitDockedTerminal();
      this.applyChangesShare();
      return;
    }
    this.attachTerminalForOpenSection(branch);
    if (this.terminalViewCount(branch) === 0) {
      return;
    }
    this.setSection(branch, 'maximized');
    this.captureMaximizedBody();
  }

  private attachTerminalForOpenSection(branch: string): void {
    if (this.terminalViewCount(branch) > 0) {
      return;
    }
    if (branch === this.selectedBranchName()) {
      this.adoptOpenSessions(branch);
    }
    if (this.terminalViewCount(branch) === 0 && this.terminalCount(branch) === 0) {
      this.newTerminal();
    }
  }

  private terminalViewCount(branch: string): number {
    const state = this.terminalsByBranch()[branch];
    return state?.tabs.reduce((sum, tab) => sum + tab.terminals.length, 0) ?? 0;
  }

  refreshMaximizedTerminal(): void {
    this.captureMaximizedBody();
  }

  private captureMaximizedBody(): void {
    if (!this.terminalMaximized()) {
      return;
    }
    const measured = this.sheetBody()?.nativeElement.clientHeight ?? 0;
    if (measured > terminalHeaderHeight) {
      this.maximizedBodyHeight.set(measured - terminalHeaderHeight);
    }
  }

  showTerminalRow(): boolean {
    return this.selectedBranchName() !== null && this.worktreePath() !== '' && this.activeTerminalMode() !== 'none';
  }

  sheetColumns(): string {
    if (!this.showDetail()) {
      return 'minmax(0, 1fr)';
    }
    const history = `${this.changesFileWidth()}px 8px`;
    if (this.showingCommit() && this.visibleCommitFiles().length > 0) {
      return `${history} ${this.commitFileWidth()}px 8px minmax(0, 1fr)`;
    }
    return `${history} minmax(0, 1fr)`;
  }

  showDetail(): boolean {
    return this.showingCommit() || this.selectedFilePath() !== null;
  }

  paneDiff(): string {
    if (this.showingCommit()) {
      return this.visibleCommitDiff();
    }
    return this.selectedDiff() ?? '';
  }

  readonly foldedDiff = computed(() => {
    const file = this.selectedDiffFile();
    const key = this.diffFoldKey();
    const openings = key === null ? {} : (this.foldMemory().get(key) ?? {});
    const sides = this.fullFileSides();
    return foldInlineDiff(
      this.paneDiff(),
      { oldText: sides.oldText, newText: sides.newText },
      openings,
      {
        previousPath: file?.previousPath ?? null,
        binary: file?.binary ?? false,
      },
    );
  });

  private readonly fullFileView = computed((): FullFileDiff | null => {
    if (this.diffMode() !== 'full') {
      return null;
    }
    const sides = this.fullFileSides();
    if (sides.tooLarge) {
      return { lines: [], tooLarge: true };
    }
    return fullFileLines(this.paneDiff(), sides.oldText, sides.newText);
  });

  private readonly diffWindowState = computed(() => this.buildDiffWindow());

  showInlineDiff(): boolean {
    const diff = this.foldedDiff();
    return diff.rows.length > 0 || diff.previousPath !== null || diff.binary;
  }

  showDiffTooLarge(): boolean {
    return this.fullFileView()?.tooLarge === true;
  }

  visibleDiffRows(): DiffViewRow[] {
    return this.diffWindowState().rows;
  }

  diffBodyHeight(): number {
    return this.diffWindowState().height;
  }

  diffWindowTransform(): string {
    if (this.diffClientHeight() <= 0) {
      return 'translateY(0px)';
    }
    return `translateY(${this.diffWindowState().offset}px)`;
  }

  revealFold(row: DiffViewRow, action: 'more' | 'all'): void {
    if (row.fold === null) {
      return;
    }
    const key = this.diffFoldKey();
    if (key === null) {
      return;
    }
    const current = this.foldMemory().get(key) ?? {};
    const next = action === 'more' ? openFoldMore(current, row.fold) : openFoldAll(current, row.fold);
    const memory = new Map(this.foldMemory());
    memory.set(key, next);
    this.foldMemory.set(memory);
  }

  onDiffScroll(event: Event): void {
    const element = event.currentTarget;
    if (element instanceof HTMLElement) {
      this.syncDiffViewport(element);
    }
  }

  private laidOutRows(): Array<FoldedRow | SideBySideRow> {
    const rows = this.displayedRows();
    return this.diffLayout() === 'side' ? sideBySideRows(rows) : rows;
  }

  private changeTarget(direction: 'next' | 'previous'): number | undefined {
    const position = Math.max(0, this.diffScrollTop() - this.diffHeaderHeight());
    const starts = this.changeStarts();
    if (direction === 'next') {
      return starts.find((start) => start > position + 0.5);
    }
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      const start = starts[index];
      if (start !== undefined && start < position - 0.5) {
        return start;
      }
    }
    return undefined;
  }

  private changeStarts(): number[] {
    let offset = 0;
    let inChange = false;
    const starts: number[] = [];
    for (const row of this.laidOutRows()) {
      const changed = rowIsChange(row);
      if (changed && !inChange) {
        starts.push(offset);
      }
      inChange = changed;
      offset += row.kind === 'fold' ? this.diffFoldHeight : this.diffRowHeight;
    }
    return starts;
  }

  private displayedRows(): FoldedRow[] {
    const full = this.fullFileView();
    if (full && !full.tooLarge) {
      return full.lines.map((line) => ({ kind: 'line', line }));
    }
    if (this.diffMode() === 'full') {
      return [];
    }
    return this.foldedDiff().rows;
  }

  private buildDiffWindow(): { height: number; offset: number; rows: DiffViewRow[] } {
    let offset = 0;
    const source = this.laidOutRows();
    const rows = source.map((row, index) => {
      const height = row.kind === 'fold' ? this.diffFoldHeight : this.diffRowHeight;
      const placed: DiffViewRow = {
        index,
        offset,
        height,
        kind: row.kind,
        line: row.kind === 'line' && 'line' in row ? row.line : null,
        fold: row.kind === 'fold' ? row : null,
        side: row.kind === 'line' && 'old' in row ? { old: row.old, new: row.new } : null,
      };
      offset += height;
      return placed;
    });
    const height = this.diffClientHeight();
    if (height <= 0 || rows.length === 0) {
      return { height: offset, offset: 0, rows };
    }
    const header = this.diffHeaderHeight();
    const rowScroll = Math.max(0, this.diffScrollTop() - header);
    const headerStillVisible = Math.max(0, header - this.diffScrollTop());
    const view = Math.max(this.diffRowHeight, height - headerStillVisible);
    const limit = rowScroll + view;
    let start = 0;
    while (start < rows.length && (rows[start]?.offset ?? 0) + (rows[start]?.height ?? 0) <= rowScroll) {
      start += 1;
    }
    let end = start;
    while (end < rows.length && (rows[end]?.offset ?? 0) < limit) {
      end += 1;
    }
    if (end === start && start < rows.length) {
      end = start + 1;
    }
    return { height: offset, offset: rows[start]?.offset ?? 0, rows: rows.slice(start, end) };
  }

  private diffHeaderHeight(): number {
    const diff = this.foldedDiff();
    const rows = (diff.previousPath !== null ? 1 : 0) + (diff.binary ? 1 : 0);
    return rows * this.diffRowHeight;
  }

  private diffFoldKey(): string | null {
    const path = this.selectedFilePath();
    if (path === null) {
      return null;
    }
    const place = this.showingCommit() ? (this.selectedCommitSubject() ?? '') : 'worktree';
    return `${path}\0${place}\0${this.paneDiff()}`;
  }

  private selectedDiffFile(): { previousPath: string | null; binary: boolean } | null {
    const path = this.selectedFilePath();
    if (path === null) {
      return null;
    }
    if (this.effectivePath() !== null) {
      const files = this.showingCommit() ? this.loadedCommitFiles() : this.loadedFiles();
      const file = files.find((item) => item.path === path);
      return file ? { previousPath: file.previousPath, binary: file.binary } : null;
    }
    const sample = this.showingCommit()
      ? this.selectedCommit()?.files?.find((item) => item.path === path)
      : this.selectedBranch()?.files?.find((item) => item.path === path);
    if (!sample) {
      return null;
    }
    return {
      previousPath: sample.previousPath ?? null,
      binary: sample.added === null && sample.deleted === null,
    };
  }

  private syncDiffViewport(element: HTMLElement): void {
    if (element.scrollTop !== this.diffScrollTop()) {
      this.diffScrollTop.set(element.scrollTop);
    }
    if (element.clientHeight !== this.diffClientHeight()) {
      this.diffClientHeight.set(element.clientHeight);
    }
  }

  private scheduleDiffViewport(): void {
    const element = this.diffScroller()?.nativeElement;
    if (!element) {
      return;
    }
    if (element.scrollTop === this.diffScrollTop() && element.clientHeight === this.diffClientHeight()) {
      return;
    }
    runAfterPaint(() => {
      if (element.isConnected) {
        this.syncDiffViewport(element);
      }
    });
  }

  private resetDiffScroll(): void {
    this.diffScrollTop.set(0);
    this.rememberSideScroll(0);
    const element = this.diffScroller()?.nativeElement;
    if (element) {
      element.scrollTop = 0;
    element.scrollLeft = 0;
    }
    const bar = this.sideScrollBar();
    if (bar instanceof HTMLElement && bar.scrollLeft !== 0) {
      bar.scrollLeft = 0;
    }
  }

  private rememberSideScroll(offset: number): void {
    if (offset !== this.diffSideScroll()) {
      this.diffSideScroll.set(offset);
    }
  }

  private sideScrollBar(): HTMLElement | null {
    const bar = this.diffScroller()?.nativeElement?.parentElement?.querySelector('[data-testid="diff-side-scroll"]');
    return bar instanceof HTMLElement ? bar : null;
  }

  private bindSideWheel(): void {
    const element = this.diffLayout() === 'side' ? (this.diffScroller()?.nativeElement ?? null) : null;
    if (element === this.sideWheelTarget) {
      return;
    }
    this.sideWheelTarget?.removeEventListener('wheel', this.onSideWheel);
    this.sideWheelTarget = element;
    element?.addEventListener('wheel', this.onSideWheel, { passive: false });
  }

  private readonly onSideWheel = (event: WheelEvent): void => {
    this.onDiffSideWheel(event);
  };

  readonly maxSideChars = computed(() => {
    if (this.diffLayout() !== 'side') {
      return 0;
    }
    let chars = 0;
    for (const row of this.laidOutRows()) {
      if (row.kind !== 'line' || !('old' in row)) {
        continue;
      }
      chars = Math.max(chars, row.old.text.length, row.new.text.length);
    }
    return chars;
  });

  moveSplit(event: PointerEvent): void {
    const drag = this.splitDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const point = drag.axis === 'x' ? event.clientX : event.clientY;
    const delta = point - drag.start;
    const next = drag.invert ? drag.origin - delta : drag.origin + delta;
    drag.apply(clampSplit(next, drag.limit));
  }

  endSplit(event: PointerEvent): void {
    if (this.splitDrag?.pointerId !== event.pointerId) {
      return;
    }
    if (this.splitDrag.rememberTerminal) {
      this.arrangedTerminalRowHeight = this.terminalRowHeight();
    }
    this.splitDrag = null;
    this.persistArrangement();
  }

  private beginSplit(
    event: PointerEvent,
    axis: 'x' | 'y',
    origin: number,
    apply: (value: number) => void,
    occupied = 0,
    invert = false,
    reserved = 80,
    rememberTerminal = false,
  ): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.captureSplit(event);
    const parent = (event.currentTarget as HTMLElement | null)?.parentElement ?? null;
    const span = parent === null ? 0 : axis === 'x' ? parent.clientWidth : parent.clientHeight;
    const room = span - 8 - reserved - occupied;
    this.splitDrag = {
      pointerId: event.pointerId,
      axis,
      start: axis === 'x' ? event.clientX : event.clientY,
      origin,
      limit: room >= 80 ? room : undefined,
      invert,
      rememberTerminal,
      apply,
    };
  }

  private captureSplit(event: PointerEvent): void {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) {
      return;
    }
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some test environments.
    }
  }

  dragWindow(event: PointerEvent): void {
    const target = event.target;
    const element = target instanceof Element ? target : null;
    if (
      element?.closest(
        '[data-testid="repository-tab"], [data-testid="open-repository-card"], [data-testid="terminals"], [data-testid="repository-settings"], [data-testid="app-settings"], [data-testid="window-minimize"], [data-testid="window-maximize"], [data-testid="window-close"]',
      )
    ) {
      return;
    }
    requestWindowAction('drag');
  }

  copyBranchName(name: string): void {
    copyText(name);
  }

  openSwitch(): void {
    this.overlayOpen.set(true);
  }

  closeSwitch(): void {
    this.overlayOpen.set(false);
  }

  closeSwitchOutside(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeSwitch();
    }
  }

  @HostListener('document:contextmenu', ['$event'])
  closeBranchMenuOnContextMenu(event: MouseEvent): void {
    if (this.openBranch() === null) {
      return;
    }
    const target = event.target;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (element?.closest('[data-testid="branch-row"]')) {
      return;
    }
    event.preventDefault();
    this.openBranch.set(null);
  }

  @HostListener('document:click', ['$event'])
  closeBranchMenuOutside(event: Event): void {
    this.closeTerminalMenuOnClick(event);
    this.closePresetMenuOnClick(event);
    this.closeRepositoryTabMenuOnClick(event);
    const name = this.openBranch();
    if (name === null) {
      return;
    }
    const target = event.target;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    const menu = element?.closest('[data-testid="hover-menu"]');
    const branch = menu?.closest('[data-branch]')?.getAttribute('data-branch');
    if (branch === name) {
      return;
    }
    this.openBranch.set(null);
  }

  @HostListener('document:keydown', ['$event'])
  closeSwitchOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.oldSessionChoices().length > 0) {
      this.dismissOldSessions();
      return;
    }
    if (this.pendingTerminalMode() !== null) {
      this.cancelTerminalMode();
      return;
    }
    if (this.appSettingsOpen()) {
      this.closeAppSettings();
      return;
    }
    if (this.addDialogOpen()) {
      this.cancelAdd();
      return;
    }
    if (this.repositorySettings()?.closeOnEscape()) {
      return;
    }
    if (this.mergeDialogBranch()) {
      this.cancelMerge();
      return;
    }
    if (this.removeDialogBranch() && this.branchActivity()?.label !== 'Removing worktree') {
      this.cancelRemove();
      return;
    }
    if (this.createDialogOpen()) {
      this.cancelCreate();
      return;
    }
    if (this.repositoryTabMenu() !== null) {
      this.repositoryTabMenu.set(null);
      return;
    }
    if (this.overlayOpen()) {
      this.closeSwitch();
      return;
    }
    if (this.renaming() !== null) {
      this.cancelRename();
      return;
    }
    if (this.terminalMenu() !== null) {
      this.closeTerminalMenu();
      return;
    }
    if (this.presetMenu() !== null) {
      this.presetMenu.set(null);
      return;
    }
    if (this.openBranch() !== null) {
      this.openBranch.set(null);
    }
  }

  openAppSettings(): void {
    const settings = readAppSettings();
    this.defaultLayout.set(settings.defaultLayout);
    this.ideCommand.set(settings.ideCommand);
    this.terminalMode.set(settings.terminalMode);
    this.shellCommand.set(settings.shellCommand);
    this.shellCommandDraft.set(settings.shellCommand);
    this.terminalFont.set(settings.terminalFont);
    this.terminalBackground.set(settings.terminalBackground);
    this.terminalForeground.set(settings.terminalForeground);
    this.appSettingsOpen.set(true);
  }

  chooseDefaultLayout(layout: AppSettings['defaultLayout']): void {
    saveDefaultLayout(layout);
    this.defaultLayout.set(layout);
  }

  chooseIdeCommand(event: Event): void {
    const command = inputValue(event);
    saveIdeCommand(command);
    this.ideCommand.set(command);
  }

  chooseTerminalFont(event: Event): void {
    const font = inputValue(event);
    saveTerminalFont(font);
    this.terminalFont.set(font);
  }

  requestTerminalMode(mode: TerminalMode, event: Event): void {
    event.preventDefault();
    if (mode === 'tmux' && !this.tmuxInstalled()) {
      this.syncTerminalModeRadios(event);
      return;
    }
    if (mode === this.terminalMode()) {
      this.syncTerminalModeRadios(event);
      return;
    }
    const leaving = this.activeTerminalMode();
    if (mode !== leaving && modeHasRunningTerminals(leaving, this.terminalsByBranch())) {
      this.pendingTerminalMode.set(mode);
      this.syncTerminalModeRadios(event);
      return;
    }
    this.commitTerminalMode(mode, false);
    this.syncTerminalModeRadios(event);
  }

  beginShellCommandEdit(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.shellCommandDraft.set(this.shellCommand());
    this.shellCommandEditing.set(true);
  }

  chooseShellCommand(event: Event): void {
    const value = inputValue(event);
    this.shellCommandDraft.set(value);
    saveShellCommand(value);
    this.shellCommand.set(value);
    this.clearShellStartError();
  }

  keepTerminalMode(): void {
    const mode = this.pendingTerminalMode();
    if (mode === null) {
      return;
    }
    this.commitTerminalMode(mode, false);
    this.syncTerminalModeRadios();
  }

  killTerminalMode(): void {
    const mode = this.pendingTerminalMode();
    if (mode === null) {
      return;
    }
    this.commitTerminalMode(mode, true);
    this.syncTerminalModeRadios();
  }

  cancelTerminalMode(): void {
    this.pendingTerminalMode.set(null);
    this.syncTerminalModeRadios();
  }

  dismissTerminalModeFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.cancelTerminalMode();
    }
  }

  openIde(): void {
    const command = this.ideCommand();
    if (command === '') {
      return;
    }
    let cwd = '';
    try {
      cwd = this.headingCheckout();
    } catch (error) {
      this.workspaceError.set(errorText(error));
      return;
    }
    if (cwd === '') {
      this.workspaceError.set('No checkout for this branch');
      return;
    }
    this.workspaceError.set(null);
    let pending: void | Promise<void>;
    try {
      pending = launchIde(command, cwd);
    } catch (error) {
      this.workspaceError.set(errorText(error));
      return;
    }
    if (!isPromise(pending)) {
      return;
    }
    void pending.catch((error: unknown) => {
      this.zone.run(() => {
        this.workspaceError.set(errorText(error));
      });
    });
  }

  private headingCheckout(): string {
    const chosen = this.chosenTerminalWorktree();
    if (chosen) {
      return findCheckout(chosen.path, chosen.branch) ?? '';
    }
    const repo = this.effectivePath();
    const branch = this.selectedBranchName();
    if (repo && branch) {
      return findCheckout(repo, branch) ?? '';
    }
    return this.worktreePath();
  }

  chooseSidebarColor(event: Event): void {
    this.applySidebarColor(inputValue(event));
  }

  chooseSidebarSwatch(color: string): void {
    this.applySidebarColor(color);
  }

  chooseContentColor(event: Event): void {
    this.applyContentColor(inputValue(event));
  }

  chooseContentSwatch(color: string): void {
    this.applyContentColor(color);
  }

  chooseTerminalBackground(event: Event): void {
    this.applyTerminalBackground(inputValue(event));
  }

  chooseTerminalBackgroundSwatch(color: string): void {
    this.applyTerminalBackground(color);
  }

  chooseTerminalForeground(event: Event): void {
    this.applyTerminalForeground(inputValue(event));
  }

  chooseTerminalForegroundSwatch(color: string): void {
    this.applyTerminalForeground(color);
  }

  isSelectedColor(current: string, swatch: string): boolean {
    return current.toLowerCase() === swatch.toLowerCase();
  }

  chooseSidebarText(text: SidebarText): void {
    saveSidebarText(text);
    this.sidebarText.set(text);
    this.applyOpenRepositoryAppearance();
  }

  renameOpenRepository(change: { path: string; displayName: string }): void {
    this.registered.set(listRepositories());
    this.repositoryTabs.update((tabs) =>
      tabs.map((tab) => (tab.path === change.path ? { ...tab, name: change.displayName } : tab)),
    );
    if (this.effectivePath() === change.path) {
      this.selectedName.set(change.displayName);
    }
  }

  applyOpenRepositoryAppearance(): void {
    const settings = readAppSettings();
    if (this.terminalsOpen()) {
      this.paintedSidebarColor.set(settings.sidebarColor);
      this.paintedSidebarText.set(settings.sidebarText);
      return;
    }
    const path = this.effectivePath();
    const own = path === null ? {} : readRepositoryAppearance(path);
    this.paintedSidebarColor.set(own.sidebarColor ?? settings.sidebarColor);
    this.paintedSidebarText.set(own.sidebarText ?? settings.sidebarText);
  }

  repositoryTabSidebarColor(path: string): string {
    return this.repositoryTabAppearance(path).sidebarColor;
  }

  repositoryTabSidebarTextColor(path: string): string {
    return this.repositoryTabAppearance(path).sidebarText === 'black' ? '#000000' : '#ffffff';
  }

  repositoryTabFrame(path: string): string {
    if (this.terminalsOpen() || this.effectivePath() !== path) {
      return 'none';
    }
    return `2px solid ${this.repositoryTabSidebarTextColor(path)}`;
  }

  private repositoryTabAppearance(path: string): { sidebarColor: string; sidebarText: SidebarText } {
    const settings = readAppSettings();
    const own = readRepositoryAppearance(path);
    return {
      sidebarColor: own.sidebarColor ?? settings.sidebarColor,
      sidebarText: own.sidebarText ?? settings.sidebarText,
    };
  }

  private applySidebarColor(color: string): void {
    saveSidebarColor(color);
    this.sidebarColor.set(color);
    this.applyOpenRepositoryAppearance();
  }

  private applyContentColor(color: string): void {
    saveContentColor(color);
    this.contentColor.set(color);
  }

  private applyTerminalBackground(color: string): void {
    saveTerminalBackground(color);
    this.terminalBackground.set(color);
  }

  private applyTerminalForeground(color: string): void {
    saveTerminalForeground(color);
    this.terminalForeground.set(color);
  }

  resetColors(): void {
    resetAppColors();
    const settings = readAppSettings();
    this.sidebarColor.set(settings.sidebarColor);
    this.sidebarText.set(settings.sidebarText);
    this.contentColor.set(settings.contentColor);
    this.terminalBackground.set(settings.terminalBackground);
    this.terminalForeground.set(settings.terminalForeground);
    this.applyOpenRepositoryAppearance();
  }

  createLayoutLine(): string {
    return formatCreateLayout(this.effectivePath());
  }

  closeAppSettings(): void {
    this.pendingTerminalMode.set(null);
    this.shellCommandEditing.set(false);
    this.appSettingsOpen.set(false);
  }

  dismissAppSettingsFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.closeAppSettings();
    }
  }

  updateBranch(name: string, event: Event): void {
    event.stopPropagation();
    this.runBranchAction(name, 'Updating from master', () => updateFromMaster(this.effectivePath() ?? '', name, false), 'refresh-selected');
  }

  mergeBranch(name: string, event: Event): void {
    event.stopPropagation();
    this.workspaceError.set(null);
    this.mergeSquash.set(false);
    this.mergeDialogBranch.set(name);
  }

  setMergeSquash(event: Event): void {
    const target = event.target as { checked?: boolean } | null;
    this.mergeSquash.set(target?.checked === true);
  }

  cancelMerge(): void {
    this.workspaceError.set(null);
    this.mergeSquash.set(false);
    this.mergeDialogBranch.set(null);
  }

  dismissMergeFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.cancelMerge();
    }
  }

  confirmMerge(): void {
    const name = this.mergeDialogBranch();
    if (!name) {
      return;
    }
    this.runBranchAction(
      name,
      'Merging into master',
      () => mergeIntoMaster(this.effectivePath() ?? '', name, this.mergeSquash()),
      'refresh-selected',
      () => {
        this.mergeSquash.set(false);
        this.mergeDialogBranch.set(null);
      },
    );
  }

  canPinWorktree(name: string): boolean {
    return this.effectivePath() !== null && name !== this.defaultBranchName() && name !== this.primaryBranchName();
  }

  canRemoveWorktree(name: string): boolean {
    return name !== this.defaultBranchName() && name !== this.primaryBranchName();
  }

  toggleWorktreePin(name: string, event: Event): void {
    event.stopPropagation();
    const path = this.effectivePath();
    if (path === null || !this.canPinWorktree(name)) {
      return;
    }
    if (this.pinnedWorktrees().includes(name)) {
      unpinWorktree(path, name);
    } else {
      pinWorktree(path, name);
    }
    this.refreshBranches();
  }

  removeBranch(name: string, event: Event): void {
    event.stopPropagation();
    if (!this.canRemoveWorktree(name)) {
      return;
    }
    this.workspaceError.set(null);
    this.removeForceDelete.set(false);
    this.removeDialogBranch.set(name);
  }

  cancelRemove(): void {
    if (this.branchActivity()?.label === 'Removing worktree') {
      return;
    }
    this.workspaceError.set(null);
    this.removeForceDelete.set(false);
    this.removeDialogBranch.set(null);
  }

  dismissRemoveFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.cancelRemove();
    }
  }

  confirmRemoveWorktree(deleteBranch: boolean): void {
    const name = this.removeDialogBranch();
    const repo = this.effectivePath();
    if (!name || !repo || this.branchActivity()?.label === 'Removing worktree') {
      return;
    }
    this.workspaceError.set(null);
    this.branchActivity.set({ branch: name, label: 'Removing worktree' });
    const selected = this.selectedBranchName();
    const force = deleteBranch && this.removeForceDelete();
    this.runWhenPainted(() => {
      void removeWorktree(repo, name, { deleteBranch, force }).then(
        () => {
          this.zone.run(() => {
            if (this.openBranch() === name) {
              this.openBranch.set(null);
            }
            this.refreshBranches([]);
            if (selected === name) {
              this.clearBranchSelection();
            }
            this.removeDialogBranch.set(null);
            this.branchActivity.set(null);
          });
        },
        (error: unknown) => {
          this.zone.run(() => {
            const message = errorText(error);
            this.branchActivity.set(null);
            this.workspaceError.set(message);
            if (deleteBranch && message.toLowerCase().includes('use --force to delete it')) {
              this.removeForceDelete.set(true);
            }
          });
        },
      );
    });
  }

  publishBranch(name: string, event: Event): void {
    event.stopPropagation();
    this.runBranchAction(name, 'Pushing', () => pushBranch(this.effectivePath() ?? '', name), 'refresh-selected');
  }

  openCreateDialog(): void {
    this.workspaceError.set(null);
    this.creatingWorktree.set(false);
    this.createBranchName.set('');
    const path = this.effectivePath();
    this.createDialogOpen.set(true);
    if (path === null) {
      this.branchNamesLoading.set(false);
      this.createBranchOptions.set([]);
      return;
    }
    this.createBranchOptions.set([]);
    this.branchNamesLoading.set(true);
    this.runWhenPainted(() => {
      try {
        this.createBranchOptions.set(listRemoteBranchesWithoutWorktree(path));
        this.branchNamesLoading.set(false);
      } catch (error) {
        this.branchNamesLoading.set(false);
        this.workspaceError.set(errorText(error));
      }
    });
  }

  cancelCreate(): void {
    this.workspaceError.set(null);
    this.createBranchName.set('');
    this.branchNamesLoading.set(false);
    this.creatingWorktree.set(false);
    this.createDialogOpen.set(false);
  }

  dismissCreateFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.cancelCreate();
    }
  }

  setCreateBranchName(event: Event): void {
    this.createBranchName.set(inputValue(event));
  }

  chooseCreateBranch(name: string): void {
    this.createBranchName.set(name);
  }

  createBranch(): Promise<void> {
    const repo = this.effectivePath();
    if (!repo || this.creatingWorktree() || this.branchNamesLoading()) {
      return Promise.resolve();
    }
    if (this.createBranchName().trim() === '') {
      this.workspaceError.set('Enter a branch name');
      return Promise.resolve();
    }
    this.workspaceError.set(null);
    const branchName = this.createBranchName();
    this.creatingWorktree.set(true);
    return new Promise((resolve) => {
      this.runWhenPainted(() => {
        void createWorktree(repo, branchName).then(
          () => {
            this.zone.run(() => {
              this.refreshBranches([branchName]);
              this.createDialogOpen.set(false);
              this.createBranchName.set('');
              this.creatingWorktree.set(false);
              resolve();
            });
          },
          (error: unknown) => {
            this.zone.run(() => {
              this.creatingWorktree.set(false);
              this.workspaceError.set(errorText(error));
              resolve();
            });
          },
        );
      });
    });
  }

  private runBranchAction(
    name: string,
    label: string,
    action: () => void,
    effect: 'remove' | 'refresh-selected',
    onSuccess?: () => void,
  ): void {
    if (!this.effectivePath()) {
      return;
    }
    this.workspaceError.set(null);
    const selected = this.selectedBranchName();
    this.branchActivity.set({ branch: name, label });
    this.runWhenPainted(() => {
      try {
        action();
        this.refreshBranches(effect === 'remove' ? [] : [name]);
        if (effect === 'remove') {
          if (selected === name) {
            this.clearBranchSelection();
          }
        } else if (selected === name) {
          this.loadBranchContent(name);
        }
        onSuccess?.();
        this.branchActivity.set(null);
      } catch (error) {
        this.branchActivity.set(null);
        this.workspaceError.set(errorText(error));
      }
    });
  }

  private openTerminals(branch: string): void {
    const repo = this.effectivePath();
    if (!repo) {
      this.worktreePath.set('');
      return;
    }
    const cwd = findCheckout(repo, branch);
    if (!cwd) {
      this.worktreePath.set('');
      return;
    }
    this.worktreePath.set(cwd);
    this.presetMenu.set(null);
    this.syncCommittedPreset(cwd);
    const existing = this.terminalsByBranch()[branch];
    if (existing && existing.tabs.length > 0) {
      return;
    }
    if (this.activeTerminalMode() === 'none') {
      return;
    }
    if (sessionsForBranch(repo, branch).length > 0) {
      this.storeBranch(branch, this.adoptTmuxSessions(repo, branch, cwd));
    }
  }

  private adoptTmuxSessions(repo: string, branch: string, cwd: string): WorktreeTerminalView {
    const sessions = sessionsForBranch(repo, branch);
    const tabs = sessions.map((session) =>
      this.makeTab([adoptedTmuxTerminal(this.nextTerminalKey('terminal'), cwd, session)]),
    );
    return { tabs, focusedTabId: tabs[0]?.id ?? '' };
  }

  private clearTerminals(): void {
    this.worktreePath.set('');
    this.presetMenu.set(null);
    this.clearPresetWorkspaceError();
    this.terminalsByBranch.set({});
    this.terminalSectionByBranch.set({});
    this.maximizedBodyHeight.set(null);
    this.closeTerminalMenu();
    this.renaming.set(null);
  }

  private collapseWorktreesWithoutTerminals(): void {
    const branches = new Set(Object.keys(this.terminalsByBranch()));
    const selected = this.selectedBranchName();
    if (selected) {
      branches.add(selected);
    }
    for (const branch of branches) {
      if (this.terminalCount(branch) === 0) {
        this.setSection(branch, 'collapsed');
      }
    }
  }

  private syncCommittedPreset(checkout: string): void {
    const read = readCheckoutPresets(checkout);
    this.publishPresets(read.presets);
    if (read.error !== null) {
      this.workspaceError.set(read.error);
      return;
    }
    this.clearPresetWorkspaceError();
  }

  private publishPresets(presets: CommittedPreset[] | null): void {
    if (!samePresetNames(this.shownPresets(), presets)) {
      this.shownPresets.set(presets);
    }
    const menu = this.presetMenu();
    if (menu === null) {
      return;
    }
    const names = presets?.map((preset) => preset.name) ?? [];
    if (names.length === 0) {
      this.presetMenu.set(null);
      return;
    }
    if (names.length === menu.names.length && names.every((name, index) => name === menu.names[index])) {
      return;
    }
    this.presetMenu.set({ x: menu.x, y: menu.y, names });
  }

  private clearPresetWorkspaceError(): void {
    const message = this.workspaceError();
    if (message !== null && isPresetWorkspaceError(message)) {
      this.workspaceError.set(null);
    }
  }

  private presetCheckout(): string {
    if (this.chosenTerminalWorktree()) {
      return this.terminalsPresetCheckout;
    }
    return this.worktreePath();
  }

  private chosenTerminalWorktree(): { path: string; branch: string } | null {
    if (!this.terminalsOpen()) {
      return null;
    }
    return this.terminalsWorktree();
  }

  private readPresetsForRun(): CommittedPreset[] | null {
    const checkout = this.presetCheckout();
    if (checkout === '') {
      return null;
    }
    const read = readCheckoutPresets(checkout);
    if (read.error !== null) {
      this.workspaceError.set(read.error);
    }
    return read.presets;
  }

  private appendPreset(preset: CommittedPreset): void {
    const checkout = this.presetCheckout();
    const chosen = this.chosenTerminalWorktree();
    const branch = chosen?.branch ?? this.selectedBranchName();
    if (checkout === '' || !branch) {
      return;
    }
    const opened: TerminalTabView[] = [];
    const startedSessions: string[] = [];
    let failure: string | null = null;
    for (const spec of preset.tabs) {
      const started: TerminalView[] = [];
      for (const terminalSpec of spec.terminals) {
        const directory = terminalDirectory(checkout, terminalSpec.directory);
        const terminal = this.spawnPresetTerminal(directory, terminalSpec.name, startedSessions);
        if (!terminal) {
          const message = this.workspaceError();
          if (message !== null) {
            failure = message;
          }
          continue;
        }
        if (terminal.session.length > 0) {
          startedSessions.push(terminal.session);
        }
        if (terminalSpec.command.length > 0) {
          if (terminal.host === 'tmux') {
            typeTmuxStartupCommand(terminal.session, terminalSpec.command);
          } else {
            typeStartupCommand(terminal.id, terminalSpec.command);
          }
        }
        started.push(terminal);
        if (failure !== null) {
          this.workspaceError.set(failure);
        }
      }
      if (started.length === 0) {
        continue;
      }
      const tab = this.makeTab(started);
      const left = started[0];
      if (started.length > 1 && left) {
        tab.focusedTerminalId = left.id;
      }
      opened.push(tab);
    }
    if (opened.length === 0) {
      return;
    }
    this.updateSelected((state) => {
      let next = state;
      for (const tab of opened) {
        next = withNewTab(next, tab);
      }
      const first = opened[0];
      if (!first) {
        return next;
      }
      return { ...next, focusedTabId: first.id };
    });
    if (!chosen && this.sectionFor(branch) !== 'maximized') {
      this.setSection(branch, 'docked');
    }
    this.closeTerminalMenu();
  }

  private closePresetMenuOnClick(event: Event): void {
    if (this.presetMenu() === null) {
      return;
    }
    const target = event.target;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (element?.closest('[data-testid="preset-menu"]')) {
      return;
    }
    this.presetMenu.set(null);
  }

  private spawnPresetTerminal(cwd: string, name: string, earlierSessions: readonly string[]): TerminalView | null {
    const chosen = this.chosenTerminalWorktree();
    const repo = chosen?.path ?? this.effectivePath();
    const branch = chosen?.branch ?? this.selectedBranchName();
    if (!repo || !branch || cwd === '' || this.activeTerminalMode() === 'none') {
      return null;
    }
    const id = this.nextTerminalKey('terminal');
    const knownSessions = [
      ...this.readBranchTerminals(repo, branch).tabs.flatMap((tab) =>
        tab.terminals.flatMap((terminal) => (terminal.session.length > 0 ? [terminal.session] : [])),
      ),
      ...earlierSessions,
    ];
    try {
      const terminal = startTerminal({
        id,
        mode: this.activeTerminalMode(),
        repo,
        branch,
        cwd,
        shellCommand: this.shellCommand(),
        knownSessions,
      });
      if (!terminal) {
        return null;
      }
      this.clearShellStartError();
      return { ...terminal, customName: name };
    } catch (error) {
      this.workspaceError.set(errorText(error));
      return null;
    }
  }

  private spawnTerminal(): TerminalView | null {
    const chosen = this.chosenTerminalWorktree();
    const repo = chosen?.path ?? this.effectivePath();
    const branch = chosen?.branch ?? this.selectedBranchName();
    const cwd = chosen ? (findCheckout(chosen.path, chosen.branch) ?? '') : this.worktreePath();
    if (!repo || !branch || !cwd || this.activeTerminalMode() === 'none') {
      return null;
    }
    const id = this.nextTerminalKey('terminal');
    const knownSessions = this.readBranchTerminals(repo, branch).tabs.flatMap((tab) =>
      tab.terminals.map((terminal) => terminal.session),
    );
    try {
      const terminal = startTerminal({
        id,
        mode: this.activeTerminalMode(),
        repo,
        branch,
        cwd,
        shellCommand: this.shellCommand(),
        knownSessions,
      });
      if (terminal) {
        this.clearShellStartError();
      }
      return terminal;
    } catch (error) {
      this.workspaceError.set(errorText(error));
      return null;
    }
  }

  private activeTerminalMode(): TerminalMode {
    const saved = this.terminalMode();
    if (saved === 'tmux' && !this.tmuxInstalled()) {
      return 'terminal';
    }
    return saved;
  }

  private commitTerminalMode(mode: TerminalMode, kill: boolean): void {
    const leaving = this.activeTerminalMode();
    if (kill) {
      this.killTerminalsOfMode(leaving);
      this.rememberTmuxSessions();
    }
    saveTerminalMode(mode);
    this.terminalMode.set(mode);
    this.pendingTerminalMode.set(null);
    const branch = this.selectedBranchName();
    if (!kill && mode !== 'none' && branch) {
      this.adoptOpenSessions(branch);
    }
    if (mode !== 'none') {
      this.collapseWorktreesWithoutTerminals();
    }
  }

  private syncTerminalModeRadios(event?: Event): void {
    const saved = this.terminalMode();
    const target = event?.target;
    const from = target instanceof Element ? target : null;
    const dialog = from?.closest('[data-testid="app-settings-dialog"]') ?? document.querySelector('[data-testid="app-settings-dialog"]');
    if (!dialog) {
      return;
    }
    for (const mode of ['none', 'terminal', 'tmux'] as const) {
      const radio = dialog.querySelector(`[data-testid="terminal-mode-${mode}"]`);
      if (radio instanceof HTMLInputElement) {
        radio.checked = mode === saved;
      }
    }
  }

  private killTerminalsOfMode(mode: TerminalMode): void {
    if (mode === 'none') {
      return;
    }
    stopModeSessions(mode);
    const next: Record<string, WorktreeTerminalView> = {};
    for (const [branch, state] of Object.entries(this.terminalsByBranch())) {
      let current = state;
      for (const target of terminalsForMode(mode, state)) {
        const result = withoutTerminal(current, target.tabId, target.terminal.id);
        current = result.state;
        if (result.removed.length > 0) {
          stopTerminal(target.terminal);
        }
      }
      next[branch] = current;
    }
    this.terminalsByBranch.set(next);
    this.closeTerminalMenu();
    this.renaming.set(null);
  }

  private adoptOpenSessions(branch: string): void {
    const existing = this.terminalsByBranch()[branch];
    if (existing && existing.tabs.length > 0) {
      return;
    }
    const repo = this.effectivePath();
    const cwd = this.worktreePath();
    if (!repo || cwd === '') {
      return;
    }
    if (sessionsForBranch(repo, branch).length === 0) {
      return;
    }
    this.storeBranch(branch, this.adoptTmuxSessions(repo, branch, cwd));
  }

  private clearShellStartError(): void {
    const message = this.workspaceError();
    if (message !== null && message.startsWith('Could not start ')) {
      this.workspaceError.set(null);
    }
  }

  private makeTab(terminals: TerminalView[]): TerminalTabView {
    const focused = terminals[terminals.length - 1];
    return {
      id: this.nextTerminalKey('tab'),
      customName: '',
      terminals,
      focusedTerminalId: focused?.id ?? '',
      splitRatio: 0.5,
    };
  }

  private nextTerminalKey(prefix: string): string {
    this.terminalSerial += 1;
    return `${prefix}-${this.terminalSerial}`;
  }

  private storeBranch(branch: string, state: WorktreeTerminalView): void {
    this.terminalsByBranch.update((current) => ({ ...current, [branch]: state }));
  }

  private readBranchTerminals(path: string, branch: string): WorktreeTerminalView {
    if (path === this.effectivePath()) {
      return this.terminalsByBranch()[branch] ?? emptyTerminals();
    }
    return this.repositoryWorkspaces.get(path)?.terminalsByBranch[branch] ?? emptyTerminals();
  }

  private writeBranchTerminals(path: string, branch: string, state: WorktreeTerminalView): void {
    if (path === this.effectivePath()) {
      this.storeBranch(branch, state);
      return;
    }
    const saved = this.repositoryWorkspaces.get(path);
    if (!saved) {
      return;
    }
    saved.terminalsByBranch = { ...saved.terminalsByBranch, [branch]: state };
    this.storedTerminalEpoch.update((value) => value + 1);
  }

  private updateSelected(change: (state: WorktreeTerminalView) => WorktreeTerminalView): void {
    const chosen = this.chosenTerminalWorktree();
    if (chosen) {
      const state = this.readBranchTerminals(chosen.path, chosen.branch);
      this.writeBranchTerminals(chosen.path, chosen.branch, change(state));
      return;
    }
    const branch = this.selectedBranchName();
    if (!branch) {
      return;
    }
    this.terminalsByBranch.update((current) => {
      const state = current[branch] ?? emptyTerminals();
      return { ...current, [branch]: change(state) };
    });
  }

  private removeTerminal(branch: string, tabId: string, terminalId: string, path?: string): void {
    const repo = path ?? this.effectivePath();
    if (!repo) {
      return;
    }
    const state = this.readBranchTerminals(repo, branch);
    const tab = state.tabs.find((item) => item.id === tabId);
    const terminal = tab?.terminals.find((item) => item.id === terminalId);
    if (!terminal) {
      return;
    }
    const result = withoutTerminal(state, tabId, terminalId);
    this.writeBranchTerminals(repo, branch, result.state);
    stopTerminal(terminal);
    this.rememberTmuxSessions();
    if (repo === this.effectivePath()) {
      this.collapseIfEmpty(branch, result.state);
    }
    this.releaseChosenWorktree(repo, branch, result.state);
    this.leaveTerminalsIfCountReachesZero();
    this.closeTerminalMenu();
  }

  private releaseChosenWorktree(path: string, branch: string, state: WorktreeTerminalView): void {
    const chosen = this.terminalsWorktree();
    if (!chosen || chosen.path !== path || chosen.branch !== branch) {
      return;
    }
    if (countBranchTerminals(path, branch, state, this.tmuxSessionRecords()) > 0) {
      return;
    }
    this.terminalsWorktree.set(null);
  }

  private removeTab(branch: string, tabId: string, path?: string): void {
    const repo = path ?? this.effectivePath();
    if (!repo) {
      return;
    }
    const state = this.readBranchTerminals(repo, branch);
    const result = withoutTab(state, tabId);
    this.writeBranchTerminals(repo, branch, result.state);
    for (const terminal of result.removed) {
      stopTerminal(terminal);
    }
    this.rememberTmuxSessions();
    if (repo === this.effectivePath()) {
      this.collapseIfEmpty(branch, result.state);
    }
    this.releaseChosenWorktree(repo, branch, result.state);
    this.leaveTerminalsIfCountReachesZero();
    this.closeTerminalMenu();
  }

  private collapseIfEmpty(branch: string, state: WorktreeTerminalView): void {
    if (state.tabs.length === 0) {
      this.setSection(branch, 'collapsed');
    }
  }

  private locateTerminal(terminalId: string): { branch: string; tabId: string } | null {
    for (const [branch, state] of Object.entries(this.terminalsByBranch())) {
      for (const tab of state.tabs) {
        if (tab.terminals.some((terminal) => terminal.id === terminalId)) {
          return { branch, tabId: tab.id };
        }
      }
    }
    return null;
  }

  private startCommandPoll(): void {
    this.zone.runOutsideAngular(() => {
      this.commandPoll = setInterval(() => {
        try {
          const plan = this.planTerminalRefresh();
          if (plan.sessions === null && plan.terminals === null && plan.stored.length === 0) {
            return;
          }
          this.zone.run(() => {
            if (plan.sessions) {
              this.tmuxSessionRecords.set(plan.sessions);
            }
            if (plan.terminals) {
              this.terminalsByBranch.set(plan.terminals.next);
              for (const branch of plan.terminals.collapsedBranches) {
                this.setSection(branch, 'collapsed');
              }
            }
            if (plan.stored.length > 0) {
              for (const update of plan.stored) {
                const saved = this.repositoryWorkspaces.get(update.path);
                if (!saved) {
                  continue;
                }
                saved.terminalsByBranch = update.terminals;
                if (update.collapsedBranches.length > 0) {
                  const sections = { ...saved.terminalSectionByBranch };
                  for (const branch of update.collapsedBranches) {
                    delete sections[branch];
                  }
                  saved.terminalSectionByBranch = sections;
                }
              }
              this.storedTerminalEpoch.update((value) => value + 1);
            }
            const chosen = this.terminalsWorktree();
            if (chosen) {
              this.releaseChosenWorktree(
                chosen.path,
                chosen.branch,
                this.readBranchTerminals(chosen.path, chosen.branch),
              );
            }
            this.leaveTerminalsIfCountReachesZero();
          });
        } catch {
          // The next poll retries the terminal inspection.
        }
      }, 250);
    });
  }

  private planTerminalRefresh(): {
    sessions: TmuxSessionRecord[] | null;
    terminals: { next: Record<string, WorktreeTerminalView>; collapsedBranches: string[] } | null;
    stored: { path: string; terminals: Record<string, WorktreeTerminalView>; collapsedBranches: string[] }[];
  } {
    const snapshots = this.shouldWatchTmux() ? listTmuxSessionSnapshots() : null;
    let sessions: TmuxSessionRecord[] | null = null;
    if (snapshots) {
      const next = snapshots.map((snapshot) => ({ name: snapshot.name, branch: snapshot.branch }));
      if (!sameSessionRecords(this.tmuxSessionRecords(), next)) {
        sessions = next;
      }
    }
    const bySession = new Map(snapshots?.map((snapshot) => [snapshot.name, snapshot]) ?? []);
    const current = this.refreshTerminalBranches(this.terminalsByBranch(), snapshots, bySession);
    const live = this.terminalsByBranch();
    const stored: { path: string; terminals: Record<string, WorktreeTerminalView>; collapsedBranches: string[] }[] = [];
    for (const [path, workspace] of this.repositoryWorkspaces) {
      if (workspace.terminalsByBranch === live) {
        continue;
      }
      const refreshed = this.refreshTerminalBranches(workspace.terminalsByBranch, snapshots, bySession);
      if (refreshed) {
        stored.push({ path, terminals: refreshed.next, collapsedBranches: refreshed.collapsedBranches });
      }
    }
    return {
      sessions,
      terminals: current,
      stored,
    };
  }

  private refreshTerminalBranches(
    current: Record<string, WorktreeTerminalView>,
    snapshots: TmuxSessionSnapshot[] | null,
    bySession: Map<string, TmuxSessionSnapshot>,
  ): { next: Record<string, WorktreeTerminalView>; collapsedBranches: string[] } | null {
    let next = current;
    const collapsedBranches: string[] = [];
    for (const [branch, state] of Object.entries(current)) {
      for (const tab of state.tabs) {
        for (const terminal of tab.terminals) {
          const latest = next[branch];
          if (!latest || !branchHasTerminal(latest, terminal.id)) {
            continue;
          }
          const live = terminalLiveness(terminal, snapshots === null ? null : bySession);
          if (!live.alive) {
            const result = withoutTerminal(latest, tab.id, terminal.id);
            next = { ...next, [branch]: result.state };
            stopTerminal(terminal);
            if (result.state.tabs.length === 0) {
              collapsedBranches.push(branch);
            }
            continue;
          }
          if (live.command.length > 0 && live.command !== terminal.command) {
            next = { ...next, [branch]: mapTerminalCommand(latest, terminal.id, live.command) };
          }
        }
      }
    }
    return next === current ? null : { next, collapsedBranches };
  }

  private shouldWatchTmux(): boolean {
    if (this.activeTerminalMode() === 'tmux') {
      return true;
    }
    if (terminalRecordHasTmux(this.terminalsByBranch())) {
      return true;
    }
    const live = this.terminalsByBranch();
    for (const workspace of this.repositoryWorkspaces.values()) {
      if (workspace.terminalsByBranch !== live && terminalRecordHasTmux(workspace.terminalsByBranch)) {
        return true;
      }
    }
    return false;
  }

  private followRemote(path: string): void {
    const follow = ++this.remoteFollow;
    void refreshOpenRepositoryRemotes(path).then((updated) => {
      if (!updated || follow !== this.remoteFollow || this.effectivePath() !== path) {
        return;
      }
      this.zone.run(() => {
        try {
          const previous = this.defaultBranchName();
          this.defaultBranchEpoch.update((value) => value + 1);
          const next = this.defaultBranchName();
          this.refreshBranches();
          const selected = this.selectedBranchName();
          if (previous !== next && selected !== null) {
            this.loadBranchContent(selected);
          }
        } catch (error) {
          this.workspaceError.set(errorText(error));
        }
      });
    });
  }

  private closeTerminalMenu(): void {
    this.hideMoveSubmenu();
    this.terminalMenu.set(null);
  }

  private clearMoveSubmenuTimer(): void {
    if (this.moveSubmenuTimer !== null) {
      clearTimeout(this.moveSubmenuTimer);
      this.moveSubmenuTimer = null;
    }
  }

  private fitAnchoredMenu(selector: string, anchor: { x: number; y: number } | null): void {
    if (anchor === null) {
      return;
    }
    const element = this.hostElement.nativeElement.querySelector(selector);
    if (!(element instanceof HTMLElement) || element.classList.contains('terminal-submenu')) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const placed = placeContextMenu(anchor, rect, { width: window.innerWidth, height: window.innerHeight });
    element.style.left = `${placed.x}px`;
    element.style.top = `${placed.y}px`;
  }

  private fitMoveSubmenu(): void {
    if (!this.moveSubmenuOpen()) {
      return;
    }
    const item = this.hostElement.nativeElement.querySelector('[data-testid="terminal-menu-move"]');
    const submenu = this.hostElement.nativeElement.querySelector('[data-testid="terminal-menu-move-submenu"]');
    if (!(item instanceof HTMLElement) || !(submenu instanceof HTMLElement)) {
      return;
    }
    const parent = item.getBoundingClientRect();
    const rect = submenu.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    const placed = placeSubmenu(
      { left: parent.left, right: parent.right, top: parent.top },
      rect,
      { width: window.innerWidth, height: window.innerHeight },
    );
    submenu.style.left = `${placed.x}px`;
    submenu.style.top = `${placed.y}px`;
    submenu.classList.add('is-placed');
  }

  private endRepositoryTerminals(path: string): void {
    if (this.effectivePath() === path) {
      stopShellTerminals(this.terminalsByBranch());
      this.killWorkspaceTmuxSessions(this.terminalsByBranch());
    }
    const saved = this.repositoryWorkspaces.get(path);
    if (saved) {
      stopShellTerminals(saved.terminalsByBranch);
      this.killWorkspaceTmuxSessions(saved.terminalsByBranch);
    }
  }

  private killWorkspaceTmuxSessions(branches: Record<string, WorktreeTerminalView>): void {
    for (const state of Object.values(branches)) {
      for (const tab of state.tabs) {
        for (const terminal of tab.terminals) {
          if (terminal.host === 'tmux' && terminal.session !== '') {
            killTmuxSession(terminal.session);
          }
        }
      }
    }
  }

  private showKeptRepository(tab: RepositoryTab): void {
    this.selectedName.set(tab.name);
    this.openedPath.set(tab.path);
    this.overlayOpen.set(false);
    this.openBranch.set(null);
    const saved = this.repositoryWorkspaces.get(tab.path);
    if (saved) {
      this.restoreBranchView(saved.view);
      this.contentLoading.set(false);
      this.terminalsByBranch.set(saved.terminalsByBranch);
      this.worktreePath.set(saved.worktreePath);
      if (saved.worktreePath !== '') {
        this.syncCommittedPreset(saved.worktreePath);
      }
      this.terminalSectionByBranch.set(saved.terminalSectionByBranch);
      if (!this.terminalMaximized()) {
        this.maximizedBodyHeight.set(null);
      }
      this.realBranches.set(saved.branches);
      if (this.oldSessionRepo !== tab.path) {
        this.oldSessionChoices.set([]);
      }
      this.closeTerminalMenu();
      this.renaming.set(null);
      this.applyOpenRepositoryAppearance();
      this.scheduleBranchRefresh(tab.path);
      return;
    }
    this.clearBranchSelection();
    this.clearTerminals();
    this.realBranches.set([]);
    this.applyOpenRepositoryAppearance();
    this.scheduleBranchRefresh(tab.path);
  }

  private closeRepositoryTabMenuOnClick(event: Event): void {
    if (this.repositoryTabMenu() === null) {
      return;
    }
    const target = event.target;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (element?.closest('[data-testid="repository-tab-menu"]')) {
      return;
    }
    this.repositoryTabMenu.set(null);
  }

  private closeTerminalMenuOnClick(event: Event): void {
    if (this.terminalMenu() === null) {
      return;
    }
    const target = event.target;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (
      element?.closest('[data-testid="terminal-menu"]') ||
      element?.closest('[data-testid="terminal-menu-move-submenu"]')
    ) {
      return;
    }
    this.closeTerminalMenu();
  }

  private refreshBranches(also: readonly string[] = []): void {
    const path = this.effectivePath();
    if (path === null) {
      this.pinnedWorktrees.set([]);
      this.primaryBranchName.set(undefined);
      this.clearGitWatch();
      return;
    }
    const measure = this.branchesToMeasure(also);
    withWorktreeList(path, () => {
      const opened = readOpenBranches(path, {
        branches: measure,
        changedAt: this.worktreeChangedAt.get(path),
      });
      this.worktreeChangedAt.set(path, new Map(opened.changedAt));
      if (opened.primaryBranch !== this.primaryBranchName()) {
        this.primaryBranchName.set(opened.primaryBranch);
      }
      if (opened.pinned.join('\0') !== this.pinnedWorktrees().join('\0')) {
        this.pinnedWorktrees.set([...opened.pinned]);
      }
      this.claimOldSessions(path, opened.rows);
      const measured = new Set(measure);
      const previous = new Map(this.realBranches().map((branch) => [branch.name, branch]));
      const next = opened.worktrees.map((branch) => {
        const prior = previous.get(branch.name);
        if (!prior || measured.has(branch.name)) {
          return {
            name: branch.name,
            status: branch.status,
            changedFileCount: branch.changedFileCount,
            ahead: branch.ahead,
            behind: branch.behind,
          };
        }
        return {
          name: branch.name,
          status: branch.status,
          changedFileCount: prior.changedFileCount,
          ahead: prior.ahead,
          behind: prior.behind,
        };
      });
      if (!sameWorktreeRows(this.realBranches(), next)) {
        this.realBranches.set(next);
      }
      this.rememberTmuxSessions();
      this.syncGitWatch(opened.paths, measure, opened.primaryPath);
      try {
        this.refreshSelectedWorktreeContent();
      } catch {
        // The next local change retries the selected worktree.
      }
      this.refreshSelectedPresets();
    });
  }

  private refreshSelectedPresets(): void {
    const checkout = this.presetCheckout();
    if (checkout === '') {
      return;
    }
    this.syncCommittedPreset(checkout);
  }

  private refreshSelectedWorktreeContent(): void {
    const path = this.effectivePath();
    const name = this.selectedBranchName();
    if (!path || !name || this.contentLoading()) {
      return;
    }
    if (!this.realBranches().some((branch) => branch.name === name)) {
      return;
    }
    const onDefault = name === this.defaultBranchName();
    const loadedCount = onDefault ? this.loadedRecentCommits().length : this.loadedCommits().length;
    const files = readChangedFiles(path, name);
    let commits = this.readCommitWindow(path, name, onDefault, Math.max(loadedCount, recentCommitPageSize));
    if (this.worktreeContentStale(path, name)) {
      return;
    }
    const identity = this.selectedCommitSubject();
    if (
      identity &&
      !commitInList(commits.commits, identity) &&
      commitObjectExists(path, identity)
    ) {
      commits = this.readCommitWindow(path, name, onDefault, commits.commits.length + recentCommitPageSize);
      while (!commits.complete && !commitInList(commits.commits, identity)) {
        const further = this.readCommitWindow(
          path,
          name,
          onDefault,
          commits.commits.length + recentCommitPageSize,
        );
        if (further.commits.length === commits.commits.length) {
          break;
        }
        commits = further;
      }
      if (this.worktreeContentStale(path, name)) {
        return;
      }
    }
    const filePath = this.selectedFilePath();
    const commitIdentity = this.selectedCommitSubject();
    const commit = commitIdentity ? commits.commits.find((item) => commitMatches(item, commitIdentity)) : undefined;
    let nextFile = filePath;
    let nextCommit = commitIdentity;
    let commitFiles = this.loadedCommitFiles();
    let diff = this.loadedDiff();
    if (commitIdentity) {
      if (!commit) {
        nextCommit = null;
        nextFile = null;
        commitFiles = [];
        diff = null;
      } else {
        commitFiles = readCommitFiles(path, commit.sha);
        const commitFile = nextFile ? commitFiles.find((file) => file.path === nextFile) : undefined;
        if (nextFile && commitFile) {
          diff = readCommitFileDiff(path, commit.sha, nextFile, commitFile.previousPath);
        } else {
          nextFile = null;
          diff = '';
        }
      }
    } else if (nextFile) {
      const changed = files.find((file) => file.path === nextFile);
      if (changed) {
        diff = readWorkingTreeDiff(path, name, nextFile, changed.previousPath);
      } else {
        nextFile = null;
        diff = null;
      }
    }
    if (!sameChangedFiles(this.loadedFiles(), files)) {
      this.loadedFiles.set(files);
    }
    if (onDefault) {
      if (!sameCommits(this.loadedRecentCommits(), commits.commits)) {
        this.loadedRecentCommits.set(commits.commits);
      }
      if (this.loadedCommits().length > 0) {
        this.loadedCommits.set([]);
      }
    } else {
      if (!sameCommits(this.loadedCommits(), commits.commits)) {
        this.loadedCommits.set(commits.commits);
      }
      if (this.loadedRecentCommits().length > 0) {
        this.loadedRecentCommits.set([]);
      }
    }
    if (this.commitListComplete() !== commits.complete) {
      this.commitListComplete.set(commits.complete);
    }
    const total = onDefault ? countBranchCommits(path, name) : countCommitsOnlyOnBranch(path, name);
    if (total !== undefined && total !== this.commitTotal()) {
      this.commitTotal.set(total);
    }
    if (!sameChangedFiles(this.loadedCommitFiles(), commitFiles)) {
      this.loadedCommitFiles.set(commitFiles);
    }
    if (this.loadedDiff() !== diff) {
      this.loadedDiff.set(diff);
    }
    if (this.selectedFilePath() !== nextFile || this.selectedCommitSubject() !== nextCommit) {
      this.resetDiffScroll();
    }
    if (this.selectedFilePath() !== nextFile) {
      this.selectedFilePath.set(nextFile);
    }
    if (this.selectedCommitSubject() !== nextCommit) {
      this.selectedCommitSubject.set(nextCommit);
    }
    this.refreshFullFileSides();
  }

  private refreshFullFileSides(): void {
    const repo = this.effectivePath();
    const path = this.selectedFilePath();
    if (repo === null || path === null) {
      this.fullFileSides.set({ oldText: '', newText: '', tooLarge: false });
      return;
    }
    const file = this.selectedDiffFile();
    const previousPath = file?.previousPath ?? diffLines(this.paneDiff()).previousPath;
    const binary = file?.binary ?? false;
    if (this.showingCommit()) {
      const identity = this.selectedCommitSubject();
      const commit = identity ? this.commitByIdentity(identity, identity) : undefined;
      this.fullFileSides.set(
        commit
          ? readCommitFileSides(repo, commit.sha, path, previousPath, binary)
          : { oldText: '', newText: '', tooLarge: false },
      );
      return;
    }
    const branch = this.selectedBranchName();
    this.fullFileSides.set(
      branch
        ? readWorkingTreeFileSides(repo, branch, path, previousPath, binary)
        : { oldText: '', newText: '', tooLarge: false },
    );
  }

  private worktreeContentStale(path: string, name: string): boolean {
    return this.effectivePath() !== path || this.selectedBranchName() !== name || this.contentLoading();
  }

  private readCommitWindow(
    path: string,
    name: string,
    onDefault: boolean,
    count: number,
  ): { commits: BranchCommit[]; complete: boolean } {
    const commits: BranchCommit[] = [];
    let complete = false;
    while (commits.length < count) {
      const page = onDefault
        ? readRecentCommits(path, name, commits.length)
        : readCommitsOnlyOnBranch(path, name, commits.length);
      commits.push(...page);
      if (page.length < recentCommitPageSize) {
        complete = true;
        break;
      }
    }
    return { commits, complete };
  }

  private branchesToMeasure(also: readonly string[]): string[] {
    const names = new Set<string>(also);
    const base = this.defaultBranchName();
    const selected = this.selectedBranchName();
    if (base !== undefined) {
      names.add(base);
    }
    if (selected !== null) {
      names.add(selected);
    }
    return [...names];
  }

  private syncGitWatch(
    paths: ReadonlyMap<string, string>,
    measured: readonly string[],
    primaryPath: string | undefined,
  ): void {
    const path = this.effectivePath();
    if (path === null) {
      this.clearGitWatch();
      return;
    }
    this.gitWatchActive = true;
    const measuredSet = new Set(measured);
    this.gitWatchCheckouts = [...paths.entries()].map(([branch, checkout]) => ({
      path: checkout,
      measured: measuredSet.has(branch),
      primary: primaryPath !== undefined && checkout === primaryPath,
      presets: false,
    }));
    if (
      primaryPath !== undefined &&
      !this.gitWatchCheckouts.some((checkout) => checkout.path === primaryPath)
    ) {
      this.gitWatchCheckouts.push({ path: primaryPath, measured: false, primary: true, presets: false });
    }
    this.applyGitWatchTargets();
  }

  private applyGitWatchTargets(): void {
    if (!this.gitWatchActive) {
      return;
    }
    const rawPreset = this.presetCheckout();
    const presetPath = rawPreset === '' ? '' : resolve(rawPreset);
    for (const checkout of this.gitWatchCheckouts) {
      checkout.presets = presetPath !== '' && resolve(checkout.path) === presetPath;
    }
    if (presetPath !== '' && !this.gitWatchCheckouts.some((checkout) => resolve(checkout.path) === presetPath)) {
      this.gitWatchCheckouts.push({ path: rawPreset, measured: false, primary: false, presets: true });
    }
    const wanted = new Map<string, boolean>();
    for (const checkout of this.gitWatchCheckouts) {
      const targets =
        checkout.measured || checkout.primary
          ? checkoutWatchTargets(checkout.path)
          : checkout.presets
            ? presetWatchTargets(checkout.path)
            : [];
      for (const target of targets) {
        wanted.set(target.path, wanted.get(target.path) === true || target.recursive);
      }
    }
    for (const [dir, watcher] of this.gitWatchers) {
      if (!wanted.has(dir)) {
        this.closeGitWatcher(dir, watcher);
      }
    }
    for (const [dir, recursive] of wanted) {
      if (this.gitWatchers.has(dir)) {
        continue;
      }
      try {
        const watcher = watch(dir, { recursive }, (_event, filename) => {
          const name =
            typeof filename === 'string' ? filename : filename instanceof Buffer ? filename.toString('utf8') : null;
          if (name !== null && this.gitEventIsIgnored(dir, name)) {
            return;
          }
          this.scheduleLocalGitRefresh();
        });
        watcher.on('error', () => {
          this.closeGitWatcher(dir, watcher);
          this.scheduleLocalGitRefresh();
        });
        this.gitWatchers.set(dir, watcher);
      } catch {
        // The next refresh watches a checkout that exists by then.
      }
    }
  }

  private scheduleLocalGitRefresh(): void {
    if (!this.gitWatchActive) {
      return;
    }
    if (this.gitRefreshTimer !== null) {
      clearTimeout(this.gitRefreshTimer);
    }
    const generation = this.gitWatchGeneration;
    this.zone.runOutsideAngular(() => {
      this.gitRefreshTimer = setTimeout(() => {
        this.gitRefreshTimer = null;
        if (!this.gitWatchActive || generation !== this.gitWatchGeneration) {
          return;
        }
        this.zone.run(() => {
          try {
            this.refreshBranches();
          } catch {
            // The next local change retries the read.
          }
        });
      }, 80);
    });
  }

  private gitEventIsIgnored(root: string, filename: string): boolean {
    const absolute = resolve(root, filename);
    let match: { path: string; measured: boolean; primary: boolean; presets: boolean } | undefined;
    for (const checkout of this.gitWatchCheckouts) {
      if (absolute === checkout.path || absolute.startsWith(`${checkout.path}${sep}`)) {
        if (!match || checkout.path.length > match.path.length) {
          match = checkout;
        }
      }
    }
    if (!match || match.measured) {
      return false;
    }
    if (match.presets && pathIsPresetFile(match.path, absolute)) {
      return false;
    }
    if (match.primary && this.pathIsGitMetadata(match.path, absolute)) {
      return false;
    }
    return true;
  }

  private pathIsGitMetadata(checkout: string, absolute: string): boolean {
    const gitDir = `${checkout}${sep}.git`;
    return absolute === gitDir || absolute.startsWith(`${gitDir}${sep}`);
  }

  private closeGitWatcher(dir: string, watcher: FSWatcher): void {
    this.gitWatchers.delete(dir);
    try {
      watcher.close();
    } catch {
      // The checkout is already gone.
    }
  }

  private clearGitWatch(): void {
    this.gitWatchActive = false;
    this.gitWatchCheckouts = [];
    this.gitWatchGeneration += 1;
    if (this.gitRefreshTimer !== null) {
      clearTimeout(this.gitRefreshTimer);
      this.gitRefreshTimer = null;
    }
    for (const [dir, watcher] of this.gitWatchers) {
      this.closeGitWatcher(dir, watcher);
    }
    if (this.gitRefreshTimer !== null) {
      clearTimeout(this.gitRefreshTimer);
      this.gitRefreshTimer = null;
    }
  }

  keepOldSession(name: string, branch: string): void {
    rememberSessionBranch(name, branch);
    this.oldSessionChoices.update((choices) => choices.filter((choice) => choice.name !== name));
  }

  killOldSession(name: string): void {
    killTmuxSession(name);
    this.oldSessionChoices.update((choices) => choices.filter((choice) => choice.name !== name));
  }

  leaveOldSession(name: string): void {
    this.dismissedOldSessions.add(name);
    this.oldSessionChoices.update((choices) => choices.filter((choice) => choice.name !== name));
  }

  dismissOldSessionsFromBackdrop(event: Event): void {
    if (event.target === event.currentTarget) {
      this.dismissOldSessions();
    }
  }

  private dismissOldSessions(): void {
    for (const choice of this.oldSessionChoices()) {
      this.dismissedOldSessions.add(choice.name);
    }
    this.oldSessionChoices.set([]);
  }

  private finishChoose(name: string, path: string | null): void {
    if (this.terminalsOpen()) {
      this.terminalsOpen.set(false);
    }
    const leaving = this.effectivePath();
    if (leaving !== null && leaving !== path) {
      this.rememberWorkspace(leaving);
    }
    this.selectedName.set(name);
    this.openedPath.set(path);
    this.overlayOpen.set(false);
    this.openBranch.set(null);
    const saved = path === null ? undefined : this.repositoryWorkspaces.get(path);
    if (saved) {
      this.restoreBranchView(saved.view);
      this.contentLoading.set(false);
      this.terminalsByBranch.set(saved.terminalsByBranch);
      this.worktreePath.set(saved.worktreePath);
      if (saved.worktreePath !== '') {
        this.syncCommittedPreset(saved.worktreePath);
      }
      this.terminalSectionByBranch.set(saved.terminalSectionByBranch);
      if (!this.terminalMaximized()) {
        this.maximizedBodyHeight.set(null);
      }
      this.closeTerminalMenu();
      this.renaming.set(null);
    } else {
      this.clearBranchSelection();
      this.clearTerminals();
      this.realBranches.set([]);
    }
    this.applyOpenRepositoryAppearance();
    if (path !== null) {
      this.appendRepositoryTab(path, name);
      this.scheduleBranchRefresh(path);
    }
    this.rememberOpenRepositoryTabs();
  }

  private scheduleBranchRefresh(path: string): void {
    this.runWhenPainted(() => {
      if (this.effectivePath() !== path) {
        return;
      }
      try {
        this.refreshBranches();
      } catch {
        // The next local change retries the read.
      }
    });
  }

  private restoreOpenRepositoryTabs(): void {
    const saved = readOpenRepositoryTabs(this.appSettingsEnv);
    if (saved.paths.length === 0) {
      return;
    }
    const registered = new Set(listRepositories().map((repository) => repository.path));
    const remaining = saved.paths.filter((path) => registered.has(path) && gitRepositoryOpens(path));
    const selectedPath = restoredRepositoryPath(saved.paths, saved.selectedPath, remaining);
    if (selectedPath === null) {
      this.rememberOpenRepositoryTabs();
      return;
    }
    for (const path of remaining) {
      const repository = findRepository(path);
      if (!repository) {
        continue;
      }
      this.appendRepositoryTab(path, repository.displayName);
    }
    this.openRestoredRepository(saved.paths, remaining, selectedPath);
  }

  private openRestoredRepository(
    savedPaths: readonly string[],
    candidates: readonly string[],
    selectedPath: string,
  ): void {
    const selected = findRepository(selectedPath);
    if (!selected) {
      this.skipRestoredRepository(savedPaths, candidates, selectedPath);
      return;
    }
    this.openRepository(selected.displayName, selected.path, () => {
      this.skipRestoredRepository(savedPaths, candidates, selectedPath);
    });
  }

  private skipRestoredRepository(
    savedPaths: readonly string[],
    candidates: readonly string[],
    failedPath: string,
  ): void {
    const remaining = candidates.filter((path) => path !== failedPath);
    this.repositoryTabs.update((tabs) => tabs.filter((tab) => tab.path !== failedPath));
    const next = restoredRepositoryPath(savedPaths, failedPath, remaining);
    if (next === null) {
      this.selectedName.set(null);
      this.openedPath.set(null);
      this.openingRepository.set(null);
      this.overlayOpen.set(false);
      this.rememberOpenRepositoryTabs();
      return;
    }
    this.openRestoredRepository(savedPaths, remaining, next);
  }

  private rememberOpenRepositoryTabs(): void {
    if (!this.persistOpenTabs) {
      return;
    }
    const paths = this.repositoryTabs().map((tab) => tab.path);
    const opened = this.terminalsOpen() ? this.terminalsReturnPath() : this.openedPath();
    const selectedPath = opened !== null && paths.includes(opened) ? opened : null;
    saveOpenRepositoryTabs(paths, selectedPath, this.appSettingsEnv);
  }

  private runWhenPainted(work: () => void): void {
    runAfterPaint(() => {
      this.zone.run(work);
    });
  }

  private clearBranchSelection(): void {
    this.selectedBranchName.set(null);
    this.clearLoadedBranch();
    this.contentLoading.set(false);
  }

  private clearLoadedBranch(): void {
    this.selectedFilePath.set(null);
    this.selectedCommitSubject.set(null);
    this.loadedDiff.set(null);
    this.fullFileSides.set({ oldText: '', newText: '', tooLarge: false });
    this.loadedCommitFiles.set([]);
    this.loadedFiles.set([]);
    this.loadedCommits.set([]);
    this.loadedRecentCommits.set([]);
    this.commitListComplete.set(true);
    this.commitTotal.set(null);
  }

  private snapshotBranchView(): BranchViewSnapshot {
    return {
      name: this.selectedBranchName(),
      filePath: this.selectedFilePath(),
      commitSubject: this.selectedCommitSubject(),
      files: this.loadedFiles(),
      commits: this.loadedCommits(),
      recentCommits: this.loadedRecentCommits(),
      commitListComplete: this.commitListComplete(),
      commitTotal: this.commitTotal(),
      commitFiles: this.loadedCommitFiles(),
      diff: this.loadedDiff(),
    };
  }

  private restoreBranchView(snapshot: BranchViewSnapshot): void {
    this.selectedBranchName.set(snapshot.name);
    this.selectedFilePath.set(snapshot.filePath);
    this.selectedCommitSubject.set(snapshot.commitSubject);
    this.loadedFiles.set(snapshot.files);
    this.loadedCommits.set(snapshot.commits);
    this.loadedRecentCommits.set(snapshot.recentCommits);
    this.commitListComplete.set(snapshot.commitListComplete);
    this.commitTotal.set(snapshot.commitTotal);
    this.loadedCommitFiles.set(snapshot.commitFiles);
    this.loadedDiff.set(snapshot.diff);
    this.refreshFullFileSides();
  }

  private loadBranchContent(name: string): void {
    const path = this.effectivePath();
    if (!path) {
      return;
    }
    this.selectedFilePath.set(null);
    this.selectedCommitSubject.set(null);
    this.loadedDiff.set(null);
    this.fullFileSides.set({ oldText: '', newText: '', tooLarge: false });
    this.loadedCommitFiles.set([]);
    this.loadedFiles.set(readChangedFiles(path, name));
    this.commitTotal.set(null);
    const onDefault = this.branchIsDefault();
    const page = onDefault ? readRecentCommits(path, name) : readCommitsOnlyOnBranch(path, name);
    if (onDefault) {
      this.loadedCommits.set([]);
      this.loadedRecentCommits.set(page);
    } else {
      this.loadedRecentCommits.set([]);
      this.loadedCommits.set(page);
    }
    this.commitListComplete.set(page.length < recentCommitPageSize);
    this.openTerminals(name);
    this.scheduleCommitTotal(path, name);
  }

  private scheduleCommitTotal(path: string, name: string): void {
    this.runWhenPainted(() => {
      if (this.effectivePath() !== path || this.selectedBranchName() !== name) {
        return;
      }
      const total = this.branchIsDefault()
        ? countBranchCommits(path, name)
        : countCommitsOnlyOnBranch(path, name);
      if (this.effectivePath() !== path || this.selectedBranchName() !== name || total === undefined) {
        return;
      }
      this.commitTotal.set(total);
    });
  }

  private rememberTmuxSessions(): void {
    const next = listTmuxSessionRecords();
    const current = this.tmuxSessionRecords();
    if (
      current.length === next.length &&
      current.every(
        (session, index) => session.name === next[index]?.name && session.branch === next[index]?.branch,
      )
    ) {
      return;
    }
    this.tmuxSessionRecords.set(next);
  }

  private claimOldSessions(path: string, rows: readonly { name: string; status: BranchStatus }[]): void {
    if (path !== this.oldSessionRepo) {
      this.dismissedOldSessions.clear();
      this.oldSessionRepo = path;
    }
    const branches = rows.filter((branch) => branch.status !== 'remote-only').map((branch) => branch.name);
    claimUniqueLegacySessions(path, branches);
    this.oldSessionChoices.set(
      ambiguousLegacySessions(path, branches).filter((choice) => !this.dismissedOldSessions.has(choice.name)),
    );
  }
}

function restoredRepositoryPath(
  savedPaths: readonly string[],
  selectedPath: string | null,
  remaining: readonly string[],
): string | null {
  if (remaining.length === 0) {
    return null;
  }
  if (selectedPath !== null && remaining.includes(selectedPath)) {
    return selectedPath;
  }
  const selectedIndex = selectedPath === null ? -1 : savedPaths.indexOf(selectedPath);
  if (selectedIndex < 0) {
    return remaining[0] ?? null;
  }
  for (let index = selectedIndex + 1; index < savedPaths.length; index += 1) {
    const path = savedPaths[index];
    if (path !== undefined && remaining.includes(path)) {
      return path;
    }
  }
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    const path = savedPaths[index];
    if (path !== undefined && remaining.includes(path)) {
      return path;
    }
  }
  return null;
}

function gitRepositoryOpens(path: string): boolean {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function liveQueryFlag(): boolean {
  if (typeof location === 'undefined') {
    return false;
  }
  return new URLSearchParams(location.search).get('live') === '1';
}

function inputValue(event: Event): string {
  const target = event.target as { value?: string } | null;
  return target?.value ?? '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPresetWorkspaceError(message: string): boolean {
  return (
    message.startsWith('Invalid terminals.toml') ||
    message.startsWith('Invalid terminals.override.toml') ||
    message.startsWith('The terminal directory ') ||
    /^Preset ".*" has no tabs$/.test(message) ||
    /^Preset name ".*" is used more than once$/.test(message) ||
    message === 'A preset has no name' ||
    /^The startup command( for ".*")? contains a newline$/.test(message) ||
    /^Preset ".*" has a tab with more than two terminals$/.test(message)
  );
}

function samePresetNames(left: CommittedPreset[] | null, right: CommittedPreset[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((preset, index) => preset.name === right[index]?.name);
}

function sameWorktreeRows(
  left: readonly { name: string; status: string; changedFileCount: number; ahead: number; behind: number }[],
  right: readonly { name: string; status: string; changedFileCount: number; ahead: number; behind: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        row.name === other.name &&
        row.status === other.status &&
        row.changedFileCount === other.changedFileCount &&
        row.ahead === other.ahead &&
        row.behind === other.behind
      );
    })
  );
}

function sameChangedFiles(left: readonly ChangedFile[], right: readonly ChangedFile[]): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        file.path === other.path &&
        file.previousPath === other.previousPath &&
        file.added === other.added &&
        file.deleted === other.deleted &&
        file.binary === other.binary
      );
    })
  );
}

function sameCommits(left: readonly BranchCommit[], right: readonly BranchCommit[]): boolean {
  return (
    left.length === right.length &&
    left.every((commit, index) => commit.sha === right[index]?.sha && commit.subject === right[index]?.subject)
  );
}

function commitMatches(commit: BranchCommit, identity: string): boolean {
  return commit.sha === identity || commit.subject === identity;
}

function commitInList(commits: readonly BranchCommit[], identity: string): boolean {
  return commits.some((commit) => commitMatches(commit, identity));
}

function commitObjectExists(repoPath: string, identity: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${identity}^{commit}`], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const skippedWatchDirectories = new Set([
  '.angular',
  '.cache',
  '.git',
  '.workspaces',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'tmp',
]);

function presetWatchTargets(checkout: string): { path: string; recursive: boolean }[] {
  const root = resolve(checkout);
  const targets: { path: string; recursive: boolean }[] = [{ path: root, recursive: false }];
  const directory = resolve(root, '.git-worktree-manager');
  try {
    readdirSync(directory);
    targets.push({ path: directory, recursive: false });
  } catch {
    // The checkout root watch sees the directory when it is created.
  }
  return targets;
}

function pathIsPresetFile(checkout: string, absolute: string): boolean {
  const directory = `${resolve(checkout)}${sep}.git-worktree-manager`;
  return absolute === directory || absolute.startsWith(`${directory}${sep}`);
}

export function checkoutWatchTargets(checkout: string): { path: string; recursive: boolean }[] {
  const root = resolve(checkout);
  const targets: { path: string; recursive: boolean }[] = [{ path: root, recursive: false }];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return targets;
  }
  for (const entry of entries) {
    if (entry.name === '.git') {
      if (entry.isDirectory()) {
        targets.push({ path: resolve(root, '.git'), recursive: true });
      }
      continue;
    }
    if (!entry.isDirectory() || skippedWatchDirectories.has(entry.name)) {
      continue;
    }
    targets.push({ path: resolve(root, entry.name), recursive: true });
  }
  return targets;
}

function isPromise(value: void | Promise<void>): value is Promise<void> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof value.then === 'function';
}

function clampDiffSideShare(ratio: number, width: number): number {
  const gutter = 8;
  const usable = width - gutter;
  if (usable <= 160) {
    return Math.min(0.8, Math.max(0.2, ratio));
  }
  const min = 80 / usable;
  return Math.min(1 - min, Math.max(min, ratio));
}

function rowIsChange(row: FoldedRow | SideBySideRow): boolean {
  if (row.kind === 'fold') {
    return false;
  }
  if ('old' in row) {
    return (
      (row.old.kind !== 'context' && row.old.kind !== 'empty') ||
      (row.new.kind !== 'context' && row.new.kind !== 'empty')
    );
  }
  return row.line.kind !== 'context';
}

function clampSplit(value: number, limit: number | undefined): number {
  const floored = Math.max(80, value);
  if (limit === undefined) {
    return floored;
  }
  return Math.min(floored, limit);
}

function readRepositoryName(repoPath: string): string {
  const path = resolve(repoPath);
  let insideWorkTree: string;
  try {
    insideWorkTree = execFileSync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`Not a git repository: ${path}`);
  }
  if (insideWorkTree === 'true') {
    const toplevel = execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return basename(toplevel);
  }
  const gitDir = execFileSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return basename(gitDir);
}

const terminalHeaderHeight = 36;
const headingMinHeight = 44;
const terminalPaneHeaderHeight = 22;

type TerminalSection = 'collapsed' | 'docked' | 'maximized';

interface RepositoryWorkspace {
  view: BranchViewSnapshot;
  terminalsByBranch: Record<string, WorktreeTerminalView>;
  worktreePath: string;
  branches: SampleBranch[];
  terminalSectionByBranch: Record<string, TerminalSection>;
}

interface BranchViewSnapshot {
  name: string | null;
  filePath: string | null;
  commitSubject: string | null;
  files: ChangedFile[];
  commits: BranchCommit[];
  recentCommits: BranchCommit[];
  commitListComplete: boolean;
  commitTotal: number | null;
  commitFiles: ChangedFile[];
  diff: string | null;
}

interface DiffViewRow {
  index: number;
  offset: number;
  height: number;
  kind: 'line' | 'fold';
  line: DiffLine | null;
  fold: FoldedFoldRow | null;
  side: { old: SideCell; new: SideCell } | null;
}

interface TerminalMenuState {
  tabId: string;
  terminalId: string | null;
  x: number;
  y: number;
}

function countBranchTerminals(
  repo: string | null,
  name: string,
  state: WorktreeTerminalView | undefined,
  sessions: readonly TmuxSessionRecord[],
): number {
  const remembered = state === undefined ? 0 : state.tabs.reduce((sum, tab) => sum + tab.terminals.length, 0);
  if (!repo) {
    return remembered;
  }
  const known = new Set(
    state?.tabs.flatMap((tab) =>
      tab.terminals.map((terminal) => terminal.session).filter((session) => session.length > 0),
    ) ?? [],
  );
  const outside = sessionsForBranch(repo, name, sessions).filter((session) => !known.has(session)).length;
  return remembered + outside;
}

function terminalRecordHasTmux(branches: Record<string, WorktreeTerminalView>): boolean {
  return Object.values(branches).some((state) =>
    state.tabs.some((tab) => tab.terminals.some((terminal) => terminal.host === 'tmux')),
  );
}

function branchHasTerminal(state: WorktreeTerminalView, terminalId: string): boolean {
  return state.tabs.some((tab) => tab.terminals.some((terminal) => terminal.id === terminalId));
}

function terminalLiveness(
  terminal: Pick<TerminalView, 'host' | 'id' | 'session'>,
  bySession: Map<string, TmuxSessionSnapshot> | null,
): { alive: boolean; command: string } {
  if (terminal.host === 'tmux' && bySession) {
    const snapshot = bySession.get(terminal.session);
    if (!snapshot) {
      return { alive: false, command: '' };
    }
    return { alive: true, command: snapshot.command };
  }
  return liveTerminal(terminal);
}

function sameSessionRecords(
  current: readonly TmuxSessionRecord[],
  next: readonly TmuxSessionRecord[],
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (session, index) => session.name === next[index]?.name && session.branch === next[index]?.branch,
    )
  );
}

function hostPlatform(): string {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform;
  }
  return 'linux';
}

function tmuxIsInstalled(): boolean {
  return tmuxOnPath() !== null;
}
