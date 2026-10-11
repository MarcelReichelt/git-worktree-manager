import TOML from '@iarna/toml';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { killTmuxSession, listTmuxSessions, sessionDirectory, sessionsForBranch } from '../src/desktop/tmux-sessions';
import { waitForTerminal } from './desktop-terminal-harness';
import { resetFolderBrowser, setFolderBrowser } from '../src/desktop/folder-browser';
import { resetTextCopy, setTextCopy } from '../src/desktop/copy-text';
import { resetIdeLaunch, setIdeLaunch } from '../src/desktop/ide-launch';
import { resetWindowChrome, setWindowChrome } from '../src/desktop/window-chrome';
import { setAfterPaintScheduler } from '../src/desktop/after-paint';
import { listWorktreeBranches, whenRemoteRefreshIdle } from '../src/branches';
import { WorkspaceComponent, checkoutWatchTargets } from '../src/desktop/workspace.component';
import { readAppSettings, readPinnedWorktrees } from '../src/app-settings';
import { addRepository, findRepository, unregisterRepository } from '../src/registry';

const emptyGitConfig = join(tmpdir(), 'git-worktree-manager-desktop-gitconfig');
writeFileSync(emptyGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfig;
process.env.GIT_TERMINAL_PROMPT = '0';

describe('desktop workspace', () => {
  const roots: string[] = [];
  const previousRegistryPath = process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
  const previousAppSettingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
  let restoreSearch: (() => void) | undefined;

  beforeEach(() => {
    const settingsRoot = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-settings-'));
    roots.push(settingsRoot);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(settingsRoot, 'app-settings.json');
  });

  afterEach(() => {
    setAfterPaintScheduler((task) => {
      task();
    });
    resetFolderBrowser();
    resetTextCopy();
    resetIdeLaunch();
    resetWindowChrome();
    restoreSearch?.();
    restoreSearch = undefined;
    if (previousRegistryPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = previousRegistryPath;
    }
    if (previousAppSettingsPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = previousAppSettingsPath;
    }
    const removing = roots.splice(0);
    for (const name of listTmuxSessions()) {
      const directory = sessionDirectory(name);
      if (removing.some((root) => directory.startsWith(root))) {
        killTmuxSession(name);
      }
    }
    for (const root of removing) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function setupWorkspace(
    apply?: (fixture: ComponentFixture<WorkspaceComponent>) => void,
  ) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(WorkspaceComponent);
    apply?.(fixture);
    fixture.detectChanges();
    await fixture.whenStable();
    await whenRemoteRefreshIdle();
    fixture.detectChanges();
    return fixture;
  }

  function render() {
    return setupWorkspace();
  }

  async function renderLive() {
    if (restoreSearch === undefined) {
      const previousSearch = location.search;
      history.replaceState(null, '', `${location.pathname}?live=1`);
      restoreSearch = () => {
        history.replaceState(null, '', `${location.pathname}${previousSearch}`);
      };
    }
    return setupWorkspace();
  }

  function renderRepository(repoPath: string) {
    if (!process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH) {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    }
    return setupWorkspace((fixture) => {
      fixture.componentRef.setInput('repositoryPath', repoPath);
    });
  }

  function openRepositoryCard(fixture: ComponentFixture<WorkspaceComponent>): void {
    const button = fixture.nativeElement.querySelector('[data-testid="open-repository-card"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Open repository is not shown');
    }
    button.click();
    fixture.detectChanges();
  }

  function registerPair(): { pier: string; quay: string } {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(pier, '.workspaces'));
    git(pier, ['branch', 'feature']);
    git(pier, ['worktree', 'add', join(pier, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    return { pier, quay };
  }

  async function openLiveRepository(fixture: ComponentFixture<WorkspaceComponent>, name: string): Promise<void> {
    const overlay = fixture.nativeElement.querySelector('[data-testid="switching-overlay"]');
    const scope = overlay instanceof HTMLElement ? overlay : fixture.nativeElement;
    const button = scope.querySelector(`[data-testid="repository"][data-name="${name}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`${name} is not on the repository card`);
    }
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    await whenRemoteRefreshIdle();
    fixture.detectChanges();
  }

  function openRepositoryTabMenu(fixture: ComponentFixture<WorkspaceComponent>, name: string): HTMLElement {
    const tab = fixture.nativeElement.querySelector(`[data-testid="repository-tab"][data-name="${name}"]`);
    if (!(tab instanceof HTMLElement)) {
      throw new Error(`${name} has no repository tab`);
    }
    tab.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 16 }),
    );
    fixture.detectChanges();
    const menu = fixture.nativeElement.querySelector('[data-testid="repository-tab-menu"]');
    if (!(menu instanceof HTMLElement)) {
      throw new Error('The repository tab menu is not open');
    }
    return menu;
  }

  it('shows a centered repository card and no branch list on first start', async () => {
    const fixture = await render();
    const card = fixture.nativeElement.querySelector('[data-testid="repository-card"]');

    expect(card).not.toBeNull();
    const frame = getComputedStyle(card.parentElement);
    expect(frame.display).toBe('flex');
    expect(frame.justifyContent).toBe('center');
    expect(frame.alignItems).toBe('center');
    expect(fixture.nativeElement.querySelector('[data-testid="branch-list"]')).toBeNull();

    const names = [...card.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual(['Harbor', 'Atlas']);
    expect(card.textContent).toContain('Harbor');
    expect(card.textContent).toContain('Atlas');
  });

  it('shows the Harbor workspace after choosing Harbor', async () => {
    const fixture = await render();
    const harbor = fixture.nativeElement.querySelector(
      '[data-testid="repository"][data-name="Harbor"]',
    );

    harbor.click();
    fixture.detectChanges();

    const workspace = fixture.nativeElement.querySelector('[data-testid="workspace"]');
    expect(workspace).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toContain('origin/release');
  });

  it('switches from Harbor to Atlas through a centered repository overlay', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="switching-overlay"]');
    expect(overlay).not.toBeNull();
    const card = overlay.querySelector('[data-testid="repository-card"]');
    const frame = getComputedStyle(card.parentElement);
    expect(frame.display).toBe('flex');
    expect(frame.justifyContent).toBe('center');
    expect(frame.alignItems).toBe('center');
    const names = [...card.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual(['Harbor', 'Atlas']);

    overlay.querySelector('[data-testid="repository"][data-name="Atlas"]').click();
    fixture.detectChanges();

    expect(branchNames(fixture)).toContain('main');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
  });

  it('closes the repository switcher from the card without changing the open repository', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="switching-overlay"]');
    const close = overlay.querySelector('[data-testid="close-repository-switcher"]');
    expect(close.textContent.trim()).toBe('Close');

    close.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the repository switcher when the overlay outside the card is clicked', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();

    const overlay = fixture.nativeElement.querySelector('[data-testid="switching-overlay"]');
    overlay.querySelector('[data-testid="repository-card"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).not.toBeNull();

    overlay.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the repository switcher when Escape is pressed', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('opens the workspace window without an operating-system frame', () => {
    const main = readFileSync('src/desktop/electron-main.mjs', 'utf8');
    expect(main).toContain('frame: false');
  });

  it('rounds the workspace window itself', async () => {
    const fixture = await render();
    const host = getComputedStyle(fixture.nativeElement);
    expect(Number.parseFloat(host.borderRadius)).toBeGreaterThanOrEqual(8);
    expect(host.overflow).toBe('hidden');
    expect(host.backgroundColor).toBe('rgb(26, 60, 43)');

    const main = readFileSync('src/desktop/electron-main.mjs', 'utf8');
    expect(main).toContain('frame: false');
    expect(main).toContain('transparent: true');
    expect(main).toContain('backgroundColor: \'#00000000\'');
    expect(main).toContain('roundedCorners: true');
  });

  it('minimizes, maximizes, and closes the window from the top bar', async () => {
    const actions: string[] = [];
    setWindowChrome((action) => {
      actions.push(action);
    });
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const aside = fixture.nativeElement.querySelector('aside');
    const minimize = bar.querySelector('[data-testid="window-minimize"]');
    const maximize = bar.querySelector('[data-testid="window-maximize"]');
    const close = bar.querySelector('[data-testid="window-close"]');
    expect(aside.contains(minimize)).toBe(false);
    expect(aside.contains(maximize)).toBe(false);
    expect(aside.contains(close)).toBe(false);

    minimize.click();
    maximize.click();
    close.click();

    expect(actions).toEqual(['minimize', 'maximize', 'close']);
  });

  it('drags the workspace window from the top bar', async () => {
    const actions: string[] = [];
    setWindowChrome((action) => {
      actions.push(action);
    });
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    expect(getComputedStyle(bar).getPropertyValue('-webkit-app-region')).toBe('drag');

    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 12 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 28, clientY: 14 }));

    expect(actions).toEqual(['drag']);
  });

  it('does not drag the window from the top bar controls', async () => {
    const actions: string[] = [];
    setWindowChrome((action) => {
      actions.push(action);
    });
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const controls = [
      bar.querySelector('[data-testid="repository-tab"]'),
      bar.querySelector('[data-testid="open-repository-card"]'),
      fixture.nativeElement.querySelector('p.branch-label [data-testid="repository-settings"]'),
      bar.querySelector('[data-testid="app-settings"]'),
      bar.querySelector('[data-testid="window-minimize"]'),
      bar.querySelector('[data-testid="window-maximize"]'),
      bar.querySelector('[data-testid="window-close"]'),
    ];

    for (const control of controls) {
      expect(getComputedStyle(control).getPropertyValue('-webkit-app-region')).toBe('no-drag');
      const hit = control.querySelector('svg') ?? control;
      hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 4, clientY: 4 }));
      hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
    }

    expect(actions).toEqual([]);
  });

  it('places an App settings gear in the window controls, left of Minimize', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const controls = bar.querySelector('.window-controls');
    const gear = bar.querySelector('[data-testid="app-settings"]');
    const minimize = bar.querySelector('[data-testid="window-minimize"]');
    const maximize = bar.querySelector('[data-testid="window-maximize"]');

    expect(gear).not.toBeNull();
    expect(gear.tagName).toBe('BUTTON');
    expect(gear.getAttribute('aria-label')).toBe('App settings');
    expect(gear.querySelector('svg')).not.toBeNull();
    expect(controls.contains(gear)).toBe(true);
    expect(gear.compareDocumentPosition(minimize) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(getComputedStyle(gear).width).toBe(getComputedStyle(minimize).width);
    expect(getComputedStyle(gear).height).toBe(getComputedStyle(minimize).height);
    expect(getComputedStyle(gear).width).toBe('28px');
    expect(getComputedStyle(gear).height).toBe('28px');
    expect(horizontalGap(gear, minimize)).toBeGreaterThan(horizontalGap(minimize, maximize));
  });

  it('keeps the App settings gear off the repository card and the start screen', async () => {
    const start = await render();
    const card = start.nativeElement.querySelector('[data-testid="repository-card"]');
    expect(start.nativeElement.querySelector('[data-testid="app-settings"]')).toBeNull();
    expect(card.querySelector('[data-testid="app-settings"]')).toBeNull();

    start.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    start.detectChanges();
    openRepositoryCard(start);
    start.detectChanges();

    const overlayCard = start.nativeElement.querySelector(
      '[data-testid="switching-overlay"] [data-testid="repository-card"]',
    );
    expect(overlayCard.querySelector('[data-testid="app-settings"]')).toBeNull();
    expect(start.nativeElement.querySelector('[data-testid="window-bar"] [data-testid="app-settings"]')).not.toBeNull();
  });

  it('closes App settings from the backdrop and Escape, and keeps it open when the panel is clicked', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('App settings');
    expect(getComputedStyle(dialog).backgroundColor).toBe('rgba(26, 60, 43, 0.45)');
    const panel = dialog.querySelector('.dialog-panel');
    const panelStyle = getComputedStyle(panel);
    expect(panelStyle.backgroundColor).toBe('rgb(247, 247, 245)');
    expect(panelStyle.borderRadius).toBe('8px');
    expect(getComputedStyle(dialog.querySelector('h2')).color).toBe('rgb(26, 60, 43)');

    panel.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]')).toBeNull();
  });

  it('saves Sibling as soon as it is chosen and shows that choice when App settings reopens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    const labels = [...dialog.querySelectorAll('label')].map((label) => label.textContent.trim());
    expect(labels).toEqual([
      'Workspaces',
      'Sibling',
      'None',
      'Terminal',
      'Tmux',
      'IDE command',
      'Font family',
      'White',
      'Black',
    ]);
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(true);
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(false);
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent.trim())).not.toContain('Save');

    layoutChoice(dialog, 'Sibling').click();
    fixture.detectChanges();
    expect(readAppSettings().defaultLayout).toBe('sibling');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const reopened = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    expect(layoutChoice(reopened, 'Sibling').checked).toBe(true);
    expect(layoutChoice(reopened, 'Workspaces').checked).toBe(false);
  });

  it('saves the IDE command as soon as it changes and shows it when App settings reopens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    const field = dialog.querySelector('[data-testid="ide-command"]');
    expect(field).toBeInstanceOf(HTMLInputElement);
    if (!(field instanceof HTMLInputElement)) {
      return;
    }
    expect(field.value).toBe('');
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent.trim())).not.toContain('Save');

    field.value = 'cursor --reuse-window';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(readAppSettings().ideCommand).toBe('cursor --reuse-window');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const reopened = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] [data-testid="ide-command"]');
    expect(reopened).toBeInstanceOf(HTMLInputElement);
    if (!(reopened instanceof HTMLInputElement)) {
      return;
    }
    expect(reopened.value).toBe('cursor --reuse-window');
  });

  it('shows a disabled IDE button to the right of the selected branch name while the command is empty', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const heading = fixture.nativeElement.querySelector('[data-testid="content-sheet"] .branch-heading');
    const name = heading.querySelector('[data-testid="copy-branch-name"]');
    const ide = heading.querySelector('[data-testid="open-ide"]');
    expect(ide).toBeInstanceOf(HTMLButtonElement);
    if (!(ide instanceof HTMLButtonElement) || !(name instanceof HTMLElement)) {
      return;
    }
    expect(ide.textContent).toContain('IDE');
    expect(ide.querySelector('svg')).not.toBeNull();
    expect(getComputedStyle(ide).display).not.toBe('none');
    expect(getComputedStyle(ide).visibility).not.toBe('hidden');
    expect(ide.disabled).toBe(true);
    expect(rightEdge(ide)).toBeGreaterThan(rightEdge(name));
  });

  it('opens the primary checkout in the IDE from the branch header', async () => {
    const launched: Array<{ command: string; cwd: string }> = [];
    setIdeLaunch((command, cwd) => {
      launched.push({ command, cwd });
    });

    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"code -n {folder}"}\n');

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const ide = fixture.nativeElement.querySelector(
      '[data-testid="content-sheet"] .branch-heading [data-testid="open-ide"]',
    );
    expect(ide).toBeInstanceOf(HTMLButtonElement);
    if (!(ide instanceof HTMLButtonElement)) {
      return;
    }
    expect(ide.disabled).toBe(false);
    ide.click();
    fixture.detectChanges();

    expect(launched).toEqual([{ command: `code -n '${repoPath}'`, cwd: repoPath }]);
  });

  it('opens a branch checkout in the IDE instead of the primary repository', async () => {
    const launched: Array<{ command: string; cwd: string }> = [];
    setIdeLaunch((command, cwd) => {
      launched.push({ command, cwd });
    });

    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"code -n {folder}"}\n');
    git(repoPath, ['branch', 'feature']);
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    const ide = fixture.nativeElement.querySelector('[data-testid="open-ide"]');
    expect(ide).toBeInstanceOf(HTMLButtonElement);
    if (!(ide instanceof HTMLButtonElement)) {
      return;
    }
    ide.click();
    fixture.detectChanges();

    expect(launched).toEqual([{ command: `code -n '${checkout}'`, cwd: checkout }]);
  });

  it('runs an IDE command without {folder} in the selected checkout', async () => {
    const launched: Array<{ command: string; cwd: string }> = [];
    setIdeLaunch((command, cwd) => {
      launched.push({ command, cwd });
    });

    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const field = fixture.nativeElement.querySelector('[data-testid="ide-command"]');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('missing IDE command');
    }
    field.value = 'cursor --reuse-window';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    const ide = fixture.nativeElement.querySelector('[data-testid="open-ide"]');
    expect(ide).toBeInstanceOf(HTMLButtonElement);
    if (!(ide instanceof HTMLButtonElement)) {
      return;
    }
    expect(ide.disabled).toBe(false);
    ide.click();
    fixture.detectChanges();

    expect(launched).toEqual([{ command: 'cursor --reuse-window', cwd: repoPath }]);
  });

  it('shows a launch error on the workspace when the IDE fails to start', async () => {
    setIdeLaunch(() => {
      throw new Error('cursor failed to start');
    });

    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"cursor"}\n');

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="open-ide"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'cursor failed to start',
    );
  });

  it('shows a shell failure from the IDE command on the workspace', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"exit 9"}\n');

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="open-ide"]').click();
    await untilVisible(
      fixture,
      (workspace) => workspace.querySelector('[data-testid="workspace-error"]') !== null,
    );

    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'Command failed: exit 9',
    );
  });

  it('shows an error when the selected branch has no checkout to open', async () => {
    const launched: string[] = [];
    setIdeLaunch(() => {
      launched.push('launched');
    });

    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-ide-missing-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"cursor"}\n');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const ide = fixture.nativeElement.querySelector('[data-testid="open-ide"]');
    expect(ide).toBeInstanceOf(HTMLButtonElement);
    if (!(ide instanceof HTMLButtonElement)) {
      return;
    }
    expect(ide.disabled).toBe(false);
    ide.click();
    fixture.detectChanges();

    expect(launched).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'No checkout for this branch',
    );
  });

  it('offers sidebar and content color choosers and a reset button in App settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="default-layout-heading"]').textContent.trim()).toBe('Default layout');
    expect(dialog.querySelector('[data-testid="colors-heading"]').textContent.trim()).toBe('Colors');
    const sidebar = dialog.querySelector('[data-testid="sidebar-color"]');
    const content = dialog.querySelector('[data-testid="content-color"]');
    const reset = dialog.querySelector('[data-testid="reset-colors"]');
    const close = dialog.querySelector('[data-testid="close-app-settings"]');
    expect(sidebar).toBeInstanceOf(HTMLInputElement);
    expect(sidebar.type).toBe('color');
    expect(sidebar.getAttribute('aria-label')).toBe('Custom sidebar color');
    expect(sidebar.value).toBe('#1a3c2b');
    expect(content).toBeInstanceOf(HTMLInputElement);
    expect(content.type).toBe('color');
    expect(content.getAttribute('aria-label')).toBe('Custom content color');
    expect(content.value).toBe('#f7f7f5');
    const sidebarSwatches = [...dialog.querySelectorAll('[data-testid="sidebar-swatch"]')].map((swatch) =>
      swatch.getAttribute('data-color'),
    );
    const contentSwatches = [...dialog.querySelectorAll('[data-testid="content-swatch"]')].map((swatch) =>
      swatch.getAttribute('data-color'),
    );
    expect(sidebarSwatches).toContain('#1a3c2b');
    expect(sidebarSwatches).toContain('#065f46');
    expect(contentSwatches).toContain('#f7f7f5');
    expect(contentSwatches).toContain('#ecfdf5');
    expect(dialog.querySelector('[data-testid="sidebar-swatch"][data-color="#1a3c2b"]').classList.contains('is-selected')).toBe(
      true,
    );
    expect(reset.tagName).toBe('BUTTON');
    expect(reset.textContent.trim()).toBe('Reset');
    expect(close.tagName).toBe('BUTTON');
    expect(close.textContent.trim()).toBe('Close');
  });

  it('applies a curated sidebar color from the swatch and still accepts a custom color', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(readAppSettings().sidebarColor).toBe('#065f46');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]')
        .classList.contains('is-selected'),
    ).toBe(true);

    pickColor(fixture.nativeElement.querySelector('[data-testid="sidebar-color"]'), '#123456');
    fixture.detectChanges();
    expect(readAppSettings().sidebarColor).toBe('#123456');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
  });

  it('closes App settings from the Close button', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]')).toBeNull();
  });

  it('paints the open window with the chosen sidebar color and keeps the selected row white', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    pickColor(fixture.nativeElement.querySelector('[data-testid="sidebar-color"]'), '#123456');
    fixture.detectChanges();

    const selected = fixture.nativeElement.querySelector('.branch-row.is-selected');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(selected).color).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(selected).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(
      getComputedStyle(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] h2')).color,
    ).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('.branch-heading h2')).color).toBe('rgb(18, 52, 86)');
    expect(readAppSettings().sidebarColor).toBe('#123456');

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    expect(
      getComputedStyle(fixture.nativeElement.querySelector('[data-testid="confirm-create-worktree"]')).backgroundColor,
    ).toBe('rgb(18, 52, 86)');
  });

  it('paints the content sheet, dialogs, and light buttons with the chosen content color', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    pickColor(fixture.nativeElement.querySelector('[data-testid="content-color"]'), '#abcdef');
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(171, 205, 239)',
    );
    expect(
      getComputedStyle(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] .dialog-panel'))
        .backgroundColor,
    ).toBe('rgb(171, 205, 239)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="create-worktree"]')).backgroundColor).toBe(
      'rgb(171, 205, 239)',
    );
    const menuEvent = openWorktreeMenu(
      fixture.nativeElement.querySelector('.branch-row.is-selected') as Element,
    );
    fixture.detectChanges();
    expect(menuEvent.defaultPrevented).toBe(true);
    expect(
      getComputedStyle(fixture.nativeElement.querySelector('[data-testid="hover-menu"].is-open')).backgroundColor,
    ).toBe('rgb(171, 205, 239)');
    expect(fixture.nativeElement.querySelector('[data-testid="branch-menu"]')).toBeNull();
    expect(readAppSettings().contentColor).toBe('#abcdef');
  });

  it('shows the saved colors when the workspace is opened again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const first = await render();
    first.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    first.detectChanges();
    first.nativeElement.querySelector('[data-testid="app-settings"]').click();
    first.detectChanges();
    pickColor(first.nativeElement.querySelector('[data-testid="sidebar-color"]'), '#123456');
    pickColor(first.nativeElement.querySelector('[data-testid="content-color"]'), '#abcdef');
    first.detectChanges();

    const again = await render();
    again.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    again.detectChanges();

    expect(getComputedStyle(again.nativeElement).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(again.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(again.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(171, 205, 239)',
    );
    expect(readAppSettings()).toEqual({
      defaultLayout: 'workspaces',
      sidebarColor: '#123456',
      sidebarText: 'white',
      contentColor: '#abcdef',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
      terminalFont: 'UbuntuMono Nerd Font Mono',
      ideCommand: '',
      terminalMode: 'terminal',
      shellCommand: '',
      changesShare: null,
      terminalRowHeight: 240,
      changesFileWidth: 240,
      commitFileWidth: 240,
      diffMode: 'folded',
      diffLayout: 'inline',
      diffSideShare: 0.5,
    });
  });

  it('restores the original colors and leaves a saved Sibling layout in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"defaultLayout":"sibling","ideCommand":"cursor"}\n');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(true);
    pickColor(dialog.querySelector('[data-testid="sidebar-color"]'), '#123456');
    pickColor(dialog.querySelector('[data-testid="content-color"]'), '#abcdef');
    fixture.detectChanges();
    dialog.querySelector('[data-testid="reset-colors"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(247, 247, 245)',
    );
    expect(getComputedStyle(dialog.querySelector('.dialog-panel')).backgroundColor).toBe('rgb(247, 247, 245)');
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(true);
    expect(readAppSettings()).toEqual({
      defaultLayout: 'sibling',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
      terminalFont: 'UbuntuMono Nerd Font Mono',
      ideCommand: 'cursor',
      terminalMode: 'terminal',
      shellCommand: '',
      changesShare: null,
      terminalRowHeight: 240,
      changesFileWidth: 240,
      commitFileWidth: 240,
      diffMode: 'folded',
      diffLayout: 'inline',
      diffSideShare: 0.5,
    });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).ideCommand).toBe('cursor');
  });

  it('offers white or black sidebar text and reset restores white on the worktrees region', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    const white = dialog.querySelector('[data-testid="sidebar-text-white"]');
    const black = dialog.querySelector('[data-testid="sidebar-text-black"]');
    expect(white).toBeInstanceOf(HTMLInputElement);
    expect(black).toBeInstanceOf(HTMLInputElement);
    expect(white.type).toBe('radio');
    expect(black.type).toBe('radio');
    expect(white.checked).toBe(true);
    expect(black.checked).toBe(false);
    expect(white.closest('label').textContent).toContain('White');
    expect(black.closest('label').textContent).toContain('Black');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');

    black.click();
    fixture.detectChanges();

    expect(black.checked).toBe(true);
    expect(white.checked).toBe(false);
    expect(readAppSettings().sidebarText).toBe('black');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    const selected = fixture.nativeElement.querySelector('.branch-row.is-selected');
    expect(getComputedStyle(selected).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(selected).color).toBe('rgb(26, 60, 43)');

    white.click();
    fixture.detectChanges();
    expect(readAppSettings().sidebarText).toBe('white');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');

    black.click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="reset-colors"]').click();
    fixture.detectChanges();

    expect(white.checked).toBe(true);
    expect(black.checked).toBe(false);
    expect(readAppSettings().sidebarText).toBe('white');
    expect(readAppSettings().sidebarColor).toBe('#1a3c2b');
    expect(readAppSettings().contentColor).toBe('#f7f7f5');
    expect(readAppSettings().terminalBackground).toBe('#1e1e1e');
    expect(readAppSettings().terminalForeground).toBe('#d4d4d4');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
  });

  it('offers the same sidebar color controls and white or black sidebar text in repository settings', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const appDialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    const appSwatches = [...appDialog.querySelectorAll('[data-testid="sidebar-swatch"]')].map((swatch) =>
      swatch.getAttribute('data-color'),
    );
    const appCustom = appDialog.querySelector('[data-testid="sidebar-color"]');
    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const repoSwatches = [...dialog.querySelectorAll('[data-testid="repository-sidebar-swatch"]')].map((swatch) =>
      swatch.getAttribute('data-color'),
    );
    const custom = dialog.querySelector('[data-testid="repository-sidebar-color"]');
    const white = dialog.querySelector('[data-testid="repository-sidebar-text-white"]');
    const black = dialog.querySelector('[data-testid="repository-sidebar-text-black"]');

    expect(repoSwatches).toEqual(appSwatches);
    expect(repoSwatches).toContain('#1a3c2b');
    expect(repoSwatches).toContain('#065f46');
    expect(custom).toBeInstanceOf(HTMLInputElement);
    expect(custom.type).toBe('color');
    expect(custom.getAttribute('aria-label')).toBe('Custom sidebar color');
    expect(custom.value).toBe('#1a3c2b');
    expect(dialog.querySelector('[data-testid="repository-sidebar-swatch"][data-color="#1a3c2b"]').classList.contains('is-selected')).toBe(
      true,
    );
    expect(white).toBeInstanceOf(HTMLInputElement);
    expect(black).toBeInstanceOf(HTMLInputElement);
    expect(white.type).toBe('radio');
    expect(black.type).toBe('radio');
    expect(white.checked).toBe(true);
    expect(black.checked).toBe(false);
    expect(dialog.querySelector('[data-testid="use-app-sidebar-color"]').textContent.trim()).toBe('Use app settings');
    expect(dialog.querySelector('[data-testid="use-app-sidebar-text"]').textContent.trim()).toBe('Use app settings');
    expect(dialog.querySelector('[data-testid="content-color"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="terminal-background-color"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="terminal-foreground-color"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Workspaces, the app default',
    );
    expect(appCustom.getAttribute('aria-label')).toBe('Custom sidebar color');
  });

  it('stores a repository sidebar color and sidebar text even when they match app settings and paints the worktrees region', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"sidebarColor":"#1a3c2b","sidebarText":"white"}\n');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    dialog.querySelector('[data-testid="repository-sidebar-swatch"][data-color="#1a3c2b"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="repository-sidebar-text-white"]').click();
    fixture.detectChanges();

    const configPath = join(repoPath, '.git-worktree-manager', 'config.toml');
    expect(TOML.parse(readFileSync(configPath, 'utf8'))).toEqual({
      appearance: { sidebar_color: '#1a3c2b', sidebar_text: 'white' },
    });
    expect(readAppSettings().sidebarColor).toBe('#1a3c2b');
    expect(readAppSettings().sidebarText).toBe('white');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');

    pickColor(dialog.querySelector('[data-testid="repository-sidebar-color"]'), '#123456');
    fixture.detectChanges();
    dialog.querySelector('[data-testid="repository-sidebar-text-black"]').click();
    fixture.detectChanges();

    expect(TOML.parse(readFileSync(configPath, 'utf8'))).toEqual({
      appearance: { sidebar_color: '#123456', sidebar_text: 'black' },
    });
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(18, 52, 86)');
    const selected = fixture.nativeElement.querySelector('.branch-row.is-selected');
    expect(getComputedStyle(selected).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(selected).color).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(247, 247, 245)',
    );
  });

  it('uses app settings on the worktrees region until a repository sets its own sidebar', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    const fixture = await renderRepository(repoPath);

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');
    expect(existsSync(join(repoPath, '.git-worktree-manager', 'config.toml'))).toBe(false);

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    dialog.querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="sidebar-text-black"]').click();
    fixture.detectChanges();
    pickColor(dialog.querySelector('[data-testid="content-color"]'), '#abcdef');
    fixture.detectChanges();
    dialog.querySelector('[data-testid="terminal-background-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(171, 205, 239)',
    );
    expect(readAppSettings().sidebarColor).toBe('#065f46');
    expect(readAppSettings().sidebarText).toBe('black');
    expect(readAppSettings().contentColor).toBe('#abcdef');
    expect(readAppSettings().terminalBackground).toBe('#065f46');
    expect(existsSync(join(repoPath, '.git-worktree-manager', 'config.toml'))).toBe(false);
  });

  it('keeps a repository sidebar when app settings change and clears one choice with Use app settings', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      ['[layout]', 'mode = "sibling"', '', '[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join(
        '\n',
      ),
    );

    const fixture = await renderRepository(repoPath);
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const appDialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    appDialog.querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();
    appDialog.querySelector('[data-testid="sidebar-text-white"]').click();
    fixture.detectChanges();
    pickColor(appDialog.querySelector('[data-testid="content-color"]'), '#abcdef');
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(171, 205, 239)',
    );
    expect(readAppSettings().sidebarColor).toBe('#065f46');
    expect(readAppSettings().sidebarText).toBe('white');

    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Sibling, set by this repository',
    );
    dialog.querySelector('[data-testid="use-app-sidebar-color"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'))).toEqual({
      layout: { mode: 'sibling' },
      appearance: { sidebar_text: 'black' },
    });

    dialog.querySelector('[data-testid="use-app-sidebar-text"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'))).toEqual({
      layout: { mode: 'sibling' },
    });
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Sibling, set by this repository',
    );
  });

  it('paints each open repository from its own sidebar or from app settings, including a repository with no path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="sidebar-text-black"]').click();
    fixture.detectChanges();
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');

    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
  });

  it('paints every repository tab with that repository sidebar color and sidebar text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    const quayTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
    expect(quayTab.getAttribute('aria-selected')).toBe('true');
    expect(pierTab.getAttribute('aria-selected')).toBe('false');
    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(0, 0, 0)');
  });

  it('frames the selected repository tab in its sidebar text color', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    const quayTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(quayTab).outline).toBe('2px solid #000000');
    expect(getComputedStyle(quayTab).outlineOffset).toBe('-2px');
    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(pierTab).outline).toBe('none');

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(pierTab).outline).toBe('2px solid #ffffff');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(quayTab).outline).toBe('none');
  });

  it('paints the window bar from the selected workspace sidebar color and sidebar text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    const quayTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(bar).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="open-repository-card"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(bar.querySelector('[data-testid="app-settings"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(bar.querySelector('[data-testid="window-minimize"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(bar.querySelector('[data-testid="window-maximize"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(bar.querySelector('[data-testid="window-close"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(0, 0, 0)');

    pierTab.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(bar).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="open-repository-card"]')).color).toBe(
      'rgb(255, 255, 255)',
    );
    expect(getComputedStyle(bar.querySelector('[data-testid="window-minimize"]')).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(bar.querySelector('[data-testid="window-close"]')).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(18, 52, 86)');
  });

  it('updates a repository tab as soon as that repository sidebar color or sidebar text changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#123456"', 'sidebar_text = "black"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    pickColor(dialog.querySelector('[data-testid="repository-sidebar-color"]'), '#abcdef');
    fixture.detectChanges();
    dialog.querySelector('[data-testid="repository-sidebar-text-white"]').click();
    fixture.detectChanges();

    const quayTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
    const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(171, 205, 239)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).outline).toBe('2px solid #ffffff');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(171, 205, 239)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');

    pierTab.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(pierTab.getAttribute('aria-selected')).toBe('true');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(171, 205, 239)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).outline).toBe('none');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
  });

  it('follows a later app settings change for a sidebar choice the repository has not stored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(pier, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(pier, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_text = "white"', ''].join('\n'),
    );
    mkdirSync(join(quay, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(quay, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#1a3c2b"', ''].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    writeFileSync(join(root, 'app-settings.json'), '{"sidebarColor":"#1a3c2b","sidebarText":"white"}\n');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    const quayTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(255, 255, 255)');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]');
    dialog.querySelector('[data-testid="sidebar-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="sidebar-text-black"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(pierTab).outline).toBe('none');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(quayTab).outline).toBe('2px solid #000000');
    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="window-minimize"]')).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');

    pierTab.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getComputedStyle(pierTab).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(pierTab).color).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(pierTab).outline).toBe('2px solid #ffffff');
    expect(getComputedStyle(quayTab).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(quayTab).color).toBe('rgb(0, 0, 0)');
    expect(getComputedStyle(quayTab).outline).toBe('none');
    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="open-repository-card"]')).color).toBe(
      'rgb(255, 255, 255)',
    );
  });

  it('follows app settings when the open repository has no path for its own sidebar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    writeFileSync(join(root, 'app-settings.json'), '{"sidebarColor":"#065f46","sidebarText":"black"}\n');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    dialog.querySelector('[data-testid="repository-sidebar-swatch"][data-color="#1a3c2b"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="repository-sidebar-text-white"]').click();
    fixture.detectChanges();

    expect(readAppSettings().sidebarColor).toBe('#065f46');
    expect(readAppSettings().sidebarText).toBe('black');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).color).toBe('rgb(0, 0, 0)');
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Workspaces, the app default',
    );
  });

  it('names the app default layout on the create dialog for sample Harbor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const line = dialog.querySelector('[data-testid="create-layout"]');
    expect(line.tagName).toBe('P');
    expect(line.querySelector('input, textarea, select')).toBeNull();
    expect(line.textContent.trim()).toBe('Workspaces, the app default');

    dialog.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    layoutChoice(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]'), 'Sibling').click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"] [data-testid="create-layout"]').textContent.trim(),
    ).toBe('Sibling, the app default');
  });

  it('uses the app default for a repository with no layout mode', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(repoPath, 'Harbor');
    git(repoPath, ['branch', 'notes']);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe(
      'Workspaces, the app default',
    );

    fixture.nativeElement.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    layoutChoice(fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]'), 'Sibling').click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    expect(dialog.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe('Sibling, the app default');

    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    const checkout = join(root, 'notes');
    await untilVisible(fixture, () => existsSync(checkout));

    expect(git(checkout, ['branch', '--show-current'])).toBe('notes');
    expect(existsSync(join(repoPath, '.workspaces', 'notes'))).toBe(false);
  });

  it('names the repository layout even when the app default differs', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "workspaces"\n');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe(
      'Workspaces, set by this repository',
    );

    fixture.nativeElement.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();
    writeFileSync(settingsPath, '{"defaultLayout":"workspaces"}\n');
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe(
      'Sibling, set by this repository',
    );
  });

  it('shows an unsupported repository layout and still refuses to create it', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');
    git(repoPath, ['branch', 'notes']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "custom"\n');
    addRepository(repoPath, 'Harbor');
    const worktreesBefore = git(repoPath, ['worktree', 'list']);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    expect(dialog.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe(
      'custom, set by this repository',
    );

    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(fixture, (rootElement) =>
      (rootElement.querySelector('[data-testid="create-worktree-dialog"] [data-testid="workspace-error"]')?.textContent ?? '').includes(
        'Unsupported layout: custom',
      ),
    );

    expect(dialog.querySelector('[data-testid="workspace-error"]').textContent).toContain('Unsupported layout: custom');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'notes'))).toBe(false);
    expect(existsSync(join(root, 'notes'))).toBe(false);
  });

  it('shows the app icon, one repository tab, and + in the top bar', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const aside = fixture.nativeElement.querySelector('aside');
    const mark = bar.querySelector('[data-testid="app-mark"]');
    const tabs = bar.querySelector('[data-testid="repository-tabs"]');
    const tab = tabs.querySelector('[data-testid="repository-tab"]');
    const open = tabs.querySelector('[data-testid="open-repository-card"]');
    const appSettings = bar.querySelector('[data-testid="app-settings"]');
    const minimize = bar.querySelector('[data-testid="window-minimize"]');
    const worktrees = aside.querySelector('p.branch-label');
    const repositorySettings = worktrees.querySelector('[data-testid="repository-settings"]');

    expect(bar.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(bar.querySelector('[data-testid="switch-repository"]')).toBeNull();
    expect(bar.querySelector('[data-testid="repository-settings"]')).toBeNull();
    expect(aside.querySelector('.repo-path')).toBeNull();
    expect(aside.contains(minimize)).toBe(false);
    expect(getComputedStyle(bar).justifyContent).toBe('space-between');
    expect(tabs.querySelectorAll('[data-testid="repository-tab"]')).toHaveLength(1);
    expect(tab.getAttribute('data-name')).toBe('harbor');
    expect(tab.getAttribute('data-path')).toBe(repoPath);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.textContent.trim()).toBe('harbor');
    expect(mark.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(tab.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(open.compareDocumentPosition(appSettings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(appSettings.compareDocumentPosition(minimize) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(bar.querySelector('.window-controls').contains(appSettings)).toBe(true);
    expect(bar.querySelector('.window-controls').contains(minimize)).toBe(true);
    expect(worktrees.querySelector('span').textContent.trim()).toBe('Worktrees');
    expect(worktrees.querySelector('span').compareDocumentPosition(repositorySettings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();

    open.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).not.toBeNull();
  });

  it('insets the title and leads with the app mark', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('.window-title');
    const mark = title.querySelector('[data-testid="app-mark"]');
    const name = title.querySelector('[data-testid="repository-tabs"]');

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const spaceAboveIcon = (parseFloat(getComputedStyle(bar).height) - parseFloat(mark.getAttribute('height') ?? '0')) / 2;
    expect(getComputedStyle(title).paddingLeft).toBe(`${spaceAboveIcon}px`);
    expect(title.firstElementChild).toBe(mark);
    expect(mark.tagName).toBe('svg');
    expect(mark.closest('button')).toBeNull();
    expect(mark.getAttribute('width')).toBe('16');
    expect(mark.getAttribute('height')).toBe('16');
    expect(mark.querySelector('rect').getAttribute('fill')).toBe('#1a3c2b');
    expect(mark.querySelector('rect').getAttribute('rx')).toBe('3.5');
    expect(mark.querySelectorAll('circle')).toHaveLength(3);
    expect(mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('ellipsizes a repository tab and shows the full display name as its tooltip', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    const displayName = 'North Harbor Warehouse and Dry Dock';
    addRepository(repoPath, displayName);
    const fixture = await renderRepository(repoPath);
    const tab = fixture.nativeElement.querySelector('[data-testid="repository-tab"]');
    const style = getComputedStyle(tab);

    expect(tab.getAttribute('data-name')).toBe(displayName);
    expect(tab.getAttribute('title')).toBe(displayName);
    expect(tab.textContent.trim()).toBe(displayName);
    expect(style.maxWidth).toBe('160px');
    expect(style.overflowX).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.whiteSpace).toBe('nowrap');
  });

  it('scrolls repository tabs together with + and scrolls the selected tab into view', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this);
    };
    const fixture = await renderLive();
    try {
      fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
      fixture.detectChanges();
      const pierTab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
      expect(scrolled).toContain(pierTab);

      openRepositoryCard(fixture);
      fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]').click();
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelector('[data-testid="repository-tabs"]');
      const quayTab = tabs.querySelector('[data-testid="repository-tab"][data-name="Quay"]');
      const open = tabs.querySelector('[data-testid="open-repository-card"]');
      expect(tabs.contains(pierTab)).toBe(true);
      expect(tabs.contains(quayTab)).toBe(true);
      expect(tabs.contains(open)).toBe(true);
      expect(['auto', 'scroll']).toContain(getComputedStyle(tabs).overflowX);
      expect(scrolled).toContain(quayTab);

      scrolled.length = 0;
      const selectedPier = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
      selectedPier.click();
      fixture.detectChanges();
      expect(scrolled[0]).toBe(selectedPier);

      scrolled.length = 0;
      fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
      fixture.detectChanges();
      scrolled.length = 0;
      const closeQuay = openRepositoryTabMenu(fixture, 'Quay').querySelector('[data-testid="repository-tab-close"]');
      if (!(closeQuay instanceof HTMLElement)) {
        throw new Error('Close is not in the repository tab menu');
      }
      closeQuay.click();
      fixture.detectChanges();
      const pierAfterClose = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
      expect(pierAfterClose.getAttribute('aria-selected')).toBe('true');
      expect(scrolled).toContain(pierAfterClose);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('appends a repository tab when a registered repository is opened and does not reorder it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const alpha = join(root, 'a-alpha');
    const beta = join(root, 'b-beta');
    const gamma = join(root, 'c-gamma');
    initGitRepo(alpha);
    initGitRepo(beta);
    initGitRepo(gamma);
    writeFileSync(join(alpha, 'README.md'), '# alpha\n');
    writeFileSync(join(beta, 'README.md'), '# beta\n');
    writeFileSync(join(gamma, 'README.md'), '# gamma\n');
    git(alpha, ['add', '.']);
    git(alpha, ['commit', '-m', 'init']);
    git(beta, ['add', '.']);
    git(beta, ['commit', '-m', 'init']);
    git(gamma, ['add', '.']);
    git(gamma, ['commit', '-m', 'init']);
    mkdirSync(join(alpha, '.workspaces'));
    git(alpha, ['branch', 'feature']);
    git(alpha, ['worktree', 'add', join(alpha, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(gamma, 'Gamma');
    addRepository(alpha, 'Alpha');
    addRepository(beta, 'Beta');

    const fixture = await renderLive();
    const startNames = [...fixture.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(startNames).toEqual(['Alpha', 'Beta', 'Gamma']);

    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Alpha"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    const offered = [...fixture.nativeElement.querySelectorAll('[data-testid="switching-overlay"] [data-testid="repository"]')].map(
      (element) => element.getAttribute('data-name'),
    );
    expect(offered).toEqual(['Beta', 'Gamma']);
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Gamma"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const names = () =>
      [...fixture.nativeElement.querySelectorAll('[data-testid="repository-tab"]')].map((element) =>
        element.getAttribute('data-name'),
      );
    expect(names()).toEqual(['Alpha', 'Gamma']);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Gamma"]').getAttribute('aria-selected')).toBe(
      'true',
    );

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Alpha"]').click();
    fixture.detectChanges();

    expect(names()).toEqual(['Alpha', 'Gamma']);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="repository-tab"][data-name="Alpha"]')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Alpha"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('feature');
  });

  it('keeps Add repository on the card when every registered repository already has a tab', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();
    expect(fixture.nativeElement.querySelector('[data-testid="repositories-empty"]')).toBeNull();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    const card = fixture.nativeElement.querySelector('[data-testid="switching-overlay"] [data-testid="repository-card"]');
    expect(card.querySelector('h2').textContent.trim()).toBe('Repositories');
    expect(card.querySelector('[data-testid="add-repository"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="repository"]')).toBeNull();
    expect(card.querySelector('[data-testid="repositories-empty"]')).toBeNull();
  });

  it('registers a repository from an open card without opening it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    setFolderBrowser(async () => quay);
    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = 'Quay';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).not.toBeNull();
    const offered = [...fixture.nativeElement.querySelectorAll('[data-testid="switching-overlay"] [data-testid="repository"]')].map(
      (element) => element.getAttribute('data-name'),
    );
    expect(offered).toEqual(['Quay']);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('uses the app mark as the window icon', () => {
    const main = readFileSync('src/desktop/electron-main.mjs', 'utf8');
    expect(main).toContain("icon: join(import.meta.dirname, 'app-icon.png')");

    const png = readFileSync('src/desktop/app-icon.png');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });

  it('copies the repository location from repository settings', async () => {
    const copied: string[] = [];
    setTextCopy((text) => {
      copied.push(text);
    });

    const repoPath = createEmptyRepository(roots);
    const opened = await renderRepository(repoPath);
    expect(opened.nativeElement.querySelector('[data-testid="window-bar"] [data-testid="repository-name"]')).toBeNull();
    opened.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    opened.detectChanges();
    const location = opened.nativeElement.querySelector('[data-testid="repository-location"]');
    expect(location.getAttribute('title')).toBe('Copy location');
    location.click();
    expect(copied).toEqual([repoPath]);
  });

  it('copies the branch name when that name in the content is clicked', async () => {
    const copied: string[] = [];
    setTextCopy((text) => {
      copied.push(text);
    });

    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const heading = fixture.nativeElement.querySelector('[data-testid="content-sheet"] .branch-heading');
    const name = heading.querySelector('[data-testid="copy-branch-name"]');
    const icon = name.querySelector('[data-testid="copy-branch-icon"]');
    expect(name.textContent.trim()).toBe('feature/login');
    expect(name.getAttribute('title')).toBe('Copy branch name');
    expect(icon).not.toBeNull();
    expect(getComputedStyle(name).cursor).toBe('pointer');
    expect(getComputedStyle(icon).opacity).toBe('0');

    const css = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    const hoverShowsIcon = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((match) => {
      const selector = match[1] ?? '';
      const body = match[2] ?? '';
      return (
        selector.includes("[data-testid='copy-branch-name']") &&
        selector.includes(':hover') &&
        selector.includes("[data-testid='copy-branch-icon']") &&
        /opacity\s*:\s*1/.test(body)
      );
    });
    expect(hoverShowsIcon).toBe(true);

    name.click();
    expect(copied).toEqual(['feature/login']);
  });

  it('opens repository settings from the right of the Worktrees row', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);

    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).toBeNull();

    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const label = fixture.nativeElement.querySelector('p.branch-label');
    const settings = label.querySelector('[data-testid="repository-settings"]');

    expect(settings).not.toBeNull();
    expect(settings.tagName).toBe('BUTTON');
    expect(settings.getAttribute('aria-label')).toBe('Repository settings');
    expect(settings.querySelector('svg')).not.toBeNull();
    expect(bar.querySelector('[data-testid="repository-settings"]')).toBeNull();
    expect(label.querySelector('span').textContent.trim()).toBe('Worktrees');
    expect(label.querySelector('span').compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    settings.click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Repository settings');
    expect(fixture.nativeElement.querySelector('aside')?.contains(dialog)).toBe(false);
    expect(dialog.querySelector('h2').textContent.trim()).toBe('Repository settings');
    const panel = dialog.querySelector('.dialog-panel');
    const panelStyle = getComputedStyle(panel);
    expect(panelStyle.backgroundColor).toBe('rgb(247, 247, 245)');
    expect(panelStyle.borderRadius).toBe('8px');
    expect(getComputedStyle(dialog.querySelector('h2')).color).toBe('rgb(26, 60, 43)');

    dialog.querySelector('[data-testid="close-repository-settings"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).toBeNull();
  });

  it('renames a repository from its settings and updates that repository tab', async () => {
    const { pier, quay } = registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();

    openRepositoryTabMenu(fixture, 'Quay').querySelector('[data-testid="repository-tab-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const name = dialog.querySelector('[data-testid="repository-display-name"]');
    expect(name.value).toBe('Quay');
    name.value = 'North Quay';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const renamed = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-path="' + quay + '"]');
    expect(renamed.getAttribute('data-name')).toBe('North Quay');
    expect(renamed.getAttribute('title')).toBe('North Quay');
    expect(renamed.textContent.trim()).toBe('North Quay');
    expect(renamed.getAttribute('aria-selected')).toBe('false');
    expect(
      fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected'),
    ).toBe('true');
    expect(findRepository(quay)?.displayName).toBe('North Quay');
    expect(findRepository(pier)?.displayName).toBe('Pier');

    name.value = '   ';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="display-name-error"]').textContent.trim()).toBe('Enter a display name');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="North Quay"]')).not.toBeNull();
    expect(findRepository(quay)?.displayName).toBe('North Quay');
  });

  it('centers the repository and app settings icons', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    const root = fixture.nativeElement;
    const buttons = [
      ['repository-settings', 'Repository settings', 'repository-settings-dialog'],
      ['app-settings', 'App settings', 'app-settings-dialog'],
    ] as const;

    for (const [testId, label, dialogId] of buttons) {
      const button = root.querySelector(`[data-testid="${testId}"]`);
      expect(button.getAttribute('aria-label')).toBe(label);

      const style = getComputedStyle(button);
      expect(style.display === 'inline-flex' || style.display === 'flex').toBe(true);
      expect(style.alignItems).toBe('center');
      expect(style.justifyContent).toBe('center');
      expect(style.paddingTop).toBe('0px');
      expect(style.paddingRight).toBe('0px');
      expect(style.paddingBottom).toBe('0px');
      expect(style.paddingLeft).toBe('0px');

      const svg = button.querySelector('svg');
      expect(getComputedStyle(svg).display).toBe('block');
      const path = svg.querySelector('path').getAttribute('d');
      expect(path).toContain('M11 8a3 3 0 1 1-6 0');
      expect(path).not.toContain('M8 1.2');

      expect(root.querySelector(`[data-testid="${dialogId}"]`)).toBeNull();
      button.click();
      fixture.detectChanges();
      expect(root.querySelector(`[data-testid="${dialogId}"]`)).not.toBeNull();
    }
  });

  it('shows the open repository location in settings', async () => {
    const repoPath = createEmptyRepository(roots);
    const opened = await renderRepository(repoPath);
    opened.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    opened.detectChanges();

    const openedDialog = opened.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(openedDialog.querySelector('[data-testid="repository-location"]').textContent).toBe(repoPath);

    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');

    const live = await renderLive();
    live.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    live.detectChanges();
    await live.whenStable();
    live.detectChanges();
    live.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    live.detectChanges();

    const dialog = live.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="repository-location"]').textContent).toBe(pier);
  });

  it('copies the repository location from settings', async () => {
    const copied: string[] = [];
    setTextCopy((text) => {
      copied.push(text);
    });

    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const location = dialog.querySelector('[data-testid="repository-location"]');
    const icon = location.querySelector('[data-testid="copy-location-icon"]');
    expect(location.textContent).toBe(repoPath);
    expect(location.getAttribute('title')).toBe('Copy location');
    expect(icon).not.toBeNull();
    expect(getComputedStyle(location).cursor).toBe('pointer');
    expect(getComputedStyle(icon).opacity).toBe('0');

    const css = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    const hoverShowsIcon = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((match) => {
      const selector = match[1] ?? '';
      const body = match[2] ?? '';
      return (
        selector.includes("[data-testid='repository-location']") &&
        selector.includes(':hover') &&
        selector.includes("[data-testid='copy-location-icon']") &&
        /opacity\s*:\s*1/.test(body)
      );
    });
    expect(hoverShowsIcon).toBe(true);

    location.click();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(copied).toEqual([repoPath]);
  });

  it('shows the app default worktree mode in repository settings without writing a config', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const location = dialog.querySelector('[data-testid="repository-location"]');
    const heading = dialog.querySelector('[data-testid="worktree-mode-heading"]');
    const source = dialog.querySelector('[data-testid="worktree-mode-source"]');
    const remotes = dialog.querySelector('[data-testid="remotes-heading"]');
    const workspaces = layoutChoice(dialog, 'Workspaces');
    const sibling = layoutChoice(dialog, 'Sibling');

    expect(location.textContent).toBe(repoPath);
    expect(heading.textContent.trim()).toBe('Worktree mode');
    expect(heading.tagName).toBe('H3');
    expect(getComputedStyle(heading).textTransform).toBe('uppercase');
    expect(source.textContent.trim()).toBe('Workspaces, the app default');
    expect(workspaces.checked).toBe(true);
    expect(sibling.checked).toBe(false);
    expect(workspaces.name).toBe('worktree-mode');
    expect(sibling.name).toBe('worktree-mode');
    expect(workspaces.getAttribute('data-testid')).toBe('worktree-mode-workspaces');
    expect(sibling.getAttribute('data-testid')).toBe('worktree-mode-sibling');
    expect(location.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(heading.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(source.compareDocumentPosition(workspaces) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(sibling.compareDocumentPosition(remotes) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(existsSync(join(repoPath, '.git-worktree-manager', 'config.toml'))).toBe(false);

    const workspacesLabel = workspaces.closest('label');
    const siblingLabel = sibling.closest('label');
    const locationLabel = location.closest('label');
    expect(workspacesLabel).not.toBeNull();
    expect(siblingLabel).not.toBeNull();
    expect(locationLabel).not.toBeNull();
    if (
      !(workspacesLabel instanceof HTMLElement) ||
      !(siblingLabel instanceof HTMLElement) ||
      !(locationLabel instanceof HTMLElement)
    ) {
      return;
    }
    for (const label of [workspacesLabel, siblingLabel]) {
      const style = getComputedStyle(label);
      expect(style.flexDirection).toBe('row');
      expect(style.fontSize).toBe('12px');
      expect(style.letterSpacing).toBe('0');
      expect(style.textTransform).toBe('none');
    }
    expect(getComputedStyle(locationLabel).flexDirection).toBe('column');
    expect(getComputedStyle(locationLabel).textTransform).toBe('uppercase');
  });

  it('saves Sibling from repository settings and creates the next worktree beside the repository', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    addRepository(repoPath, 'Harbor');
    git(repoPath, ['branch', 'notes']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const parentBefore = readdirSync(root).sort();
    const repoBefore = readdirSync(repoPath).sort();
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    layoutChoice(dialog, 'Sibling').click();
    fixture.detectChanges();

    const configPath = join(repoPath, '.git-worktree-manager', 'config.toml');
    expect(readFileSync(configPath, 'utf8')).toContain('mode = "sibling"');
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Sibling, set by this repository',
    );
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(false);
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(true);
    expect(readdirSync(root).sort()).toEqual(parentBefore);
    expect(readdirSync(repoPath).sort()).toEqual([...repoBefore, '.git-worktree-manager'].sort());
    expect(existsSync(join(repoPath, '.workspaces'))).toBe(false);
    expect(existsSync(join(root, 'notes'))).toBe(false);

    dialog.querySelector('[data-testid="close-repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const createDialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    expect(createDialog.querySelector('[data-testid="create-layout"]').textContent.trim()).toBe(
      'Sibling, set by this repository',
    );

    const field = createDialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    createDialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    const checkout = join(root, 'notes');
    await untilVisible(fixture, () => existsSync(checkout));

    expect(git(checkout, ['branch', '--show-current'])).toBe('notes');
    expect(existsSync(join(repoPath, '.workspaces', 'notes'))).toBe(false);
  });

  it('shows an unsupported worktree mode with neither choice selected and replaces it with Workspaces', async () => {
    const repoPath = createEmptyRepository(roots);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      ['[layout]', 'workspaces_dir = ".workspaces"', 'mode = "custom"', '', '[copy]', 'files = [".env"]', ''].join('\n'),
    );
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'custom, set by this repository',
    );
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(false);
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(false);

    layoutChoice(dialog, 'Workspaces').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Workspaces, set by this repository',
    );
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(true);
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(false);
    expect(TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'))).toEqual({
      layout: { workspaces_dir: '.workspaces', mode: 'workspaces' },
      copy: { files: ['.env'] },
    });
  });

  it('leaves the app default in place when the repository has no path on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-app-settings-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Workspaces, the app default',
    );
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(true);

    layoutChoice(dialog, 'Sibling').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="worktree-mode-source"]').textContent.trim()).toBe(
      'Workspaces, the app default',
    );
    expect(layoutChoice(dialog, 'Workspaces').checked).toBe(true);
    expect(layoutChoice(dialog, 'Sibling').checked).toBe(false);
    expect(existsSync(join(root, '.git-worktree-manager', 'config.toml'))).toBe(false);
  });

  it('lists each git remote once with its name and fetch URL', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'upstream', 'https://example.com/upstream.git']);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    git(repoPath, ['remote', 'set-url', '--push', 'origin', 'https://example.com/harbor-push.git']);

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const heading = dialog.querySelector('[data-testid="remotes-heading"]');
    const list = dialog.querySelector('[data-testid="remote-list"]');
    expect(heading.textContent.trim()).toBe('Remotes');
    expect(getComputedStyle(heading).textTransform).toBe('uppercase');
    expect(list.getAttribute('aria-labelledby')).toBe('remotes-heading');
    expect(heading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const rows = [...dialog.querySelectorAll('[data-testid="remote-row"]')];
    expect(rows.map((row) => row.querySelector('[data-testid="remote-name"]')?.textContent?.trim())).toEqual([
      'origin',
      'upstream',
    ]);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual([
      'https://example.com/harbor.git',
      'https://example.com/upstream.git',
    ]);
    const originUrl = rows[0].querySelector('[data-testid="remote-url"]');
    expect(originUrl.tagName).toBe('INPUT');
    expect(originUrl.readOnly).toBe(true);
    expect(rows[0].querySelector('[data-testid="remote-name"]').tagName).toBe('SPAN');
    const edit = rows[0].querySelector('[data-testid="change-remote"]');
    expect(edit.getAttribute('aria-label')).toBe('Edit remote');
    expect(edit.querySelector('svg')).not.toBeNull();
    expect(edit.textContent.trim()).toBe('');
    expect(rows[0].querySelector('[data-testid="remove-remote"]')).toBeNull();
    expect(getComputedStyle(edit).opacity).toBe('0');
    const css = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    const editSlidesIn = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((match) => {
      const selector = match[1] ?? '';
      const body = match[2] ?? '';
      return (
        selector.includes("[data-testid='remote-row']") &&
        selector.includes(':hover') &&
        selector.includes("[data-testid='change-remote']") &&
        /opacity\s*:\s*1/.test(body) &&
        /translateX\(\s*0\s*\)/.test(body)
      );
    });
    expect(editSlidesIn).toBe(true);
  });

  it('opens add remote from a plus on the Remotes header', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const settings = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const heading = settings.querySelector('[data-testid="remotes-heading"]');
    const plus = settings.querySelector('[data-testid="open-add-remote"]');
    const list = settings.querySelector('[data-testid="remote-list"]');
    const headerRow = plus.parentElement;
    const actions = settings.querySelector('.dialog-actions');

    expect(plus.textContent.trim()).toBe('+');
    expect(plus.getAttribute('aria-label')).toBe('Add remote');
    expect(heading.contains(plus)).toBe(false);
    expect(actions.contains(plus)).toBe(false);
    expect(heading.textContent.trim()).toBe('Remotes');
    expect(heading.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(headerRow.contains(heading)).toBe(true);
    expect(headerRow.contains(list)).toBe(false);
    expect(headerRow.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const style = getComputedStyle(plus);
    expect(style.width).toBe('28px');
    expect(style.height).toBe('28px');
    expect(style.display === 'flex' || style.display === 'inline-flex').toBe(true);
    expect(style.alignItems).toBe('center');
    expect(style.justifyContent).toBe('center');

    plus.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).not.toBeNull();
    expect(actions.querySelector('[data-testid="open-add-remote"]')).toBeNull();
    expect(actions.textContent.includes('Add remote')).toBe(false);
    expect(actions.textContent).toContain('Close');
  });

  it('adds a git remote from its own dialog', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const settings = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(settings.querySelector('[data-testid="add-remote-name"]')).toBeNull();
    const settingsInputs = [...settings.querySelectorAll('input')];
    expect(settingsInputs.map((input) => input.getAttribute('data-testid'))).toEqual([
      'repository-display-name',
      'worktree-mode-workspaces',
      'worktree-mode-sibling',
      'repository-sidebar-color',
      'repository-sidebar-text-white',
      'repository-sidebar-text-black',
      'remote-url',
    ]);
    const remoteUrl = settingsInputs.find((input) => input.getAttribute('data-testid') === 'remote-url');
    expect(remoteUrl.readOnly).toBe(true);
    settings.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Add remote');
    expect(settings.contains(dialog)).toBe(false);
    const confirmAdd = dialog.querySelector('[data-testid="confirm-add-remote"]');
    expect(getComputedStyle(confirmAdd).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(confirmAdd).color).toBe('rgb(255, 255, 255)');
    expect(confirmAdd.textContent.trim()).toBe('Add remote');
    dialog.querySelector('h2').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).not.toBeNull();

    const nameField = dialog.querySelector('[data-testid="add-remote-name"]');
    const urlField = dialog.querySelector('[data-testid="add-remote-url"]');
    nameField.value = 'upstream';
    nameField.dispatchEvent(new Event('input'));
    urlField.value = 'https://example.com/upstream.git';
    urlField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-remote"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).toBeNull();
    const rows = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="repository-settings-dialog"] [data-testid="remote-row"]',
      ),
    ];
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['origin', 'upstream']);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual([
      'https://example.com/harbor.git',
      'https://example.com/upstream.git',
    ]);
    expect(git(repoPath, ['remote', 'get-url', 'upstream'])).toBe('https://example.com/upstream.git');
  });

  it('changes a remote from a dialog filled with its name and URL', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    git(repoPath, ['remote', 'set-url', '--push', 'origin', 'https://example.com/harbor-push.git']);
    git(repoPath, ['remote', 'add', 'upstream', 'https://example.com/upstream.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const settings = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const origin = settings.querySelector('[data-testid="remote-row"][data-name="origin"]');
    const shownUrl = origin.querySelector('[data-testid="remote-url"]');
    expect(shownUrl.readOnly).toBe(true);
    expect(shownUrl.value).toBe('https://example.com/harbor.git');
    origin.querySelector('[data-testid="change-remote"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Edit remote');
    expect(dialog.querySelector('[data-testid="remove-remote"]').textContent.trim()).toBe('Remove');
    expect(settings.contains(dialog)).toBe(false);
    const confirmChange = dialog.querySelector('[data-testid="confirm-change-remote"]');
    expect(getComputedStyle(confirmChange).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(confirmChange).color).toBe('rgb(255, 255, 255)');
    expect(confirmChange.textContent.trim()).toBe('Change remote');
    const nameField = dialog.querySelector('[data-testid="change-remote-name"]');
    const urlField = dialog.querySelector('[data-testid="change-remote-url"]');
    expect(nameField.value).toBe('origin');
    expect(urlField.value).toBe('https://example.com/harbor.git');
    nameField.value = 'harbor';
    nameField.dispatchEvent(new Event('input'));
    urlField.value = 'https://example.com/harbor-next.git';
    urlField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-change-remote"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).toBeNull();
    const rows = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="repository-settings-dialog"] [data-testid="remote-row"]',
      ),
    ];
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['harbor', 'upstream']);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual([
      'https://example.com/harbor-next.git',
      'https://example.com/upstream.git',
    ]);
    expect(git(repoPath, ['remote', 'get-url', 'harbor'])).toBe('https://example.com/harbor-next.git');
    expect(git(repoPath, ['remote', 'get-url', '--push', 'harbor'])).toBe('https://example.com/harbor-push.git');
    expect(git(repoPath, ['remote'])).toBe('harbor\nupstream');
  });

  it('removes a git remote', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    git(repoPath, ['remote', 'add', 'upstream', 'https://example.com/upstream.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    const upstream = dialog.querySelector('[data-testid="remote-row"][data-name="upstream"]');
    expect(upstream.querySelector('[data-testid="remove-remote"]')).toBeNull();
    upstream.querySelector('[data-testid="change-remote"]').click();
    fixture.detectChanges();

    const edit = fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]');
    edit.querySelector('[data-testid="remove-remote"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).toBeNull();
    const rows = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="repository-settings-dialog"] [data-testid="remote-row"]',
      ),
    ];
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['origin']);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual(['https://example.com/harbor.git']);
    expect(git(repoPath, ['remote'])).toBe('origin');
  });

  it('shows an error and leaves existing remotes unchanged when a remote name is rejected', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]');
    const nameField = dialog.querySelector('[data-testid="add-remote-name"]');
    const urlField = dialog.querySelector('[data-testid="add-remote-url"]');
    nameField.value = 'bad name';
    nameField.dispatchEvent(new Event('input'));
    urlField.value = 'https://example.com/other.git';
    urlField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-remote"]').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="remote-form-error"]').textContent).toBe(
      "fatal: 'bad name' is not a valid remote name",
    );
    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).not.toBeNull();
    const rows = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="repository-settings-dialog"] [data-testid="remote-row"]',
      ),
    ];
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['origin']);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual(['https://example.com/harbor.git']);
    expect(git(repoPath, ['remote', 'get-url', 'origin'])).toBe('https://example.com/harbor.git');
  });

  it('shows an error and leaves the remote unchanged when a change is rejected', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="remote-row"][data-name="origin"] [data-testid="change-remote"]')
      .click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]');
    const nameField = dialog.querySelector('[data-testid="change-remote-name"]');
    const urlField = dialog.querySelector('[data-testid="change-remote-url"]');
    nameField.value = 'harbor';
    nameField.dispatchEvent(new Event('input'));
    urlField.value = '--bad';
    urlField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-change-remote"]').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="remote-form-error"]').textContent.length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).not.toBeNull();
    const rows = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="repository-settings-dialog"] [data-testid="remote-row"]',
      ),
    ];
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['origin']);
    expect(rows.map((row) => remoteUrlValue(row))).toEqual(['https://example.com/harbor.git']);
    expect(git(repoPath, ['remote'])).toBe('origin');
    expect(git(repoPath, ['remote', 'get-url', 'origin'])).toBe('https://example.com/harbor.git');
  });

  it('leaves remotes unchanged when the add or change dialog is cancelled', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();

    const addDialog = fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]');
    const nameField = addDialog.querySelector('[data-testid="add-remote-name"]');
    const urlField = addDialog.querySelector('[data-testid="add-remote-url"]');
    nameField.value = 'upstream';
    nameField.dispatchEvent(new Event('input'));
    urlField.value = 'https://example.com/upstream.git';
    urlField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    addDialog.querySelector('[data-testid="cancel-add-remote"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).not.toBeNull();
    expect(git(repoPath, ['remote'])).toBe('origin');

    fixture.nativeElement
      .querySelector('[data-testid="remote-row"][data-name="origin"] [data-testid="change-remote"]')
      .click();
    fixture.detectChanges();
    const changeDialog = fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]');
    const changeUrl = changeDialog.querySelector('[data-testid="change-remote-url"]');
    changeUrl.value = 'https://example.com/other.git';
    changeUrl.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    changeDialog.querySelector('[data-testid="cancel-change-remote"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).toBeNull();
    expect(git(repoPath, ['remote', 'get-url', 'origin'])).toBe('https://example.com/harbor.git');
  });

  it('closes the add dialog, the change dialog, and repository settings from Escape or a click outside', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['remote', 'add', 'origin', 'https://example.com/harbor.git']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).not.toBeNull();
    expect(git(repoPath, ['remote'])).toBe('origin');

    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).not.toBeNull();

    fixture.nativeElement
      .querySelector('[data-testid="remote-row"][data-name="origin"] [data-testid="change-remote"]')
      .click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).not.toBeNull();

    fixture.nativeElement
      .querySelector('[data-testid="remote-row"][data-name="origin"] [data-testid="change-remote"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="change-remote-dialog"]')).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]')).toBeNull();
    expect(git(repoPath, ['remote', 'get-url', 'origin'])).toBe('https://example.com/harbor.git');
  });

  it('insets the sidebar and the content sheet so the forest background shows around them', async () => {
    const fixture = await render();
    expect(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement).backgroundColor).toBe('rgb(26, 60, 43)');

    const sidebar = getComputedStyle(fixture.nativeElement.querySelector('aside'));
    expect(sidebar.position).toBe('fixed');
    expect(sidebar.top).toBe('52px');
    expect(sidebar.bottom).toBe('8px');
    expect(sidebar.left).toBe('8px');
    expect(sidebar.width).toBe('320px');

    const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    const style = getComputedStyle(sheet);
    expect(style.position).toBe('fixed');
    expect(style.top).toBe('52px');
    expect(style.right).toBe('8px');
    expect(style.bottom).toBe('8px');
    expect(style.left).toBe('336px');
  });

  it('rounds the window, sidebar, content sheet, and dialogs', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    expect(getComputedStyle(fixture.nativeElement).borderRadius).toBe('8px');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).borderRadius).toBe('8px');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).borderRadius).toBe('8px');
    expect(
      getComputedStyle(
        fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"] .dialog-panel'),
      ).borderRadius,
    ).toBe('8px');

    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const live = await renderLive();
    live.nativeElement.querySelector('[data-testid="add-repository"]').click();
    live.detectChanges();
    expect(
      getComputedStyle(live.nativeElement.querySelector('[data-testid="add-repository-dialog"] .dialog-panel')).borderRadius,
    ).toBe('8px');
  });

  it('lists the sample default branch first and keeps the other sample branches in order', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Atlas"]').click();
    fixture.detectChanges();

    expect(branchNames(fixture)).toEqual(['main', 'feature/login', 'wip']);
  });

  it('lists every Harbor branch with status, changed files, and commits ahead and behind', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')];
    expect(rows.map((row) => row.getAttribute('data-branch'))).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
      'local-and-remote',
      'local-only',
      'remote-only',
      'remote-deleted',
      'local-and-remote',
    ]);
    expect(rowText(rows, 'changed-file-count')).toEqual(['2', '0', '0', '1', '1']);
    expect(rowText(rows, 'ahead')).toEqual(['3', '0', '4', '2', '1']);
    expect(rowText(rows, 'behind')).toEqual(['1', '0', '0', '0', '0']);
    expect(fixture.nativeElement.querySelector('[data-branch="HEAD"]')).toBeNull();
  });

  it('drops branches deleted on the remote and keeps worktrees that still exist locally', async () => {
    const repoPath = createRepositoryWithDeletedRemoteBranches(roots);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'kept'), 'kept']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'tracked'), 'tracked']);
    const fixture = await renderRepository(repoPath);

    const rows = [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')];
    expect(rows.map((row) => [row.getAttribute('data-branch'), row.getAttribute('data-status')])).toEqual([
      ['master', 'local-and-remote'],
      ['kept', 'local-only'],
      ['tracked', 'remote-deleted'],
    ]);
    expect(fixture.nativeElement.querySelector('[data-branch="origin/still-remote"]')).toBeNull();
  });

  it('colors a branch row by status and shows no text badge', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const background = (branch: string) =>
      getComputedStyle(
        fixture.nativeElement.querySelector(
          `[data-testid="branch-row"][data-branch="${branch}"] [data-testid="status-color"]`,
        ),
      ).backgroundColor;

    expect(background('wip')).toBe('rgb(142, 202, 230)');
    expect(background('feature/login')).toBe('rgb(61, 220, 151)');
    expect(background('origin/release')).toBe('rgb(244, 211, 94)');
    expect(background('abandoned')).toBe('rgb(255, 92, 92)');

    for (const row of fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')) {
      expect(row.textContent).not.toMatch(/local only|local-only|remote only|remote-only|gone|remote-deleted/i);
    }
  });

  it('shows no terminal count on the sample branches', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    for (const row of fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')) {
      expect(row.querySelector('[data-testid="terminal-count"]')).toBeNull();
    }
  });

  it('places create after the branch list as the last sidebar control', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const sidebar = fixture.nativeElement.querySelector('[data-testid="workspace"] aside');
    const branchList = sidebar.querySelector('[data-testid="branch-list"]');
    const create = sidebar.querySelector('[data-testid="create-worktree"]');
    expect(create).not.toBeNull();
    expect(sidebar.querySelector('[data-testid="create-branch"]')).toBeNull();
    expect(branchList.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const controls = [...sidebar.querySelectorAll('button, a, input, select, textarea')];
    expect(controls.at(-1)).toBe(create);
  });

  it('opens a create worktree dialog instead of an inline branch field', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="create-branch"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Create worktree');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    expect(field.tagName).toBe('INPUT');
    expect(field.getAttribute('placeholder')).toBe('New branch name');
    expect(dialog.querySelector('label').textContent).toContain('New branch');
    expect(dialog.querySelector('[data-testid="existing-branches-heading"]')).toBeNull();
    expect(dialog.querySelector('h2').textContent.trim()).toBe('Create worktree');
  });

  it('notes that a remote-only branch is fetched first and when create hooks run', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const sidebar = fixture.nativeElement.querySelector('[data-testid="workspace"] aside');
    expect(sidebar.querySelector('[data-testid="create-worktree-note"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const note = dialog.querySelector('[data-testid="create-worktree-note"]');
    expect(note.textContent.trim()).toBe(
      'A new name creates a local branch from the primary checkout, with no upstream. A remote-only branch is fetched first. Pre-create hooks run before the worktree is added. Post-create hooks run after checkout.',
    );
  });

  it('omits branches deleted on the remote from create worktree and still offers a local branch', async () => {
    const repoPath = createRepositoryWithDeletedRemoteBranches(roots);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const offered = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="create-branch-option"]'),
    ].map((option) => option.getAttribute('data-branch'));
    expect(offered).toEqual(['kept', 'still-remote']);
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const heading = dialog.querySelector('[data-testid="existing-branches-heading"]');
    const options = dialog.querySelector('[data-testid="create-branch-options"]');
    expect(heading.tagName).toBe('H3');
    expect(heading.textContent.trim()).toBe('Existing branches');
    expect(options.getAttribute('aria-labelledby')).toBe('existing-branches-heading');
    expect(dialog.querySelector('label').compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(heading.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('offers remote branches that do not already have a local worktree', async () => {
    const repoPath = createEmptyRepository(roots);
    const sha = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/master', sha]);
    git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/feature', sha]);
    git(repoPath, ['branch', 'done']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/done', sha]);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'done'), 'done']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    expect(field.tagName).toBe('INPUT');
    const offered = [...dialog.querySelectorAll('[data-testid="create-branch-option"]')].map((option) =>
      option.getAttribute('data-branch'),
    );
    expect(offered).toEqual(['feature']);
  });

  it('offers a local branch with no worktree when the remote ref exists', async () => {
    const repoPath = createEmptyRepository(roots);
    const sha = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['branch', 'hold']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/master', sha]);
    git(repoPath, ['update-ref', 'refs/remotes/origin/hold', sha]);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const offered = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="create-worktree-dialog"] [data-testid="create-branch-option"]',
      ),
    ].map((option) => option.getAttribute('data-branch'));
    expect(offered).toEqual(['hold']);
  });

  it('lists free branches from every remote and omits branches that already have a worktree', async () => {
    const repoPath = createPickerRepository(roots);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const names = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="create-branch-option"]'),
    ].map((option) => option.getAttribute('data-branch'));
    expect(names).toContain('plain');
    expect(names).toContain('shipped');
    expect(names).toContain('only-upstream');
    expect(names.filter((name) => name === 'shipped')).toHaveLength(1);
    expect(names).not.toContain('taken');
    expect(names).not.toContain('master');
    expect(names).not.toContain('origin/shipped');
    expect(names).not.toContain('upstream/only-upstream');
  });

  it('creates a worktree for a branch that exists only on a non-origin remote', async () => {
    const repoPath = createPickerRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="create-branch-option"][data-branch="only-upstream"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="confirm-create-worktree"]').click();

    const checkout = join(repoPath, '.workspaces', 'only-upstream');
    await untilVisible(fixture, () => existsSync(checkout));
    expect(git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('only-upstream');
    expect(git(checkout, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('upstream/only-upstream');
  });

  it('fills the branch name when a listed remote branch is chosen', async () => {
    const repoPath = createEmptyRepository(roots);
    const sha = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/feature', sha]);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    expect(field.value).toBe('');
    dialog.querySelector('[data-testid="create-branch-option"][data-branch="feature"]').click();
    fixture.detectChanges();
    expect(field.value).toBe('feature');
  });

  it('creates the worktree when a listed remote branch is confirmed', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    const otherPath = join(repoPath, '..', 'other');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    execFileSync('git', ['clone', remotePath, otherPath], { stdio: 'ignore' });
    git(otherPath, ['config', 'user.name', 'git-worktree-manager test']);
    git(otherPath, ['config', 'user.email', 'test@git-worktree-manager.local']);
    git(otherPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(otherPath, 'feature.txt'), 'from remote\n');
    git(otherPath, ['add', 'feature.txt']);
    git(otherPath, ['commit', '-m', 'add feature']);
    git(otherPath, ['push', '-u', 'origin', 'feature']);
    git(repoPath, ['fetch', 'origin']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    dialog.querySelector('[data-testid="create-branch-option"][data-branch="feature"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="create-worktree-dialog"]') === null,
    );

    const checkout = join(repoPath, '.workspaces', 'feature');
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature');
    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master', 'feature']);
  });

  it('creates a worktree when a local branch name is typed', async () => {
    const repoPath = createEmptyRepository(roots);
    const sha = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['branch', 'notes']);
    git(repoPath, ['update-ref', 'refs/remotes/origin/feature', sha]);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    expect(
      [...dialog.querySelectorAll('[data-testid="create-branch-option"]')].map((option) =>
        option.getAttribute('data-branch'),
      ),
    ).toEqual(['notes', 'feature']);
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="create-worktree-dialog"]') === null,
    );

    const checkout = join(repoPath, '.workspaces', 'notes');
    expect(git(checkout, ['branch', '--show-current'])).toBe('notes');
    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master', 'notes']);
  });

  it('creates a local branch when the typed name is not on the remote', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    writeFileSync(join(repoPath, 'local.txt'), 'only local\n');
    git(repoPath, ['add', 'local.txt']);
    git(repoPath, ['commit', '-m', 'local only']);
    const head = git(repoPath, ['rev-parse', 'HEAD']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'test';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="create-worktree-dialog"]') === null,
    );

    const checkout = join(repoPath, '.workspaces', 'test');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('test');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(() => git(checkout, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toThrow();
    const row = fixture.nativeElement.querySelector('[data-branch="test"]');
    expect(row.getAttribute('data-status')).toBe('local-only');
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]')).toBeNull();
  });

  it('pushes a local-only branch from the branch menu and sets its upstream', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'test';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="test"]') !== null,
    );

    const row = fixture.nativeElement.querySelector('[data-branch="test"]');
    expect(row.getAttribute('data-status')).toBe('local-only');
    openWorktreeMenu(row);
    fixture.detectChanges();
    const menu = row.querySelector('[data-testid="hover-menu"]');
    expect(menu.querySelector('[data-testid="push-branch"]').textContent.trim()).toBe('Push');
    menu.querySelector('[data-testid="push-branch"]').click();
    fixture.detectChanges();

    const checkout = join(repoPath, '.workspaces', 'test');
    expect(git(checkout, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/test');
    expect(git(remotePath, ['rev-parse', '--verify', 'refs/heads/test'])).toMatch(/^[0-9a-f]{40}$/);
    const updated = fixture.nativeElement.querySelector('[data-branch="test"]');
    expect(updated.getAttribute('data-status')).toBe('local-and-remote');
    expect(updated.querySelector('[data-testid="push-branch"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]')).toBeNull();
  });

  it('reports that a local-only branch has no remote to push to', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'test';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="test"]') !== null,
    );

    const row = fixture.nativeElement.querySelector('[data-branch="test"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="push-branch"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]').textContent.trim()).toBe(
      'No remote to push to',
    );
    expect(row.getAttribute('data-status')).toBe('local-only');
    expect(git(join(repoPath, '.workspaces', 'test'), ['branch', '--show-current'])).toBe('test');
  });

  it('opens a branch menu with merge actions and no squash control', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    const closedMenu = row.querySelector('[data-testid="hover-menu"]');
    expect(closedMenu.classList.contains('is-open')).toBe(false);
    openWorktreeMenu(row);
    fixture.detectChanges();

    const menu = row.querySelector('[data-testid="hover-menu"]');
    expect(menu.querySelector('[data-testid="squash"]')).toBeNull();
    const group = menu.querySelector('fieldset');
    expect(group.querySelector('legend').textContent.trim()).toBe('Merge');
    expect(group.querySelector('[data-testid="update-from-master"]').textContent.trim()).toBe(
      'Update from master',
    );
    expect(group.querySelector('[data-testid="merge-into-master"]').textContent.trim()).toBe(
      'Merge into master',
    );
    const remove = menu.querySelector('[data-testid="remove-worktree"]');
    expect(remove.textContent.trim()).toBe('Remove worktree');
    expect(group.contains(remove)).toBe(false);
    expect(remove.parentElement).toBe(group.parentElement);
    expect(menu.querySelector('[data-testid="push-branch"]')).toBeNull();
  });

  it('offers Push only on a local-only branch', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const tracked = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(tracked);
    fixture.detectChanges();
    expect(tracked.querySelector('[data-testid="push-branch"]')).toBeNull();

    const local = fixture.nativeElement.querySelector('[data-branch="wip"]');
    openWorktreeMenu(local);
    fixture.detectChanges();
    const push = local.querySelector('[data-testid="push-branch"]');
    expect(push.textContent.trim()).toBe('Push');
    expect(local.querySelector('fieldset').contains(push)).toBe(false);
    expect(push.parentElement).toBe(local.querySelector('[data-testid="hover-menu"]'));
    expect(local.querySelector('[data-testid="remove-worktree"]')).not.toBeNull();
  });

  it('pins a worktree under the default branch and keeps that pin across a restart', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    const feature = join(repoPath, '.workspaces', 'feature');
    const zeta = join(repoPath, '.workspaces', 'zeta');
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    git(repoPath, ['worktree', 'add', zeta, 'zeta']);
    commitAt(repoPath, '2020-01-01T00:00:00Z', 'old master');
    commitAt(feature, '2020-03-01T00:00:00Z', 'feature');
    commitAt(zeta, '2020-06-01T00:00:00Z', 'zeta');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['master', 'zeta', 'feature']);
    const master = fixture.nativeElement.querySelector('[data-branch="master"]');
    openWorktreeMenu(master);
    fixture.detectChanges();
    expect(master.querySelector('[data-testid="pin-worktree"]')).toBeNull();

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    const pin = row.querySelector('[data-testid="pin-worktree"]') as HTMLButtonElement;
    expect(pin.textContent?.trim()).toBe('Pin');
    pin.click();
    fixture.detectChanges();

    expect(branchNames(fixture)).toEqual(['master', 'feature', 'zeta']);
    expect(row.querySelector('[data-testid="pin-worktree"]')?.textContent?.trim()).toBe('Unpin');
    const pinIcon = row.querySelector('[data-testid="worktree-pin"]');
    expect(pinIcon?.getAttribute('aria-label')).toBe('Pinned');
    expect(pinIcon?.getAttribute('width')).toBe('16');
    expect(getComputedStyle(pinIcon as Element).color).toBe(
      getComputedStyle(row.querySelector('.branch-name') as Element).color,
    );
    expect(pinIcon?.nextElementSibling?.classList.contains('branch-stats')).toBe(true);
    expect(master.querySelector('[data-testid="worktree-pin"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-branch="zeta"] [data-testid="worktree-pin"]'),
    ).toBeNull();

    fixture.destroy();
    const restarted = await renderRepository(repoPath);
    expect(branchNames(restarted)).toEqual(['master', 'feature', 'zeta']);
    const again = restarted.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(again);
    restarted.detectChanges();
    expect(again.querySelector('[data-testid="pin-worktree"]')?.textContent?.trim()).toBe('Unpin');
    expect(again.querySelector('[data-testid="worktree-pin"]')).not.toBeNull();
    (again.querySelector('[data-testid="pin-worktree"]') as HTMLButtonElement).click();
    restarted.detectChanges();
    expect(branchNames(restarted)).toEqual(['master', 'zeta', 'feature']);
    expect(again.querySelector('[data-testid="worktree-pin"]')).toBeNull();
  });

  it('keeps a pinned worktree under the checkout the repository was added at', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['checkout', '-b', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    const zeta = join(repoPath, '.workspaces', 'zeta');
    git(repoPath, ['worktree', 'add', zeta, 'zeta']);
    commitAt(repoPath, '2020-01-01T00:00:00Z', 'feature');
    commitAt(zeta, '2020-12-01T00:00:00Z', 'zeta');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['zeta', 'feature']);
    const primary = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(primary);
    fixture.detectChanges();
    expect(primary.querySelector('[data-testid="pin-worktree"]')).toBeNull();

    const row = fixture.nativeElement.querySelector('[data-branch="zeta"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    (row.querySelector('[data-testid="pin-worktree"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(branchNames(fixture)).toEqual(['feature', 'zeta']);
    expect(row.querySelector('[data-testid="worktree-pin"]')).not.toBeNull();
    expect(primary.querySelector('[data-testid="worktree-pin"]')).toBeNull();
  });

  it('omits remove from the primary checkout when that checkout is not the default branch', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['checkout', '-b', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'zeta'), 'zeta']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const primary = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(primary);
    fixture.detectChanges();

    const menu = primary.querySelector('[data-testid="hover-menu"]');
    expect(menu.classList.contains('is-open')).toBe(true);
    expect(menu.querySelector('[data-testid="update-from-master"]').textContent.trim()).toBe(
      'Update from master',
    );
    expect(menu.querySelector('[data-testid="merge-into-master"]').textContent.trim()).toBe(
      'Merge into master',
    );
    expect(menu.querySelector('[data-testid="remove-worktree"]')).toBeNull();

    const linked = fixture.nativeElement.querySelector('[data-branch="zeta"]');
    openWorktreeMenu(linked);
    fixture.detectChanges();
    expect(linked.querySelector('[data-testid="remove-worktree"]').textContent.trim()).toBe(
      'Remove worktree',
    );
  });

  it('removes a worktree pin when that worktree is removed', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    const feature = join(repoPath, '.workspaces', 'feature');
    const zeta = join(repoPath, '.workspaces', 'zeta');
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    git(repoPath, ['worktree', 'add', zeta, 'zeta']);
    commitAt(repoPath, '2020-01-01T00:00:00Z', 'old master');
    commitAt(feature, '2020-03-01T00:00:00Z', 'feature');
    commitAt(zeta, '2020-06-01T00:00:00Z', 'zeta');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    (row.querySelector('[data-testid="pin-worktree"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(branchNames(fixture)).toEqual(['master', 'feature', 'zeta']);

    (row.querySelector('[data-testid="remove-worktree"]') as HTMLButtonElement).click();
    await confirmKeepBranch(fixture);

    expect(readPinnedWorktrees(repoPath)).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    fixture.destroy();
    const restored = await renderRepository(repoPath);
    expect(branchNames(restored)).toEqual(['master', 'zeta', 'feature']);
    const recreated = restored.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(recreated);
    restored.detectChanges();
    expect(recreated.querySelector('[data-testid="pin-worktree"]')?.textContent?.trim()).toBe('Pin');
  });

  it('omits update, merge, and remove from the default branch menu', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="main"]');
    openWorktreeMenu(row);
    fixture.detectChanges();

    const menu = row.querySelector('[data-testid="hover-menu"]');
    expect(menu.classList.contains('is-open')).toBe(true);
    expect(menu.querySelector('[data-testid="update-from-master"]')).toBeNull();
    expect(menu.querySelector('[data-testid="merge-into-master"]')).toBeNull();
    expect(menu.querySelector('[data-testid="remove-worktree"]')).toBeNull();
  });

  it('keeps update, merge, and remove on a worktree that is not the default branch', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();

    const menu = row.querySelector('[data-testid="hover-menu"]');
    expect(menu.querySelector('[data-testid="update-from-master"]').textContent.trim()).toBe(
      'Update from master',
    );
    expect(menu.querySelector('[data-testid="merge-into-master"]').textContent.trim()).toBe(
      'Merge into master',
    );
    expect(menu.querySelector('[data-testid="remove-worktree"]').textContent.trim()).toBe('Remove worktree');
  });

  it('does nothing when the default branch menu would be empty', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const feature = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(feature);
    fixture.detectChanges();
    expect(feature.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    const row = fixture.nativeElement.querySelector('[data-branch="master"]');
    expect(row.getAttribute('data-status')).toBe('local-and-remote');
    const opened = openWorktreeMenu(row.querySelector('.branch-name') as Element);
    fixture.detectChanges();

    expect(opened.defaultPrevented).toBe(true);
    expect(row.classList.contains('is-selected')).toBe(false);
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('none');
    expect(feature.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(row.querySelector('[data-testid="push-branch"]')).toBeNull();
    expect(row.querySelector('[data-testid="pin-worktree"]')).toBeNull();
    expect(row.querySelector('[data-testid="update-from-master"]')).toBeNull();
    expect(row.querySelector('[data-testid="merge-into-master"]')).toBeNull();
    expect(row.querySelector('[data-testid="remove-worktree"]')).toBeNull();
  });

  it('keeps Push on the default branch menu when that branch is local only', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="master"]');
    expect(row.getAttribute('data-status')).toBe('local-only');
    openWorktreeMenu(row);
    fixture.detectChanges();

    const menu = row.querySelector('[data-testid="hover-menu"]');
    expect(menu.querySelector('[data-testid="push-branch"]').textContent.trim()).toBe('Push');
    expect(menu.querySelector('[data-testid="update-from-master"]')).toBeNull();
    expect(menu.querySelector('[data-testid="merge-into-master"]')).toBeNull();
    expect(menu.querySelector('[data-testid="remove-worktree"]')).toBeNull();
  });

  it('keeps branch actions closed while the pointer is only hovering the row', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const css = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    const hoverOpensActions = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((match) => {
      const selector = match[1] ?? '';
      const body = match[2] ?? '';
      return (
        selector.includes('.branch-row') &&
        selector.includes(':hover') &&
        selector.includes('.branch-actions') &&
        /display\s*:\s*block/.test(body)
      );
    });
    expect(hoverOpensActions).toBe(false);

    const menu = fixture.nativeElement.querySelector(
      '[data-branch="feature/login"] [data-testid="hover-menu"]',
    );
    expect(menu.classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(menu).display).toBe('none');
  });

  it('keeps the branch menu within its own bounds when a row is hovered', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();

    const menu = row.querySelector('[data-testid="hover-menu"]');
    const update = menu.querySelector('[data-testid="update-from-master"]');
    update.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    fixture.detectChanges();

    expect(menu.querySelector('[data-testid="squash"]')).toBeNull();
    expect(update.textContent.trim()).toBe('Update from master');
    expect(getComputedStyle(menu).overflow).toBe('hidden');
  });

  it('opens one branch action menu and closes the other', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const login = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    const wip = fixture.nativeElement.querySelector('[data-branch="wip"]');
    expect(fixture.nativeElement.querySelector('[data-testid="branch-menu"]')).toBeNull();
    const opened = openWorktreeMenu(login.querySelector('.branch-name') as Element);
    fixture.detectChanges();
    expect(opened.defaultPrevented).toBe(true);
    expect(login.classList.contains('is-selected')).toBe(false);

    const loginMenu = login.querySelector('[data-testid="hover-menu"]');
    expect(loginMenu.classList.contains('is-open')).toBe(true);
    expect(getComputedStyle(loginMenu).display).toBe('block');
    expect(loginMenu.querySelector('[data-testid="update-from-master"]').textContent.trim()).toBe(
      'Update from master',
    );
    expect(loginMenu.querySelector('[data-testid="merge-into-master"]').textContent.trim()).toBe(
      'Merge into master',
    );
    expect(loginMenu.querySelector('[data-testid="remove-worktree"]').textContent.trim()).toBe(
      'Remove worktree',
    );

    openWorktreeMenu(wip);
    fixture.detectChanges();

    const wipMenu = wip.querySelector('[data-testid="hover-menu"]');
    expect(loginMenu.classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(loginMenu).display).toBe('none');
    expect(wipMenu.classList.contains('is-open')).toBe(true);
    expect(getComputedStyle(wipMenu).display).toBe('block');
  });

  it('closes the branch menu when that worktree is right-clicked again', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    const onMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 48 });
    row.querySelector('[data-testid="hover-menu"]').dispatchEvent(onMenu);
    fixture.detectChanges();
    expect(onMenu.defaultPrevented).toBe(true);
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    openWorktreeMenu(row);
    fixture.detectChanges();

    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('none');
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the branch menu when the workspace outside the menu is clicked', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    row.querySelector('[data-testid="hover-menu"] legend').click();
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    fixture.nativeElement.querySelector('[data-testid="content-sheet"]').click();
    fixture.detectChanges();

    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('none');

    openWorktreeMenu(row);
    fixture.detectChanges();
    const outside = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 200 });
    fixture.nativeElement.querySelector('[data-testid="content-sheet"]').dispatchEvent(outside);
    fixture.detectChanges();
    expect(outside.defaultPrevented).toBe(true);
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('none');
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the branch menu when Escape is pressed', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('none');
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the repository switcher on Escape and leaves the open branch menu open', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(true);
    expect(getComputedStyle(row.querySelector('[data-testid="hover-menu"]')).display).toBe('block');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-name"]')).toBeNull();
    expect(branchNames(fixture)).toEqual([
      'feature/login',
      'wip',
      'origin/release',
      'abandoned',
      'rename-docs',
    ]);
  });

  it('closes the branch menu without updating, merging, or removing the worktree', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(checkout, 'feature.txt'), 'from feature\n');
    git(checkout, ['add', 'feature.txt']);
    git(checkout, ['commit', '-m', 'feature change']);
    writeFileSync(join(repoPath, 'master.txt'), 'from master\n');
    git(repoPath, ['add', 'master.txt']);
    git(repoPath, ['commit', '-m', 'master change']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.click();
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('1');
    expect(row.querySelector('[data-testid="behind"]').textContent.trim()).toBe('1');

    openWorktreeMenu(row);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="content-sheet"]').click();
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);

    openWorktreeMenu(row);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);

    openWorktreeMenu(row);
    fixture.detectChanges();
    openWorktreeMenu(row);
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="hover-menu"]').classList.contains('is-open')).toBe(false);

    expect(readFileSync(join(checkout, 'feature.txt'), 'utf8')).toBe('from feature\n');
    expect(readFileSync(join(repoPath, 'master.txt'), 'utf8')).toBe('from master\n');
    expect(existsSync(join(checkout, 'master.txt'))).toBe(false);
    expect(existsSync(join(repoPath, 'feature.txt'))).toBe(false);
    expect(git(repoPath, ['log', '--format=%s'])).toBe('master change\ninit');
    expect(git(checkout, ['log', '--format=%s'])).toBe('feature change\ninit');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature');
    expect(row.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('1');
    expect(row.querySelector('[data-testid="behind"]').textContent.trim()).toBe('1');
    expect(branchNames(fixture)).toEqual(['master', 'feature']);
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]')).toBeNull();
  });

  it('counts the Harbor commits that are not on the default branch', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const summary = fixture.nativeElement.querySelector('.branch-heading p');
    expect(summary.textContent.trim()).toBe('2 commits · 2 changed files');

    const commits = [...fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]')];
    expect(commits.map((commit) => commit.getAttribute('data-subject'))).toEqual([
      'Add the login form',
      'Wire the session',
    ]);
  });

  it('shows the changed files and the commits only on feature/login', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const files = [...fixture.nativeElement.querySelectorAll('[data-testid="changed-files"] [data-testid="changed-file"]')];
    expect(files.map((file) => file.getAttribute('data-path'))).toEqual(['src/login.ts', 'README.md']);
    expect(files[0].querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('12');
    expect(files[0].querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('3');
    expect(files[1].querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('4');
    expect(files[1].querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('1');

    const commits = [...fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]')];
    expect(commits.map((commit) => commit.getAttribute('data-subject'))).toEqual([
      'Add the login form',
      'Wire the session',
    ]);
  });

  it('places changes above commits and the selected file diff to their right', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="commit-files"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]')).toBeNull();
    const changes = fixture.nativeElement.querySelector('[data-testid="changes"]');
    const commits = fixture.nativeElement.querySelector('[data-testid="commits"]');
    expect(blockTop(commits)).toBeGreaterThanOrEqual(blockBottom(changes));

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();

    const commitFiles = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    expect(commitFiles.closest('[data-testid="commits"]')).toBeNull();
    expect(commitFiles.closest('[data-testid="changes"]')).toBeNull();
    expect(commits.compareDocumentPosition(commitFiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commitFiles.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the working tree diff when src/login.ts is chosen', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const loginFile = fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]');
    loginFile.click();
    fixture.detectChanges();

    expect(loginFile.classList.contains('is-selected')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain(
      'export function login',
    );
  });

  it('shows src/login.ts as an added line with a new number and no patch header', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    const line = diff.querySelector('[data-testid="diff-line"]');
    expect(line.getAttribute('data-kind')).toBe('added');
    expect(line.querySelector('[data-testid="diff-old-number"]').textContent.trim()).toBe('');
    expect(line.querySelector('[data-testid="diff-new-number"]').textContent.trim()).toBe('1');
    expect(line.textContent).toContain('export function login');
    expect(diff.textContent).not.toContain('diff --git');
    expect(diff.textContent).not.toContain('@@');
  });

  it('colors a one-word change in Changes and numbers the context on both sides', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'alpha\nhello world\nomega\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add the greeting']);
    writeFileSync(join(feature, 'notes.txt'), 'alpha\nhello there\nomega\n');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.textContent).not.toContain('diff --git');
    expect(diff.textContent).not.toContain('@@');
    const lines = [...diff.querySelectorAll('[data-testid="diff-line"]')];
    const context = lines.find((line) => line.textContent?.includes('alpha'));
    const removed = lines.find((line) => line.getAttribute('data-kind') === 'removed');
    const added = lines.find((line) => line.getAttribute('data-kind') === 'added');
    expect(context?.getAttribute('data-kind')).toBe('context');
    expect(context?.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('1');
    expect(context?.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('1');
    expect(getComputedStyle(context as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(removed?.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('2');
    expect(removed?.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('');
    expect(added?.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('');
    expect(added?.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('2');
    const removedWord = removed?.querySelector('[data-changed="true"]') as HTMLElement;
    const addedWord = added?.querySelector('[data-changed="true"]') as HTMLElement;
    expect(removedWord.textContent).toBe('world');
    expect(addedWord.textContent).toBe('there');
    expect(getComputedStyle(removed as HTMLElement).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(getComputedStyle(added as HTMLElement).backgroundColor).toBe('rgb(215, 255, 230)');
    expect(getComputedStyle(removedWord).backgroundColor).not.toBe(getComputedStyle(removed as HTMLElement).backgroundColor);
    expect(getComputedStyle(addedWord).backgroundColor).not.toBe(getComputedStyle(added as HTMLElement).backgroundColor);
  });

  it('shows old and new numbers for a commit file and leaves out the patch header', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'alpha\nbeta\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'alpha\nbeta!\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Edit notes']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Edit notes"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.textContent).not.toContain('diff --git');
    expect(diff.textContent).not.toContain('@@');
    const context = [...diff.querySelectorAll('[data-testid="diff-line"]')].find((line) =>
      line.textContent?.includes('alpha'),
    );
    expect(context?.getAttribute('data-kind')).toBe('context');
    expect(context?.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('1');
    expect(context?.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('1');
    const removed = [...diff.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'removed',
    );
    expect(removed?.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('2');
    expect(removed?.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('');
    expect(getComputedStyle(removed as HTMLElement).backgroundColor).toBe('rgb(255, 217, 207)');
  });

  it('keeps three lines of context around a change and colors a whitespace-only edit', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'wide.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n');
    writeFileSync(join(feature, 'space.txt'), 'alpha\nhello world\nomega\n');
    git(feature, ['add', 'wide.txt', 'space.txt']);
    git(feature, ['commit', '-m', 'Add the lines']);
    writeFileSync(join(feature, 'wide.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\n');
    writeFileSync(join(feature, 'space.txt'), 'alpha\nhello  world\nomega\n');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="wide.txt"]').click();
    fixture.detectChanges();
    const wide = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(wide.textContent).toContain('two');
    expect(wide.textContent).toContain('three');
    expect(wide.textContent).toContain('four');
    expect(wide.textContent).toContain('FIVE');
    expect(wide.textContent).toContain('six');
    expect(wide.textContent).toContain('seven');
    expect(wide.textContent).toContain('eight');
    expect(wide.textContent).not.toContain('one');
    expect(wide.textContent).not.toContain('nine');

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="space.txt"]').click();
    fixture.detectChanges();
    const space = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const removed = [...space.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'removed',
    ) as HTMLElement;
    const added = [...space.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'added',
    ) as HTMLElement;
    const removedSpace = removed.querySelector('[data-changed="true"]') as HTMLElement;
    const addedSpace = added.querySelector('[data-changed="true"]') as HTMLElement;
    expect(removedSpace.textContent).toBe(' ');
    expect(addedSpace.textContent).toBe('  ');
    expect(getComputedStyle(removed).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(getComputedStyle(added).backgroundColor).toBe('rgb(215, 255, 230)');
    expect(getComputedStyle(removedSpace).backgroundColor).not.toBe(getComputedStyle(removed).backgroundColor);
    expect(getComputedStyle(addedSpace).backgroundColor).not.toBe(getComputedStyle(added).backgroundColor);
  });

  it('keeps three lines of context around a middle change when diff.context is 0', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['config', 'diff.context', '0']);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const original = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n';
    const edited = 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\n';
    writeFileSync(join(feature, 'wide.txt'), original);
    writeFileSync(join(feature, 'open.txt'), original);
    git(feature, ['add', 'wide.txt', 'open.txt']);
    git(feature, ['commit', '-m', 'Add the lines']);
    writeFileSync(join(feature, 'wide.txt'), edited);
    git(feature, ['add', 'wide.txt']);
    git(feature, ['commit', '-m', 'Edit the lines']);
    writeFileSync(join(feature, 'open.txt'), edited);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    const expectThreeLines = (diff: HTMLElement): void => {
      expect(diff.textContent).toContain('two');
      expect(diff.textContent).toContain('three');
      expect(diff.textContent).toContain('four');
      expect(diff.textContent).toContain('FIVE');
      expect(diff.textContent).toContain('six');
      expect(diff.textContent).toContain('seven');
      expect(diff.textContent).toContain('eight');
      expect(diff.textContent).not.toContain('one');
      expect(diff.textContent).not.toContain('nine');
    };

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="open.txt"]').click();
    fixture.detectChanges();
    expectThreeLines(fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement);

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Edit the lines"]').click();
    fixture.detectChanges();
    expectThreeLines(fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement);
  });

  it('keeps the line numbers in place and does not wrap the diff', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const line = diff.querySelector('[data-testid="diff-line"]') as HTMLElement;
    expect(getComputedStyle(diff).whiteSpace).toBe('pre');
    expect(getComputedStyle(line).whiteSpace).toBe('pre');
    expect(getComputedStyle(line).lineHeight).toBe('20px');
    expect(getComputedStyle(line).height).toBe('20px');
    expect(getComputedStyle(line.querySelector('[data-testid="diff-old-number"]')).position).toBe('sticky');
    expect(getComputedStyle(line.querySelector('[data-testid="diff-new-number"]')).position).toBe('sticky');
  });

  it('leaves lines outside the diff view undrawn', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const body = Array.from({ length: 40 }, (_, index) => `row-${String(index).padStart(2, '0')}`).join('\n');
    writeFileSync(join(feature, 'long.txt'), `${body}\n`);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="long.txt"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const line = diff.querySelector('[data-testid="diff-line"]') as HTMLElement;
    const rowHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
    expect(diff.textContent).toContain('row-00');
    expect(diff.textContent).toContain('row-39');
    installScrollMetrics(diff, {
      clientHeight: rowHeight * 2,
      scrollHeight: rowHeight * 40,
      scrollTop: rowHeight * 30,
    });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(diff.textContent).not.toContain('row-00');
    expect(diff.textContent).not.toContain('row-39');
    expect(diff.textContent).toContain('row-30');
    expect(diff.classList.contains('overlay-scroll')).toBe(true);
  });

  it('shows Renamed from the old path above the commit diff', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Retitle the guide"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from docs/old-guide.md');
    expect(diff.textContent).toContain('new guide');
    expect(fixture.nativeElement.querySelector('[data-testid="empty-diff"]')).toBeNull();
  });

  it('shows the removed and added lines of a rename that also edits a line', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Retitle the guide"]').click();
    fixture.detectChanges();

    const commitDiff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(commitDiff.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from docs/old-guide.md');
    const commitRemoved = [...commitDiff.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'removed',
    ) as HTMLElement | undefined;
    const commitAdded = [...commitDiff.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'added',
    ) as HTMLElement | undefined;
    expect(commitRemoved?.textContent).toContain('old guide');
    expect(getComputedStyle(commitRemoved as HTMLElement).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(commitAdded?.textContent).toContain('new guide');
    expect(getComputedStyle(commitAdded as HTMLElement).backgroundColor).toBe('rgb(215, 255, 230)');

    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const paired = sideRowContaining(commitDiff, 'old guide');
    expect(paired.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('old guide');
    expect(paired.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('new guide');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-inline"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const workRepo = createEmptyRepository(roots);
    const feature = join(workRepo, '.workspaces', 'feature');
    git(workRepo, ['branch', 'feature']);
    git(workRepo, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'plain.txt'), 'leave this line\n');
    writeFileSync(join(feature, 'notes.txt'), 'harbor notes\nold guide\nkeep the rest\n');
    git(feature, ['add', 'plain.txt', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add the notes']);
    git(feature, ['mv', 'plain.txt', 'moved.txt']);
    git(feature, ['mv', 'notes.txt', 'renamed.txt']);
    writeFileSync(join(feature, 'renamed.txt'), 'harbor notes\nnew guide\nkeep the rest\n');
    const work = await renderRepository(workRepo);
    work.nativeElement.querySelector('[data-branch="feature"]').click();
    work.detectChanges();

    work.nativeElement.querySelector('[data-testid="changed-file"][data-path="moved.txt"]').click();
    work.detectChanges();
    const pure = work.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(pure.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from plain.txt');
    expect(pure.querySelector('[data-testid="diff-line"]')).toBeNull();

    work.nativeElement.querySelector('[data-testid="changed-file"][data-path="renamed.txt"]').click();
    work.detectChanges();
    const edited = work.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(edited.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from notes.txt');
    const removed = [...edited.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'removed',
    ) as HTMLElement | undefined;
    const added = [...edited.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'added',
    ) as HTMLElement | undefined;
    expect(removed?.textContent).toContain('old guide');
    expect(getComputedStyle(removed as HTMLElement).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(added?.textContent).toContain('new guide');
    expect(getComputedStyle(added as HTMLElement).backgroundColor).toBe('rgb(215, 255, 230)');

    (work.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    work.detectChanges();
    const workPaired = sideRowContaining(edited, 'old guide');
    expect(workPaired.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('old guide');
    expect(workPaired.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('new guide');
  });

  it('shows Binary file for the logo commit', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the logo"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.querySelector('[data-testid="diff-binary"]')?.textContent).toBe('Binary file');
    expect(diff.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="empty-diff"]')).toBeNull();
  });

  it('colors a new file green and a deleted file red', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'gone.txt'), 'gone line\n');
    git(feature, ['add', 'gone.txt']);
    git(feature, ['commit', '-m', 'Add gone']);
    writeFileSync(join(feature, 'fresh.txt'), 'fresh line\n');
    rmSync(join(feature, 'gone.txt'));
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="fresh.txt"]').click();
    fixture.detectChanges();
    const fresh = [...fixture.nativeElement.querySelectorAll('[data-testid="diff-line"]')] as HTMLElement[];
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((line) => line.getAttribute('data-kind') === 'added')).toBe(true);
    expect(fresh.every((line) => getComputedStyle(line).backgroundColor === 'rgb(215, 255, 230)')).toBe(true);

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="gone.txt"]').click();
    fixture.detectChanges();
    const gone = [...fixture.nativeElement.querySelectorAll('[data-testid="diff-line"]')] as HTMLElement[];
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.every((line) => line.getAttribute('data-kind') === 'removed')).toBe(true);
    expect(gone.every((line) => getComputedStyle(line).backgroundColor === 'rgb(255, 217, 207)')).toBe(true);
  });

  it('shows a staged addition in Changes', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'staged.txt'), 'staged line\n');
    git(feature, ['add', 'staged.txt']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="staged.txt"]').click();
    fixture.detectChanges();

    const line = fixture.nativeElement.querySelector('[data-testid="diff-line"]') as HTMLElement;
    expect(line.getAttribute('data-kind')).toBe('added');
    expect(line.textContent).toContain('staged line');
    expect(line.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('');
    expect(line.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('1');
  });

  it('shows Add the login form files with the diff in the column to the right', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const loginCommit = fixture.nativeElement.querySelector(
      '[data-testid="commit"][data-subject="Add the login form"]',
    );
    loginCommit.click();
    fixture.detectChanges();

    expect(loginCommit.classList.contains('is-selected')).toBe(true);
    const commitFiles = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    const file = commitFiles.querySelector('[data-testid="changed-file"]');
    expect(file.classList.contains('is-selected')).toBe(true);
    expect(file.getAttribute('data-path')).toBe('src/login.ts');
    expect(file.querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('10');
    expect(file.querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('0');

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    expect(diff.textContent).toContain('function login');
    expect(commitFiles.closest('[data-testid="commits"]')).toBeNull();
    expect(commitFiles.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists only the Harbor commits that are not on the default branch, below the changes', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    const commits = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    expect(commits.previousElementSibling?.textContent?.trim()).toBe('Commits only on this branch');
    expect(
      [...commits.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Add the login form', 'Wire the session']);

    const changes = sheetSection(fixture.nativeElement.querySelector('[data-testid="changed-files"]'));
    expect(blockTop(sheetSection(commits))).toBeGreaterThanOrEqual(blockBottom(changes));

    expect(fixture.nativeElement.querySelector('.branch-heading p').textContent.trim()).toBe(
      '2 commits · 2 changed files',
    );
  });

  it('lists the commits that are not on the default branch for feature/login', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const only = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    expect(only.previousElementSibling?.textContent?.trim()).toBe('Commits only on this branch');
    expect(
      [...only.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Add the login form', 'Wire the session']);
  });

  it('shows the Atlas main history under Commits and keeps feature/login to commits that are not on main', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Atlas"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-branch="main"]').click();
    fixture.detectChanges();

    const recent = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    expect(recent.previousElementSibling?.textContent?.trim()).toBe('Commits');
    expect(fixture.nativeElement.querySelector('[data-testid="branch-commits"]')).toBeNull();
    expect(
      [...recent.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Open the atlas', 'Chart the coast']);
    expect(blockTop(fixture.nativeElement.querySelector('[data-testid="commits"]'))).toBeGreaterThanOrEqual(
      blockBottom(fixture.nativeElement.querySelector('[data-testid="changes"]')),
    );
    const summary = fixture.nativeElement.querySelector('.branch-heading p');
    expect(summary.textContent.trim()).toBe('2 commits · 0 changed files');
    expect(summary.textContent).not.toContain('commits only on this branch');

    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    const only = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    expect(only.previousElementSibling?.textContent?.trim()).toBe('Commits only on this branch');
    expect(
      [...only.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Sketch the login']);
    expect(fixture.nativeElement.querySelector('[data-subject="Open the atlas"]')).toBeNull();
  });

  it('shows the files and diff for Wire the session', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Wire the session"]').click();
    fixture.detectChanges();

    const file = fixture.nativeElement.querySelector('[data-testid="commit-files"] [data-testid="changed-file"]');
    expect(file.getAttribute('data-path')).toBe('src/session.ts');
    expect(file.querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('8');
    expect(file.querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('2');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain(
      'export function session',
    );
  });

  it('shows the renamed docs guide as one file with the previous path', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="rename-docs"]').click();
    fixture.detectChanges();

    const files = [...fixture.nativeElement.querySelectorAll('[data-testid="changed-files"] [data-testid="changed-file"]')];
    expect(files).toHaveLength(1);
    expect(files[0].getAttribute('data-path')).toBe('docs/guide.md');
    expect(files[0].getAttribute('data-previous-path')).toBe('docs/old-guide.md');
    expect(files[0].querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('4');
    expect(files[0].querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('1');
  });

  it('shows the abandoned binary logo with no line counts', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="abandoned"]').click();
    fixture.detectChanges();

    const files = [...fixture.nativeElement.querySelectorAll('[data-testid="changed-files"] [data-testid="changed-file"]')];
    expect(files).toHaveLength(1);
    expect(files[0].getAttribute('data-path')).toBe('assets/logo.png');
    expect(files[0].querySelector('[data-testid="lines-added"]')).toBeNull();
    expect(files[0].querySelector('[data-testid="lines-deleted"]')).toBeNull();
  });

  it('opens the repository path on rewrite without the sample card', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-card"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-name')).toBe(
      'harbor',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(
      repoPath,
    );

    const rewrite = fixture.nativeElement.querySelector(
      '[data-testid="branch-row"][data-branch="rewrite"]',
    );
    expect(rewrite.getAttribute('data-status')).toBe('local-only');
    rewrite.click();
    fixture.detectChanges();
    expect(rewrite.querySelector('[data-testid="changed-file-count"]').textContent.trim()).toBe('1');
    expect(rewrite.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('2');
    expect(rewrite.querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    expect(rewrite.querySelector('[data-testid="terminal-count"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="branch-row"][data-branch="master"]'),
    ).not.toBeNull();
  });

  it('shows the files and diff for the old guide commit on the default branch', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('[data-testid="recent-commits"] [data-testid="commit"][data-subject="Add the old guide"]')
      .click();
    fixture.detectChanges();

    const commitFiles = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    const file = commitFiles.querySelector('[data-testid="changed-file"][data-path="docs/old-guide.md"]');
    expect(file.getAttribute('data-path')).toBe('docs/old-guide.md');
    file.click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    expect(diff.textContent).toContain('old guide');
    expect(commitFiles.closest('[data-testid="commits"]')).toBeNull();
    expect(commitFiles.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('loads the next page of recent commits when the list is scrolled to the end', async () => {
    const repoPath = createLongHistoryRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    scrollCommitList(list, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    expect(commitSubjects(list)).not.toContain('init');

    scrollCommitList(list, { scrollTop: 300, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    const subjects = commitSubjects(list);
    expect(subjects[0]).toBe('Record 30');
    expect(subjects.at(-1)).toBe('init');
    expect(subjects.filter((subject) => subject === 'init')).toEqual(['init']);

    scrollCommitList(list, { scrollTop: 300, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    expect(commitSubjects(list).filter((subject) => subject === 'init')).toEqual(['init']);
  });

  it('shows the first page of recent commits before the list is scrolled', async () => {
    const repoPath = createLongHistoryRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const subjects = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="recent-commits"] [data-testid="commit"]',
      ),
    ].map((commit) => commit.getAttribute('data-subject'));
    expect(subjects[0]).toBe('Record 30');
    expect(subjects[29]).toBe('Record 01');
    expect(subjects).not.toContain('init');
    expect(fixture.nativeElement.querySelector('[data-testid="branch-commits"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]').previousElementSibling?.textContent?.trim()).toBe(
      'Commits',
    );
    expect(blockTop(fixture.nativeElement.querySelector('[data-testid="commits"]'))).toBeGreaterThanOrEqual(
      blockBottom(fixture.nativeElement.querySelector('[data-testid="changes"]')),
    );
    const summary = fixture.nativeElement.querySelector('.branch-heading p');
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');
    expect(summary.textContent).not.toContain('commits only on this branch');
  });

  it('shows the count of commits that are not on the default branch when only the first page is loaded', async () => {
    const repoPath = createLongFeatureRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    const subjects = commitSubjects(list);
    expect(subjects).toHaveLength(30);
    expect(subjects[0]).toBe('Feature 31');
    expect(subjects[29]).toBe('Feature 02');
    expect(subjects).not.toContain('Feature 01');
    expect(subjects).not.toContain('init');
    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.branch-heading p').textContent.trim()).toBe(
      '31 commits · 0 changed files',
    );
  });

  it('shows the changed-file count until the commit total is known', async () => {
    const repoPath = createLongHistoryRepository(roots);
    writeFileSync(join(repoPath, 'note.txt'), 'unsaved\n');
    const fixture = await renderRepository(repoPath);
    const queued: Array<() => void> = [];
    setAfterPaintScheduler((task) => {
      queued.push(task);
    });
    try {
      fixture.nativeElement.querySelector('[data-branch="master"]').click();
      queued.shift()?.();
      fixture.detectChanges();

      const summary = fixture.nativeElement.querySelector('.branch-heading p');
      expect(summary.textContent.trim()).toBe('1 changed files');
      const subjects = commitSubjects(fixture.nativeElement.querySelector('[data-testid="recent-commits"]'));
      expect(subjects).toHaveLength(30);
      expect(subjects).not.toContain('init');

      queued.shift()?.();
      fixture.detectChanges();
      expect(summary.textContent.trim()).toBe('31 commits · 1 changed files');
    } finally {
      setAfterPaintScheduler((task) => {
        task();
      });
      for (const task of queued.splice(0)) {
        task();
      }
    }
  });

  it('shows the changed-file count on another branch until the commit total is known', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n');
    git(repoPath, ['add', 'feature.txt']);
    git(repoPath, ['commit', '-m', 'Add the feature note']);
    git(repoPath, ['checkout', 'master']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    writeFileSync(join(repoPath, '.workspaces', 'feature', 'feature.txt'), 'feature\nextra\n');
    const fixture = await renderRepository(repoPath);
    const queued: Array<() => void> = [];
    setAfterPaintScheduler((task) => {
      queued.push(task);
    });
    try {
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      queued.shift()?.();
      fixture.detectChanges();

      const summary = fixture.nativeElement.querySelector('.branch-heading p');
      expect(summary.textContent.trim()).toBe('1 changed files');
      expect(
        [...fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]')].map(
          (commit) => commit.getAttribute('data-subject'),
        ),
      ).toEqual(['Add the feature note']);
      expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();

      queued.shift()?.();
      fixture.detectChanges();
      expect(summary.textContent.trim()).toBe('1 commits · 1 changed files');
    } finally {
      setAfterPaintScheduler((task) => {
        task();
      });
      for (const task of queued.splice(0)) {
        task();
      }
    }
  });

  it('keeps the commit count while further pages load', async () => {
    const repoPath = createLongHistoryRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const summary = fixture.nativeElement.querySelector('.branch-heading p');
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');

    const list = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    scrollCommitList(list, { scrollTop: 300, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();

    expect(commitSubjects(list).at(-1)).toBe('init');
    expect(commitSubjects(list).filter((subject) => subject === 'init')).toEqual(['init']);
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');
  });

  it('loads the next page of commits that are not on the default branch when the list is scrolled to the end', async () => {
    const repoPath = createLongFeatureRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    const summary = fixture.nativeElement.querySelector('.branch-heading p');
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');
    scrollCommitList(list, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    expect(commitSubjects(list)).not.toContain('Feature 01');
    expect(commitSubjects(list)).not.toContain('init');

    scrollCommitList(list, { scrollTop: 300, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    const subjects = commitSubjects(list);
    expect(subjects[0]).toBe('Feature 31');
    expect(subjects.at(-1)).toBe('Feature 01');
    expect(subjects).not.toContain('init');
    expect(subjects.filter((subject) => subject === 'Feature 01')).toEqual(['Feature 01']);
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');

    scrollCommitList(list, { scrollTop: 300, clientHeight: 100, scrollHeight: 400 });
    fixture.detectChanges();
    expect(commitSubjects(list).filter((subject) => subject === 'Feature 01')).toEqual(['Feature 01']);
    expect(summary.textContent.trim()).toBe('31 commits · 0 changed files');
  });

  it('shows zero commits when that branch has no commits that are not on the default branch', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.branch-heading p').textContent.trim()).toBe(
      '0 commits · 0 changed files',
    );
    expect(fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]')).toHaveLength(
      0,
    );
  });

  it('leaves the commit count out when the total cannot be read', async () => {
    const repoPath = createLongHistoryRepository(roots);
    writeFileSync(join(repoPath, 'note.txt'), 'unsaved\n');
    const fixture = await renderRepository(repoPath);
    const previousPath = process.env.PATH;
    process.env.PATH = `${commitCountFailureDir(roots)}:${previousPath ?? ''}`;
    try {
      fixture.nativeElement.querySelector('[data-branch="master"]').click();
      fixture.detectChanges();

      const summary = fixture.nativeElement.querySelector('.branch-heading p');
      expect(summary.textContent.trim()).toBe('1 changed files');
      const subjects = commitSubjects(fixture.nativeElement.querySelector('[data-testid="recent-commits"]'));
      expect(subjects).toHaveLength(30);
      expect(subjects[0]).toBe('Record 30');
      expect(subjects).not.toContain('init');
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('lists commits that are not on main when main is the default branch', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    writeFileSync(join(repoPath, 'docs.txt'), 'main line\n');
    git(repoPath, ['add', 'docs.txt']);
    git(repoPath, ['commit', '-m', 'Plant the main line']);
    git(repoPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'docs.txt'), 'main line\nfeature note\n');
    git(repoPath, ['add', 'docs.txt']);
    git(repoPath, ['commit', '-m', 'Add the feature note']);
    git(repoPath, ['checkout', 'main']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    const only = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="branch-commits"] [data-testid="commit"]',
      ),
    ].map((commit) => commit.getAttribute('data-subject'));
    expect(only).toEqual(['Add the feature note']);

    fixture.nativeElement.querySelector('[data-branch="main"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="branch-commits"]')).toBeNull();
    const recent = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    expect(recent.previousElementSibling?.textContent?.trim()).toBe('Commits');
    expect(
      [...recent.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Plant the main line', 'init']);
    expect(fixture.nativeElement.querySelector('.branch-heading p').textContent).not.toContain(
      'commits only on this branch',
    );
    expect(blockTop(fixture.nativeElement.querySelector('[data-testid="commits"]'))).toBeGreaterThanOrEqual(
      blockBottom(fixture.nativeElement.querySelector('[data-testid="changes"]')),
    );
  });

  it('lists commits that are not on main when the checkout is the feature branch', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    writeFileSync(join(repoPath, 'docs.txt'), 'main line\n');
    git(repoPath, ['add', 'docs.txt']);
    git(repoPath, ['commit', '-m', 'Plant the main line']);
    git(repoPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'docs.txt'), 'main line\nfeature note\n');
    git(repoPath, ['add', 'docs.txt']);
    git(repoPath, ['commit', '-m', 'Add the feature note']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    const only = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="branch-commits"] [data-testid="commit"]',
      ),
    ].map((commit) => commit.getAttribute('data-subject'));
    expect(only).toEqual(['Add the feature note']);
  });

  it('shows the files and diff of the commit that was chosen when two commits share a subject', async () => {
    const repoPath = createEmptyRepository(roots);
    writeFileSync(join(repoPath, 'one.txt'), 'alpha line\n');
    git(repoPath, ['add', 'one.txt']);
    git(repoPath, ['commit', '-m', 'Same title']);
    writeFileSync(join(repoPath, 'two.txt'), 'beta line\n');
    git(repoPath, ['add', 'two.txt']);
    git(repoPath, ['commit', '-m', 'Same title']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const same = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="recent-commits"] [data-testid="commit"][data-subject="Same title"]',
      ),
    ];
    expect(same).toHaveLength(2);

    same[0].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('beta line');

    same[1].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('alpha line');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).not.toContain('beta line');
  });

  it('lists the commits on master, including the commit that starts the branch', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="branch-commits"]')).toBeNull();
    const recent = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    expect(recent.previousElementSibling?.textContent?.trim()).toBe('Commits');
    expect(
      [...recent.querySelectorAll('[data-testid="commit"]')].map((commit) =>
        commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Add the old guide']);
    expect(fixture.nativeElement.querySelector('.branch-heading p').textContent).not.toContain(
      'commits only on this branch',
    );

    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="recent-commits"]')).toBeNull();
    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]')].map(
        (commit) => commit.getAttribute('data-subject'),
      ),
    ).toEqual(['Add the logo', 'Retitle the guide']);
  });

  it('shows the guide edit and the commits only on rewrite', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();

    const files = [
      ...fixture.nativeElement.querySelectorAll(
        '[data-testid="changed-files"] [data-testid="changed-file"]',
      ),
    ];
    expect(files).toHaveLength(1);
    expect(files[0].getAttribute('data-path')).toBe('docs/guide.md');
    expect(files[0].querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('1');
    expect(files[0].querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('0');

    const commits = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="branch-commits"] [data-testid="commit"]'),
    ];
    expect(commits.map((commit) => commit.getAttribute('data-subject'))).toEqual([
      'Add the logo',
      'Retitle the guide',
    ]);
  });

  it('opens the working tree diff for the renamed guide', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('[data-testid="changed-files"] [data-testid="changed-file"][data-path="docs/guide.md"]')
      .click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('pier note');
  });

  it('shows the renamed guide and the binary logo for commits on rewrite', async () => {
    const repoPath = createRewriteRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="rewrite"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Retitle the guide"]').click();
    fixture.detectChanges();

    const commitFiles = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    const files = [...commitFiles.querySelectorAll('[data-testid="changed-file"]')];
    expect(files).toHaveLength(1);
    expect(files[0].getAttribute('data-path')).toBe('docs/guide.md');
    expect(files[0].getAttribute('data-previous-path')).toBe('docs/old-guide.md');
    expect(files[0].querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('1');
    expect(files[0].querySelector('[data-testid="lines-deleted"]').textContent.trim()).toBe('1');

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    expect(diff.textContent).toContain('new guide');
    expect(commitFiles.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the logo"]').click();
    fixture.detectChanges();

    const logo = fixture.nativeElement.querySelector(
      '[data-testid="commit-files"] [data-testid="changed-file"]',
    );
    expect(logo.getAttribute('data-path')).toBe('assets/logo.png');
    expect(logo.querySelector('[data-testid="lines-added"]')).toBeNull();
    expect(logo.querySelector('[data-testid="lines-deleted"]')).toBeNull();
  });

  it('titles a registered repository with its display name', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');

    const fixture = await renderRepository(repoPath);

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-name')).toBe(
      'Harbor',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(
      repoPath,
    );
  });

  it('lists master first when that is the default branch and keeps every other worktree in order', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature/notes']);
    git(repoPath, ['branch', 'zeta']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature-notes'), 'feature/notes']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'zeta'), 'zeta']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['master', 'feature/notes', 'zeta']);
  });

  it('lists main first when the remote default changed from master and the stored HEAD still says master', async () => {
    const repoPath = createEmptyRepository(roots);
    const origin = join(repoPath, '..', 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', origin]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    git(repoPath, ['checkout', '-b', 'main']);
    git(repoPath, ['push', 'origin', 'main']);
    execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      stdio: 'ignore',
    });
    git(repoPath, ['remote', 'set-head', 'origin', 'master']);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'zeta'), 'zeta']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['main', 'feature', 'zeta']);
  });

  it('lists main first when that is the default branch and keeps every other worktree in order', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    git(repoPath, ['branch', 'feature/login']);
    git(repoPath, ['branch', 'zeta']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature-login'), 'feature/login']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'zeta'), 'zeta']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['main', 'feature/login', 'zeta']);
  });

  it('omits the default branch when that checkout is on a feature branch', async () => {
    const repoPath = createEmptyRepository(roots, 'main');
    git(repoPath, ['checkout', '-b', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(fixture.nativeElement.querySelector('.branch-label').textContent.trim()).toBe('Worktrees');
    expect(branchNames(fixture)).toEqual(['feature']);
  });

  it('omits master when the checkout is a feature branch', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['checkout', '-b', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(branchNames(fixture)).toEqual(['feature']);
  });

  it('creates the notes worktree from the button', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'notes']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="create-worktree-dialog"]') === null,
    );

    const checkout = join(repoPath, '.workspaces', 'notes');
    expect(git(checkout, ['branch', '--show-current'])).toBe('notes');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master', 'notes']);
    expect(fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]')).toBeNull();
  });

  it('shows an error when the worktree folder already exists', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature/notes']);
    const checkout = join(repoPath, '.workspaces', 'feature-notes');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'keep.txt'), 'stay');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const worktreesBefore = git(repoPath, ['worktree', 'list']);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'feature/notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(fixture, (root) =>
      (root.querySelector('[data-testid="create-worktree-dialog"] [data-testid="workspace-error"]')?.textContent ?? '').includes(
        `Worktree folder already exists: ${checkout}`,
      ),
    );

    const error = dialog.querySelector('[data-testid="workspace-error"]');
    expect(error.textContent).toContain(`Worktree folder already exists: ${checkout}`);
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(readFileSync(join(checkout, 'keep.txt'), 'utf8')).toBe('stay');
    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master']);
  });

  it('adds no worktree when a plugin aborts create', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'notes']);
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    writeFileSync(
      join(repoPath, 'plugins', 'abort.ts'),
      [
        'export default {',
        "  name: 'abort-create',",
        "  preWorktreeCreate(): 'abort' {",
        "    return 'abort';",
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks]\nmodules = ["plugins/abort.ts"]\n',
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const worktreesBefore = git(repoPath, ['worktree', 'list']);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    await untilVisible(fixture, (root) =>
      (root.querySelector('[data-testid="create-worktree-dialog"] [data-testid="workspace-error"]')?.textContent ?? '').includes(
        'abort-create aborted worktree create',
      ),
    );
    expect(dialog.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'abort-create aborted worktree create',
    );
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'notes'))).toBe(false);
  });

  it('runs a shell command and a TypeScript plugin from the create button', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'notes']);
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    mkdirSync(join(repoPath, 'hooks'), { recursive: true });
    const pluginMarker = join(repoPath, 'plugin-hook.txt');
    const shellMarker = join(repoPath, 'shell-hook.txt');
    writeFileSync(
      join(repoPath, 'plugins', 'mark.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        'export default {',
        "  name: 'mark',",
        '  preWorktreeCreate() {',
        `    writeFileSync(${JSON.stringify(pluginMarker)}, 'plugin ran\\n');`,
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(repoPath, 'hooks', 'mark.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(shellMarker)}, 'shell ran\\n');`,
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      [
        '[hooks]',
        'modules = ["plugins/mark.ts"]',
        '',
        '[hooks.pre_worktree_create]',
        'commands = ["node hooks/mark.mjs"]',
        '',
      ].join('\n'),
    );
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    const checkout = join(repoPath, '.workspaces', 'notes');
    await untilVisible(fixture, () => existsSync(checkout) && existsSync(pluginMarker) && existsSync(shellMarker));

    expect(readFileSync(pluginMarker, 'utf8')).toBe('plugin ran\n');
    expect(readFileSync(shellMarker, 'utf8')).toBe('shell ran\n');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
  });

  it('copies .env into the new worktree and leaves the original unchanged', async () => {
    const repoPath = createEmptyRepository(roots);
    writeFileSync(join(repoPath, '.env'), 'SECRET=1\n');
    git(repoPath, ['branch', 'notes']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[copy]\nfiles = [".env"]\n');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'notes';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    const copied = join(repoPath, '.workspaces', 'notes', '.env');
    await untilVisible(fixture, () => existsSync(copied));

    expect(readFileSync(copied, 'utf8')).toBe('SECRET=1\n');
    writeFileSync(copied, 'SECRET=1\nTOKEN=2\n');
    expect(readFileSync(copied, 'utf8')).toBe('SECRET=1\nTOKEN=2\n');
    expect(readFileSync(join(repoPath, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('leaves the branch list unchanged when create is cancelled', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master']);

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    const field = dialog.querySelector('[data-testid="create-branch"]');
    field.value = 'dock';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();

    expect(
      [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
        row.getAttribute('data-branch'),
      ),
    ).toEqual(['master']);
    expect(fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]')).toBeNull();
    expect(existsSync(join(repoPath, '.workspaces', 'dock'))).toBe(false);
  });

  it('shows the diff for the commit file that was chosen', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['checkout', '-b', 'topic']);
    writeFileSync(join(repoPath, 'a.txt'), 'alpha\n');
    writeFileSync(join(repoPath, 'b.txt'), 'beta\n');
    git(repoPath, ['add', 'a.txt', 'b.txt']);
    git(repoPath, ['commit', '-m', 'Add both files']);
    git(repoPath, ['checkout', 'master']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'topic'), 'topic']);
    const fixture = await renderRepository(repoPath);

    fixture.nativeElement.querySelector('[data-branch="topic"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add both files"]').click();
    fixture.detectChanges();

    const commitFiles = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('alpha');
    commitFiles.querySelector('[data-path="b.txt"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('beta');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).not.toContain('alpha');
  });

  it('omits a branch that has no worktree', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
    expect(branchNames(fixture)).toEqual(['master']);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
  });

  it('shows an error when merge into master is not run on master', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    git(repoPath, ['checkout', '-b', 'other']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]');
    dialog.querySelector('[data-testid="confirm-merge-into-master"]').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'Primary checkout is on other, not master',
    );
    expect(git(repoPath, ['branch', '--show-current'])).toBe('other');
  });

  it('updates the branch worktree from master', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(repoPath, 'master.txt'), 'from master\n');
    git(repoPath, ['add', 'master.txt']);
    git(repoPath, ['commit', '-m', 'master change']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.click();
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="behind"]').textContent.trim()).toBe('1');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="update-from-master"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]')).toBeNull();
    expect(readFileSync(join(checkout, 'master.txt'), 'utf8')).toBe('from master\n');
    expect(git(checkout, ['log', '-1', '--format=%s'])).toBe('master change');
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(row.querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
  });

  it('opens a merge dialog that offers squash', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]')).toBeNull();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Merge into master');
    expect(dialog.querySelector('h2').textContent.trim()).toBe('Merge into master');
    const squash = dialog.querySelector('[data-testid="squash"]');
    expect(squash.tagName).toBe('INPUT');
    expect(squash.getAttribute('type')).toBe('checkbox');
    expect(squash.checked).toBe(false);
    expect(squash.parentElement.textContent.trim()).toBe('Squash');
    const panel = getComputedStyle(dialog.querySelector('.dialog-panel'));
    expect(panel.backgroundColor).toBe('rgb(247, 247, 245)');
    expect(panel.borderRadius).toBe('8px');
  });

  it('merges the branch into master', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(checkout, 'feature.txt'), 'from feature\n');
    git(checkout, ['add', 'feature.txt']);
    git(checkout, ['commit', '-m', 'feature change']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.click();
    fixture.detectChanges();
    expect(row.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('1');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]');
    expect(dialog.querySelector('[data-testid="squash"]').checked).toBe(false);
    dialog.querySelector('[data-testid="confirm-merge-into-master"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]')).toBeNull();
    expect(readFileSync(join(repoPath, 'feature.txt'), 'utf8')).toBe('from feature\n');
    expect(git(repoPath, ['log', '-1', '--format=%s'])).toBe('feature change');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature');
    expect(row.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
  });

  it('squashes the branch into one master commit when squash is checked', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(checkout, 'feature.txt'), 'from feature\n');
    git(checkout, ['add', 'feature.txt']);
    git(checkout, ['commit', '-m', 'feature change']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]');
    dialog.querySelector('[data-testid="squash"]').click();
    fixture.detectChanges();
    expect(dialog.querySelector('[data-testid="squash"]').checked).toBe(true);
    dialog.querySelector('[data-testid="confirm-merge-into-master"]').click();
    fixture.detectChanges();

    expect(readFileSync(join(repoPath, 'feature.txt'), 'utf8')).toBe('from feature\n');
    expect(git(repoPath, ['log', '--format=%s'])).toBe('Squash feature into master\ninit');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(git(checkout, ['log', '-1', '--format=%s'])).toBe('feature change');
  });

  it('does not merge into master when the merge dialog is cancelled', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(checkout, 'feature.txt'), 'from feature\n');
    git(checkout, ['add', 'feature.txt']);
    git(checkout, ['commit', '-m', 'feature change']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.click();
    fixture.detectChanges();
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]');
    dialog.querySelector('[data-testid="squash"]').click();
    fixture.detectChanges();
    dialog.querySelector('[data-testid="cancel-merge-into-master"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"]')).toBeNull();
    expect(existsSync(join(repoPath, 'feature.txt'))).toBe(false);
    expect(git(repoPath, ['log', '--format=%s'])).toBe('init');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(git(checkout, ['log', '-1', '--format=%s'])).toBe('feature change');
    expect(row.querySelector('[data-testid="ahead"]').textContent.trim()).toBe('1');
  });

  it('removes the worktree and drops that branch from the sidebar', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    const branchSha = git(repoPath, ['rev-parse', 'refs/heads/feature']);
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="remove-worktree"]').click();
    await confirmKeepBranch(fixture);

    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(git(repoPath, ['rev-parse', 'refs/heads/feature'])).toBe(branchSha);
    expect(fixture.nativeElement.querySelector('[data-testid="branch-row"][data-branch="feature"]')).toBeNull();
    expect(branchNames(fixture)).toEqual(['master']);
  });

  it('leaves the worktree when remove is cancelled', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.querySelector('[data-testid="remove-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="remove-worktree-dialog"]');
    expect(dialog.querySelector('[data-testid="remove-worktree-branch"]').textContent.trim()).toBe('feature');
    dialog.querySelector('[data-testid="cancel-remove-worktree"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="remove-worktree-dialog"]')).toBeNull();
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).not.toBeNull();
  });

  it('deletes only the local branch when remove confirms that', async () => {
    const repoPath = createEmptyRepository(roots);
    const origin = join(repoPath, '..', 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', origin]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['push', '-u', 'origin', 'feature']);
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.querySelector('[data-testid="remove-worktree"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="confirm-delete-branch"]').click();
    await untilVisible(fixture, (root) => root.querySelector('[data-testid="remove-worktree-dialog"]') === null);

    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(hasRef(repoPath, 'refs/heads/feature')).toBe(false);
    expect(hasRef(repoPath, 'refs/remotes/origin/feature')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
  });

  it('turns delete into force delete when the checkout has changes', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    writeFileSync(join(checkout, 'dirty.txt'), 'dirty\n');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.querySelector('[data-testid="remove-worktree"]').click();
    fixture.detectChanges();
    const deleteButton = () =>
      fixture.nativeElement.querySelector('[data-testid="confirm-delete-branch"]') as HTMLButtonElement;
    expect(deleteButton().textContent.trim()).toBe('Delete local branch');
    deleteButton().click();
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="confirm-delete-branch"]')?.textContent?.trim() === 'Force delete branch',
    );

    const forceButton = deleteButton();
    expect(getComputedStyle(forceButton).backgroundColor).toBe('rgb(180, 35, 24)');
    expect(getComputedStyle(forceButton).color).toBe('rgb(255, 255, 255)');
    expect(fixture.nativeElement.querySelector('[data-testid="workspace-error"]').textContent).toContain(
      'use --force to delete it',
    );
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    forceButton.click();
    await untilVisible(fixture, (root) => root.querySelector('[data-testid="remove-worktree-dialog"]') === null);

    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(hasRef(repoPath, 'refs/heads/feature')).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
  });

  it('reads the registry on the centered card when the live query flag is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const fixture = await renderLive();
    const card = fixture.nativeElement.querySelector('[data-testid="repository-card"]');

    expect(card).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="branch-list"]')).toBeNull();
    expect(card.querySelector('[data-testid="repository"][data-name="Harbor"]')).toBeNull();
    expect(card.querySelector('[data-testid="repository"][data-name="Atlas"]')).toBeNull();
    expect(card.querySelector('[data-testid="repositories-empty"]').textContent.trim()).toBe(
      'A repository needs to be added.',
    );
  });

  it('lists registered repositories on the card and opens that repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    git(pier, ['checkout', '-b', 'dock']);
    initGitRepo(quay);
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');

    const fixture = await renderLive();
    const names = [...fixture.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual(['Pier', 'Quay']);
    expect(fixture.nativeElement.querySelector('[data-testid="branch-list"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map((row) =>
      row.getAttribute('data-branch'),
    );
    expect(rows).toContain('dock');
    expect(rows).not.toContain('feature/login');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('data-path')).toBe(
      pier,
    );
  });

  it('adds a repository from the centered card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => pier);

    const fixture = await renderLive();
    const card = fixture.nativeElement.querySelector('[data-testid="repository-card"]');
    expect(card.querySelector('[data-testid="repository"]')).toBeNull();
    expect(card.querySelector('[data-testid="add-repository-path"]')).toBeNull();
    expect(card.querySelector('[data-testid="add-repository-name"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).toBeNull();

    card.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    const browse = dialog.querySelector('[data-testid="browse-repository-folder"]');
    const pathField = dialog.querySelector('[data-testid="add-repository-path"]');
    expect(browse.getAttribute('aria-label')).toBe('Choose folder');
    expect(browse.querySelector('svg')).not.toBeNull();
    expect(pathField.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(pathField.getAttribute('placeholder')).toBe('Choose folder');
    expect(pathField.value).toBe('');
    expect(card.querySelector('[data-testid="add-repository-name"]')).toBeNull();

    browse.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(dialog.querySelector('[data-testid="add-repository-path"]').value).toBe(pier);

    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = 'Pier';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).toBeNull();
  });

  it('suggests the repository name when a git directory is chosen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const nested = join(pier, 'src');
    initGitRepo(pier, 'dock');
    mkdirSync(nested);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => nested);

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="add-repository-path"]').value).toBe(nested);
    expect(dialog.querySelector('[data-testid="add-repository-name"]').value).toBe('pier');
    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]')).toBeNull();

    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository"][data-name="pier"]')).not.toBeNull();
  });

  it('shows an error when the chosen directory is not a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => plain);

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="add-repository-path"]').value).toBe(plain);
    expect(dialog.querySelector('[data-testid="add-repository-name"]').value).toBe('');
    const error = dialog.querySelector('[data-testid="card-error"]');
    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    expect(error.textContent).toBe(`Not a git repository: ${plain}`);
    expect(error.compareDocumentPosition(nameField) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(dialog.querySelector('[data-testid="confirm-add-repository"]').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="repository"]')).toBeNull();

    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]').textContent).toBe(
      `Not a git repository: ${plain}`,
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).not.toBeNull();
  });

  it('suggests the directory name of a bare git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const bare = join(root, 'pier.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => bare);

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="add-repository-name"]').value).toBe('pier.git');
    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]')).toBeNull();
  });

  it('accepts a typed folder path and opens the chooser again from the folder button', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const plain = join(root, 'plain');
    initGitRepo(pier, 'dock');
    mkdirSync(plain);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    const pathField = dialog.querySelector('[data-testid="add-repository-path"]');
    pathField.value = pier;
    pathField.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(pathField.value).toBe(pier);
    expect(dialog.querySelector('[data-testid="add-repository-name"]').value).toBe('pier');
    expect(dialog.querySelector('[data-testid="card-error"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="confirm-add-repository"]').disabled).toBe(false);

    pathField.value = plain;
    pathField.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="card-error"]').textContent).toBe(
      `Not a git repository: ${plain}`,
    );
    expect(dialog.querySelector('[data-testid="confirm-add-repository"]').disabled).toBe(true);

    setFolderBrowser(async () => pier);
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="add-repository-path"]').value).toBe(pier);
    expect(dialog.querySelector('[data-testid="card-error"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="confirm-add-repository"]').disabled).toBe(false);
  });

  it('shows an error and does not add a repository when the folder is not a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => plain);

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = 'Plain';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]').textContent).toBe(
      `Not a git repository: ${plain}`,
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).not.toBeNull();
  });

  it('shows an error and does not add a repository when no folder is chosen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = 'Nowhere';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]').textContent).toBe(
      'Choose a repository folder',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository"]')).toBeNull();
  });

  it('shows an error and does not add a repository when the display name is blank', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    setFolderBrowser(async () => pier);

    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = '   ';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="confirm-add-repository"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="card-error"]').textContent).toBe(
      'Enter a display name',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).not.toBeNull();
  });

  it('does not scroll the content sheet as one page', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    expect(getComputedStyle(sheet).overflowY).toBe('hidden');
  });

  it('clips overlay scrollbars inside the content sheet corners', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    let sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    expectContentSheetCorners(sheet);
    expectOverlayScrollbarsClipped(sheet);

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();
    sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    expectOverlayScrollbarsClipped(sheet);

    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Atlas"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="main"]').click();
    fixture.detectChanges();
    sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    expectOverlayScrollbarsClipped(sheet);
  });

  it('scrolls the branch list inside the sidebar', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const sidebar = fixture.nativeElement.querySelector('[data-testid="workspace"] aside');
    const branchList = sidebar.querySelector('[data-testid="branch-list"]');
    const style = getComputedStyle(branchList);
    expect(['auto', 'scroll']).toContain(style.overflowY);
    expect(Number.parseFloat(style.minHeight)).toBe(0);
    expect(Number.parseFloat(style.flexGrow)).toBeGreaterThan(0);
    expect(branchList.parentElement).toBe(sidebar);
  });

  it('shows a thin overlay scrollbar on the branch list while it scrolls, then fades it out', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const branchList = fixture.nativeElement.querySelector('[data-testid="branch-list"]') as HTMLElement;
    expect(getComputedStyle(branchList).scrollbarWidth).toBe('none');
    expect(getComputedStyle(branchList).scrollbarGutter).not.toBe('stable');
    expect(branchList.parentElement?.tagName).toBe('ASIDE');

    installScrollMetrics(branchList, { clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
    const thumb = branchList.querySelector('[data-testid="overlay-scrollbar"]') as HTMLElement;
    expect(thumb).not.toBeNull();

    vi.useFakeTimers();
    branchList.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('is-visible')).toBe(false);
    await vi.advanceTimersByTimeAsync(700);

    installScrollMetrics(branchList, { clientHeight: 100, scrollHeight: 400, scrollTop: 0 });
    branchList.dispatchEvent(new Event('pointerenter'));
    expect(thumb.classList.contains('is-visible')).toBe(false);
    expect(getComputedStyle(thumb).opacity).toBe('0');

    branchList.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('is-visible')).toBe(true);
    const thumbStyle = getComputedStyle(thumb);
    expect(thumbStyle.opacity).toBe('1');
    expect(thumbStyle.position).toBe('absolute');
    expect(Number.parseFloat(thumbStyle.width)).toBeLessThanOrEqual(8);
    expect(Number.parseFloat(thumbStyle.width)).toBeGreaterThan(0);
    expect(thumb.style.height).toBe('25px');
    expect(thumb.style.transform).toBe('translateY(0px)');
    const fadeInMs = opacityTransitionMs(thumbStyle);
    expect(fadeInMs).toBeGreaterThanOrEqual(120);
    expect(fadeInMs).toBeLessThanOrEqual(280);

    installScrollMetrics(branchList, { clientHeight: 100, scrollHeight: 400, scrollTop: 100 });
    branchList.dispatchEvent(new Event('scroll'));
    expect(thumb.style.transform).toBe('translateY(25px)');
    expect(thumb.classList.contains('is-visible')).toBe(true);
    branchList.dispatchEvent(new Event('pointerleave'));
    expect(thumb.classList.contains('is-visible')).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(thumb.classList.contains('is-visible')).toBe(false);
    const hiddenStyle = getComputedStyle(thumb);
    expect(hiddenStyle.opacity).toBe('0');
    const fadeOutMs = opacityTransitionMs(hiddenStyle);
    expect(fadeOutMs).toBeGreaterThan(fadeInMs);
    expect(fadeOutMs).toBeGreaterThanOrEqual(300);

    branchList.dispatchEvent(new Event('pointerenter'));
    expect(thumb.classList.contains('is-visible')).toBe(false);

    branchList.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('is-visible')).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(thumb.classList.contains('is-visible')).toBe(false);
    vi.useRealTimers();
  });

  it('drags the branch list overlay scrollbar', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    const branchList = fixture.nativeElement.querySelector('[data-testid="branch-list"]') as HTMLElement;
    installScrollMetrics(branchList, { clientHeight: 100, scrollHeight: 400, scrollTop: 0 });
    branchList.dispatchEvent(new Event('scroll'));
    const thumb = branchList.querySelector('[data-testid="overlay-scrollbar"]') as HTMLElement;
    expect(thumb.classList.contains('is-visible')).toBe(true);
    thumb.dispatchEvent(new PointerEvent('pointerdown', { clientY: 10, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 40, bubbles: true }));
    expect(branchList.scrollTop).toBe(120);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });

  it('shows a thin overlay scrollbar on changes, commits, the diff, and commit files', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    await expectOverlayScrollbar(fixture.nativeElement.querySelector('[data-testid="changed-files"]'));
    await expectOverlayScrollbar(fixture.nativeElement.querySelector('[data-testid="branch-commits"]'));

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(fixture.nativeElement.querySelector('[data-testid="diff"]'));

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(fixture.nativeElement.querySelector('[data-testid="commit-files"]'));

    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Atlas"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="main"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(fixture.nativeElement.querySelector('[data-testid="recent-commits"]'));
  });

  it('shows a thin overlay scrollbar on dialogs', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(
      fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await expectOverlayScrollbar(
      fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(
      fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"] .dialog-panel'),
    );

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();
    await expectOverlayScrollbar(
      fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"] .dialog-panel'),
    );

    const repoPath = createRepositoryWithDeletedRemoteBranches(roots);
    const live = await renderRepository(repoPath);
    live.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    live.detectChanges();
    await expectOverlayScrollbar(live.nativeElement.querySelector('[data-testid="create-branch-options"]'));
  });

  it('keeps dialogs inset from the top and bottom of the window', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    expectDialogWindowInset(
      fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expectDialogWindowInset(
      fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-branch="feature/login"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="merge-into-master"]').click();
    fixture.detectChanges();
    expectDialogWindowInset(
      fixture.nativeElement.querySelector('[data-testid="merge-into-master-dialog"] .dialog-panel'),
    );

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    expectDialogWindowInset(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] .dialog-panel'),
    );
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();
    expectDialogWindowInset(
      fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"] .dialog-panel'),
    );
  });

  it('places dialog actions on the right', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    expectDialogActionsOnTheRight(
      fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"] .dialog-actions'),
    );
    fixture.nativeElement.querySelector('[data-testid="close-app-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expectDialogActionsOnTheRight(
      fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"] .dialog-actions'),
    );
    fixture.nativeElement.querySelector('[data-testid="cancel-create-worktree"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    expectDialogActionsOnTheRight(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] .dialog-actions'),
    );
    fixture.nativeElement.querySelector('[data-testid="open-add-remote"]').click();
    fixture.detectChanges();
    expectDialogActionsOnTheRight(
      fixture.nativeElement.querySelector('[data-testid="add-remote-dialog"] .dialog-actions'),
    );
  });

  it('keeps the dialog scrollbar clear of the panel edges', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector(
      '[data-testid="app-settings-dialog"] .dialog-panel',
    ) as HTMLElement;
    const clientHeight = 200;
    installScrollMetrics(panel, { clientHeight, scrollHeight: 800, scrollTop: 600 });
    panel.dispatchEvent(new Event('scroll'));
    const thumb = panel.querySelector('[data-testid="overlay-scrollbar"]') as HTMLElement;
    expect(thumb.classList.contains('is-visible')).toBe(true);
    const paddingTop = Number.parseFloat(getComputedStyle(panel).paddingTop);
    const paddingBottom = Number.parseFloat(getComputedStyle(panel).paddingBottom);
    expect(paddingTop).toBeGreaterThanOrEqual(12);
    expect(paddingBottom).toBeGreaterThanOrEqual(12);
    const height = Number.parseFloat(thumb.style.height);
    const offset = Number.parseFloat(/translateY\(([-\d.]+)px\)/.exec(thumb.style.transform)?.[1] ?? '');
    const top = Number.parseFloat(getComputedStyle(thumb).top);
    expect(offset).toBeGreaterThan(0);
    expect(top + offset + height).toBeLessThanOrEqual(clientHeight - paddingTop - paddingBottom + 2);
  });

  it('leaves the terminal scrollbar unchanged', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="branch-row"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('[data-testid="terminal-row"]');
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-testid="overlay-scrollbar"]')).toBeNull();
    expect(row.querySelector('.overlay-scroll')).toBeNull();
    const viewport = fixture.nativeElement.querySelector('.xterm-viewport');
    if (viewport instanceof HTMLElement) {
      expect(viewport.classList.contains('overlay-scroll')).toBe(false);
      expect(viewport.style.scrollbarWidth).not.toBe('none');
    }
    const style = document.getElementById('gm-overlay-scrollbar');
    expect(style?.textContent ?? '').not.toContain('xterm');
  });

  it('scrolls the changes inside their own region', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const changedFiles = fixture.nativeElement.querySelector('[data-testid="changed-files"]');
    const style = getComputedStyle(changedFiles);
    expect(['auto', 'scroll']).toContain(style.overflowY);
    expect(Number.parseFloat(style.minHeight)).toBe(0);
    expect(Number.parseFloat(style.flexGrow)).toBeGreaterThan(0);
    expect(changedFiles.closest('[data-testid="changes"]')).not.toBeNull();
  });

  it('scrolls the diff inside its own region', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    const style = getComputedStyle(diff);
    expect(['auto', 'scroll']).toContain(style.overflowY);
    expect(Number.parseFloat(style.minHeight)).toBe(0);
    expect(Number.parseFloat(style.flexGrow)).toBeGreaterThan(0);
  });

  it('scrolls the commits inside their own region', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const branchCommits = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    const branchStyle = getComputedStyle(branchCommits);
    expect(['auto', 'scroll']).toContain(branchStyle.overflowY);
    expect(Number.parseFloat(branchStyle.minHeight)).toBe(0);
    expect(Number.parseFloat(branchStyle.flexGrow)).toBeGreaterThan(0);
    expect(branchCommits.closest('[data-testid="commits"]')).not.toBeNull();

    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Atlas"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="main"]').click();
    fixture.detectChanges();

    const recentCommits = fixture.nativeElement.querySelector('[data-testid="recent-commits"]');
    const recentStyle = getComputedStyle(recentCommits);
    expect(['auto', 'scroll']).toContain(recentStyle.overflowY);
    expect(Number.parseFloat(recentStyle.minHeight)).toBe(0);
    expect(Number.parseFloat(recentStyle.flexGrow)).toBeGreaterThan(0);
  });

  it('leaves the top bar and the other regions in place when one region scrolls', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]');
    const bar = fixture.nativeElement.querySelector('[data-testid="window-bar"]');
    const branchList = fixture.nativeElement.querySelector('[data-testid="branch-list"]');
    const changedFiles = fixture.nativeElement.querySelector('[data-testid="changed-files"]');
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    const commits = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');

    expect(bar.offsetParent).not.toBe(sheet);

    changedFiles.scrollTop = 48;

    expect(changedFiles.scrollTop).toBe(48);
    expect(sheet.scrollTop).toBe(0);
    expect(branchList.scrollTop).toBe(0);
    expect(diff.scrollTop).toBe(0);
    expect(commits.scrollTop).toBe(0);
  });

  it('shows the first-parent diff for a merge commit and highlights the selection', async () => {
    const repoPath = createEmptyRepository(roots);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    git(repoPath, ['add', 'base.txt']);
    git(repoPath, ['commit', '-m', 'Add the base']);
    git(repoPath, ['checkout', '-b', 'feature']);
    writeFileSync(join(repoPath, 'feature.txt'), 'from feature\n');
    git(repoPath, ['add', 'feature.txt']);
    git(repoPath, ['commit', '-m', 'Add the feature file']);
    git(repoPath, ['checkout', 'master']);
    writeFileSync(join(repoPath, 'master.txt'), 'from master\n');
    git(repoPath, ['add', 'master.txt']);
    git(repoPath, ['commit', '-m', 'Add the master file']);
    git(repoPath, ['merge', '--no-ff', 'feature', '-m', 'Merge feature into master']);

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const merge = fixture.nativeElement.querySelector(
      '[data-testid="commit"][data-subject="Merge feature into master"]',
    );
    merge.click();
    fixture.detectChanges();

    expect(merge.classList.contains('is-selected')).toBe(true);
    expect(getComputedStyle(merge).backgroundColor).toBe('rgba(26, 60, 43, 0.12)');
    const featureFile = fixture.nativeElement.querySelector(
      '[data-testid="commit-files"] [data-testid="changed-file"][data-path="feature.txt"]',
    );
    expect(featureFile.classList.contains('is-selected')).toBe(true);
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
    expect(diff.textContent).toContain('from feature');

    const plain = fixture.nativeElement.querySelector(
      '[data-testid="commit"][data-subject="Add the master file"]',
    );
    plain.click();
    fixture.detectChanges();
    expect(merge.classList.contains('is-selected')).toBe(false);
    expect(plain.classList.contains('is-selected')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('from master');
  });

  it('keeps the file list and explains a commit that has no diff', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['commit', '--allow-empty', '-m', 'Empty note']);

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="changed-files"]')).not.toBeNull();

    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Empty note"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="changed-files"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="commit-files"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="empty-diff"]').textContent.trim()).toBe(
      'No diff for this file',
    );
  });

  it('drags the divider between the changed-file list and the diff', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="changes-split"]');
    expect(split.getAttribute('role')).toBe('separator');
    expect(split.getAttribute('aria-orientation')).toBe('vertical');
    expect(split.getAttribute('tabindex')).toBe('0');

    const files = fixture.nativeElement.querySelector('[data-testid="changed-files"]');
    const listed = [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) =>
      file.getAttribute('data-path'),
    );
    const before = paneTrack(split.parentElement, 'gridTemplateColumns');

    dragDivider(split, { x: 240, y: 120 }, { x: 360, y: 120 });
    fixture.detectChanges();

    const after = paneTrack(split.parentElement, 'gridTemplateColumns');
    expect(after).toBeGreaterThan(before);

    fixture.detectChanges();
    expect(paneTrack(split.parentElement, 'gridTemplateColumns')).toBe(after);
    expect(
      [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) => file.getAttribute('data-path')),
    ).toEqual(listed);
  });

  it('drags the divider between the changes and the commits', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="commits-split"]');
    expect(split.getAttribute('role')).toBe('separator');
    expect(split.getAttribute('aria-orientation')).toBe('horizontal');
    expect(split.getAttribute('tabindex')).toBe('0');

    const files = fixture.nativeElement.querySelector('[data-testid="changed-files"]');
    const commits = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    const listedFiles = [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) =>
      file.getAttribute('data-path'),
    );
    const listedCommits = [...commits.querySelectorAll('[data-testid="commit"]')].map((commit) =>
      commit.getAttribute('data-subject'),
    );
    const before = paneTrack(split.parentElement, 'gridTemplateRows');

    dragDivider(split, { x: 400, y: 200 }, { x: 400, y: 280 });
    fixture.detectChanges();

    const after = paneTrack(split.parentElement, 'gridTemplateRows');
    expect(after).toBeGreaterThan(before);
    expect(blockTop(sheetSection(commits))).toBeGreaterThanOrEqual(blockBottom(sheetSection(files)));

    fixture.detectChanges();
    expect(paneTrack(split.parentElement, 'gridTemplateRows')).toBe(after);
    expect(
      [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) => file.getAttribute('data-path')),
    ).toEqual(listedFiles);
    expect(
      [...commits.querySelectorAll('[data-testid="commit"]')].map((commit) => commit.getAttribute('data-subject')),
    ).toEqual(listedCommits);
  });

  it('keeps the commits divider inside the sheet when the changes pane is dragged tall', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="commits-split"]');
    const columns = split.parentElement as HTMLElement;
    Object.defineProperty(columns, 'clientHeight', { configurable: true, value: 400 });

    dragDivider(split, { x: 400, y: 200 }, { x: 400, y: 2000 });
    fixture.detectChanges();

    expect(paneTrack(columns, 'gridTemplateRows')).toBe(312);
  });

  it('keeps both headings visible when the changes pane is dragged on a short stack', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    const stack = split.parentElement as HTMLElement;
    Object.defineProperty(stack, 'clientHeight', { configurable: true, value: 120 });

    dragDivider(split, { x: 400, y: 200 }, { x: 400, y: 2000 });
    fixture.detectChanges();

    expect(paneTrack(stack, 'gridTemplateRows')).toBe(68);
  });

  it('remembers the changes and commits share and the docked terminal height', async () => {
    const repoPath = createEmptyRepository(roots);
    const settingsPath = join(repoPath, '..', 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;

    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    dragDivider(commitsSplit, { x: 400, y: 200 }, { x: 400, y: 220 });
    const terminalSplit = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(terminalSplit, { x: 400, y: 200 }, { x: 400, y: 120 });
    fixture.detectChanges();

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      changesShare: 300 / 392,
      terminalRowHeight: 320,
      changesFileWidth: 240,
      commitFileWidth: 240,
    });

    fixture.destroy();

    const again = await renderRepository(repoPath);
    again.nativeElement.querySelector('[data-branch="master"]').click();
    again.detectChanges();
    const againBody = again.nativeElement.querySelector('.sheet-body') as HTMLElement;
    Object.defineProperty(againBody, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(again.nativeElement);
    again.detectChanges();
    window.dispatchEvent(new Event('resize'));
    again.detectChanges();

    expect(paneTrack(
      (again.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement).parentElement as HTMLElement,
      'gridTemplateRows',
    )).toBe(239);
    expect(terminalSectionHeight(againBody)).toBe(320);
    again.destroy();
  });

  it('remembers the changes column and the commit-files column across repositories', async () => {
    const settingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH ?? '';
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const changesSplit = fixture.nativeElement.querySelector('[data-testid="changes-split"]') as HTMLElement;
    dragDivider(changesSplit, { x: 240, y: 120 }, { x: 360, y: 120 });
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();
    const commitSplit = fixture.nativeElement.querySelector('[data-testid="commit-detail-split"]') as HTMLElement;
    dragDivider(commitSplit, { x: 240, y: 160 }, { x: 320, y: 160 });
    fixture.detectChanges();

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      changesFileWidth: 360,
      commitFileWidth: 320,
    });

    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Atlas"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('.sheet-columns') as HTMLElement).style.gridTemplateColumns).toBe(
      '360px 8px 320px 8px minmax(0, 1fr)',
    );
    fixture.destroy();

    const again = await render();
    again.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    again.detectChanges();
    again.nativeElement.querySelector('[data-branch="feature/login"]').click();
    again.detectChanges();
    again.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    again.detectChanges();
    expect((again.nativeElement.querySelector('.sheet-columns') as HTMLElement).style.gridTemplateColumns).toBe(
      '360px 8px 320px 8px minmax(0, 1fr)',
    );
    again.destroy();
  });

  it('remembers a divider that was double-clicked', async () => {
    const repoPath = createEmptyRepository(roots);
    const settingsPath = join(repoPath, '..', 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();
    doubleClickDivider(fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement);
    fixture.detectChanges();

    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).changesShare).toBe(0.5);
    expect(paneTrack(
      (fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement).parentElement as HTMLElement,
      'gridTemplateRows',
    )).toBe(196);

    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 600 });
    doubleClickDivider(fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement);
    fixture.detectChanges();

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      changesShare: 0.5,
      terminalRowHeight: 200,
    });
    expect(body.style.gridTemplateRows).toBe('minmax(0, 1fr) 8px 200px');
    fixture.destroy();
  });

  it('shrinks a saved terminal height in memory when the headings would not fit', async () => {
    const repoPath = createEmptyRepository(roots);
    const settingsPath = join(repoPath, '..', 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"changesShare":0.5,"terminalRowHeight":400,"changesFileWidth":240,"commitFileWidth":240}\n',
    );
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 248 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();

    expect(terminalSectionHeight(body)).toBe(144);
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(44);

    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();

    expect(terminalSectionHeight(body)).toBe(400);
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(116);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).terminalRowHeight).toBe(400);

    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 248 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).terminalRowHeight).toBe(400);

    doubleClickDivider(commitsSplit);
    fixture.detectChanges();
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).terminalRowHeight).toBe(400);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).changesShare).toBe(0.5);
    fixture.destroy();

    const small = await renderRepository(repoPath);
    small.nativeElement.querySelector('[data-branch="master"]').click();
    small.detectChanges();
    const smallBody = small.nativeElement.querySelector('.sheet-body') as HTMLElement;
    Object.defineProperty(smallBody, 'clientHeight', { configurable: true, value: 150 });
    dockTerminalSection(small.nativeElement);
    small.detectChanges();
    window.dispatchEvent(new Event('resize'));
    small.detectChanges();

    expect(terminalSectionHeight(smallBody)).toBe(400);
    expect(paneTrack(
      (small.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement).parentElement as HTMLElement,
      'gridTemplateRows',
    )).toBe(280);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).terminalRowHeight).toBe(400);
    small.destroy();
  });

  it('keeps the changes and commits share when the terminal section and the window change', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    dragDivider(commitsSplit, { x: 400, y: 200 }, { x: 400, y: 220 });
    fixture.detectChanges();
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(300);

    const terminalSplit = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(terminalSplit, { x: 400, y: 200 }, { x: 400, y: 120 });
    fixture.detectChanges();

    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(239);
    expect(terminalSectionHeight(body)).toBe(320);

    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 528 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(147);

    (fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(370);

    (fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(147);
    expect(terminalSectionHeight(body)).toBe(320);

    fixture.destroy();
  });

  it('sets changes and commits to half when their divider is double-clicked', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    commitsSplit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(196);
    fixture.destroy();
  });

  it('keeps both headings visible while the stack can hold them', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 448 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    dragDivider(commitsSplit, { x: 400, y: 200 }, { x: 400, y: 100 });
    const terminalSplit = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(terminalSplit, { x: 400, y: 200 }, { x: 400, y: 160 });
    fixture.detectChanges();

    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(108);
    fixture.destroy();
  });

  it('keeps the changes heading visible while the stack can hold it', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    dragDivider(commitsSplit, { x: 400, y: 200 }, { x: 400, y: 0 });
    const terminalSplit = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(terminalSplit, { x: 400, y: 200 }, { x: 400, y: -100 });
    fixture.detectChanges();

    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(44);
    fixture.destroy();
  });

  it('splits a short stack by the share and lets the terminal section keep growing', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const commitsSplit = fixture.nativeElement.querySelector('[data-testid="commits-split"]') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();

    dragDivider(commitsSplit, { x: 400, y: 200 }, { x: 400, y: 220 });
    const terminalSplit = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(terminalSplit, { x: 400, y: 200 }, { x: 400, y: -160 });
    fixture.detectChanges();

    expect(terminalSectionHeight(body)).toBe(600);
    expect(paneTrack(commitsSplit.parentElement as HTMLElement, 'gridTemplateRows')).toBe(24);
    fixture.destroy();
  });

  it('drags the divider between the open commit files and the diff', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="commit-detail-split"]');
    expect(split.getAttribute('role')).toBe('separator');
    expect(split.getAttribute('aria-orientation')).toBe('vertical');
    expect(split.getAttribute('tabindex')).toBe('0');

    const files = fixture.nativeElement.querySelector('[data-testid="commit-files"]');
    const diff = files.parentElement.querySelector('[data-testid="diff"]');
    const commits = fixture.nativeElement.querySelector('[data-testid="branch-commits"]');
    const listedFiles = [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) =>
      file.getAttribute('data-path'),
    );
    const listedCommits = [...commits.querySelectorAll('[data-testid="commit"]')].map((commit) =>
      commit.getAttribute('data-subject'),
    );
    const before = Number.parseFloat(files.style.width);

    dragDivider(split, { x: 240, y: 160 }, { x: 360, y: 160 });
    fixture.detectChanges();

    const after = Number.parseFloat(files.style.width);
    expect(after).toBeGreaterThan(before);
    expect(files.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fixture.detectChanges();
    expect(Number.parseFloat(files.style.width)).toBe(after);
    expect(
      [...files.querySelectorAll('[data-testid="changed-file"]')].map((file) => file.getAttribute('data-path')),
    ).toEqual(listedFiles);
    expect(
      [...commits.querySelectorAll('[data-testid="commit"]')].map((commit) => commit.getAttribute('data-subject')),
    ).toEqual(listedCommits);
  });

  it('gives the file list and the diff equal width when their divider is double-clicked', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const split = fixture.nativeElement.querySelector('[data-testid="changes-split"]') as HTMLElement;
    const columns = split.parentElement as HTMLElement;
    Object.defineProperty(columns, 'clientWidth', { configurable: true, value: 608 });

    doubleClickDivider(split);
    fixture.detectChanges();

    expect(columns.style.gridTemplateColumns).toBe('300px 8px minmax(0, 1fr)');
  });

  it('gives the stack, the commit files, and the diff equal width when a vertical divider is double-clicked', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add the login form"]').click();
    fixture.detectChanges();

    const columns = fixture.nativeElement.querySelector('.sheet-columns') as HTMLElement;
    Object.defineProperty(columns, 'clientWidth', { configurable: true, value: 616 });
    const commitSplit = fixture.nativeElement.querySelector('[data-testid="commit-detail-split"]') as HTMLElement;

    doubleClickDivider(commitSplit);
    fixture.detectChanges();

    expect(columns.style.gridTemplateColumns).toBe('200px 8px 200px 8px minmax(0, 1fr)');

    const changesSplit = fixture.nativeElement.querySelector('[data-testid="changes-split"]') as HTMLElement;
    dragDivider(changesSplit, { x: 200, y: 160 }, { x: 320, y: 160 });
    fixture.detectChanges();
    expect(columns.style.gridTemplateColumns).not.toBe('200px 8px 200px 8px minmax(0, 1fr)');

    doubleClickDivider(changesSplit);
    fixture.detectChanges();

    expect(columns.style.gridTemplateColumns).toBe('200px 8px 200px 8px minmax(0, 1fr)');
  });

  it('sets the terminal section to one third of the area under the branch heading when its divider is double-clicked', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    try {
      fixture.nativeElement.querySelector('[data-branch="master"]').click();
      fixture.detectChanges();
      dockTerminalSection(fixture.nativeElement);
      fixture.detectChanges();

      const split = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
      const body = split.parentElement as HTMLElement;
      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 600 });

      doubleClickDivider(split);
      fixture.detectChanges();

      expect(body.style.gridTemplateRows).toBe('minmax(0, 1fr) 8px 200px');

      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 900 });
      window.dispatchEvent(new Event('resize'));
      fixture.detectChanges();

      expect(body.style.gridTemplateRows).toBe('minmax(0, 1fr) 8px 200px');
    } finally {
      fixture.destroy();
    }
  });

  it('keeps the terminal section at the drag minimum when one third of the area is shorter', async () => {
    const repoPath = createEmptyRepository(roots);
    const fixture = await renderRepository(repoPath);
    try {
      fixture.nativeElement.querySelector('[data-branch="master"]').click();
      fixture.detectChanges();
      dockTerminalSection(fixture.nativeElement);
      fixture.detectChanges();

      const split = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
      const body = split.parentElement as HTMLElement;
      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 150 });

      doubleClickDivider(split);
      fixture.detectChanges();

      expect(body.style.gridTemplateRows).toBe('minmax(0, 1fr) 8px 80px');
    } finally {
      fixture.destroy();
    }
  });

  it('leaves registered repositories unchanged when the add dialog is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    setFolderBrowser(async () => quay);

    const fixture = await renderLive();
    expect(fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Quay"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-testid="add-repository"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]');
    dialog.querySelector('[data-testid="browse-repository-folder"]').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const nameField = dialog.querySelector('[data-testid="add-repository-name"]');
    nameField.value = 'Quay';
    nameField.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialog.querySelector('[data-testid="cancel-add-repository"]').click();
    fixture.detectChanges();

    const names = [...fixture.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual(['Pier']);
    expect(fixture.nativeElement.querySelector('[data-testid="add-repository-dialog"]')).toBeNull();
  });

  it('shows Opening until the repository list is ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]').textContent).toContain(
        'Opening Pier',
      );

      held.release();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('data-path')).toBe(
        pier,
      );
    } finally {
      held.release();
    }
  });

  it('shows skeletons in the repository tab before the worktree list is read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();
    const queued: Array<() => void> = [];
    setAfterPaintScheduler((task) => queued.push(task));
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();

    const opening = queued.splice(0);
    const reading: Array<() => void> = [];
    setAfterPaintScheduler((task) => reading.push(task));
    for (const task of opening) {
      task();
    }
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="worktree-skeleton"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="content-skeleton"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="branch-row"]')).toBeNull();

    setAfterPaintScheduler((task) => task());
    for (const task of reading) {
      task();
    }
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="worktree-skeleton"]')).toBeNull();
    expect(branchNames(fixture)).toEqual(['master']);
  });

  it('prunes remote-tracking refs when a repository is opened from the card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const origin = join(root, 'origin.git');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
    git(pier, ['remote', 'add', 'origin', origin]);
    git(pier, ['push', '-u', 'origin', 'master']);
    git(pier, ['update-ref', 'refs/remotes/origin/stale', git(pier, ['rev-parse', 'HEAD'])]);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();

    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    await whenRemoteRefreshIdle();

    expect(hasRef(pier, 'refs/remotes/origin/stale')).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('data-path')).toBe(
      pier,
    );
  });

  it('leaves the selected branch in place when the open repository tab is clicked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Pier"]'),
    ).toBeNull();
    fixture.nativeElement.querySelector('[data-testid="close-repository-switcher"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-branch="master"].is-selected, .branch-row.is-selected')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('.branch-row.is-selected').getAttribute('data-branch'),
    ).toBe('master');
    expect(fixture.nativeElement.querySelectorAll('[data-testid="repository-tab"]')).toHaveLength(1);
  });

  it('shows the kept repository before it rereads git', async () => {
    const { pier } = registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');

    writeFileSync(join(pier, '.workspaces', 'feature', 'notes.txt'), 'hello\n');
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('feature');
      expect(
        fixture.nativeElement.querySelector('[data-branch="feature"] [data-testid="changed-file-count"]').textContent.trim(),
      ).toBe('0');
      expect(fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]')).toBeNull();

      held.release();
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-branch="feature"] [data-testid="changed-file-count"]').textContent.trim(),
      ).toBe('1');
      expect(fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]')).not.toBeNull();
    } finally {
      held.release();
    }
  });

  it('keeps the open workspace visible while another repository opens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(pier, '.workspaces'));
    git(pier, ['branch', 'feature']);
    git(pier, ['worktree', 'add', join(pier, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    const held = holdPaint();
    try {
      openRepositoryCard(fixture);
      fixture.detectChanges();
      fixture.nativeElement
        .querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Quay"]')
        .click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe(
        'feature',
      );
      expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();

      held.release();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(fixture.nativeElement.querySelector('[data-testid="open-repository-card"]')).not.toBeNull();
      const tabs = [...fixture.nativeElement.querySelectorAll('[data-testid="repository-tab"]')].map((element) =>
        element.getAttribute('data-name'),
      );
      expect(tabs).toEqual(['Pier', 'Quay']);
      openRepositoryCard(fixture);
      const names = [
        ...fixture.nativeElement.querySelectorAll(
          '[data-testid="switching-overlay"] [data-testid="repository"]',
        ),
      ].map((element) => element.getAttribute('data-name'));
      expect(names).toEqual([]);
    } finally {
      held.release();
    }
  });

  it('shows the same selected branch when an earlier repository is opened again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    initGitRepo(pier);
    initGitRepo(quay);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    mkdirSync(join(pier, '.workspaces'));
    git(pier, ['branch', 'feature']);
    git(pier, ['worktree', 'add', join(pier, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    openRepositoryCard(fixture);
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="switching-overlay"] [data-testid="repository"][data-name="Quay"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe(
      'feature',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('feature');

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe(
      'master',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('master');
  });

  it('shows Loading branches before the create dialog lists names', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
      fixture.detectChanges();
      const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
      const field = dialog.querySelector('[data-testid="create-branch"]');

      expect(dialog.querySelector('[data-testid="loading-branches"]').textContent.trim()).toBe('Loading branches');
      expect(field.disabled).toBe(true);
      expect(dialog.querySelector('[data-testid="create-branch-option"]')).toBeNull();

      held.release();
      fixture.detectChanges();

      expect(dialog.querySelector('[data-testid="loading-branches"]')).toBeNull();
      expect(field.disabled).toBe(false);
      expect(dialog.querySelector('[data-testid="create-branch-option"]').getAttribute('data-branch')).toBe(
        'feature',
      );
    } finally {
      held.release();
    }
  });

  it('shows Creating worktree until the new row is listed', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');
    dialog.querySelector('[data-testid="create-branch-option"][data-branch="feature"]').click();
    fixture.detectChanges();
    const held = holdPaint();
    try {
      dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
      fixture.detectChanges();

      expect(dialog.querySelector('[data-testid="confirm-create-worktree"]').textContent.trim()).toBe(
        'Creating worktree',
      );
      expect(fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]')).not.toBeNull();

      held.release();
      await untilVisible(fixture, (root) => root.querySelector('[data-testid="create-worktree-dialog"]') === null);
      expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).not.toBeNull();
    } finally {
      held.release();
    }
  });

  it('reports an empty branch name without the creating hint', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-testid="create-worktree"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="create-worktree-dialog"]');

    dialog.querySelector('[data-testid="confirm-create-worktree"]').click();
    fixture.detectChanges();

    expect(dialog.querySelector('[data-testid="confirm-create-worktree"]').textContent.trim()).toBe(
      'Create worktree',
    );
    expect(dialog.querySelector('[data-testid="workspace-error"]').textContent).toContain('Enter a branch name');
  });

  it('keeps the branch name and IDE button while the worktree content loads', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-branch="master"]').click();
      fixture.detectChanges();

      const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]') as HTMLElement;
      const heading = sheet.querySelector('[data-testid="branch-heading"]') as HTMLElement;
      const loading = sheet.querySelector('[data-testid="content-loading"]') as HTMLElement;
      expect(heading.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('master');
      expect(heading.querySelector('[data-testid="open-ide"]')).not.toBeNull();
      expect(heading.querySelector('[data-testid="heading-skeleton"]')).not.toBeNull();
      expect(heading.querySelector('[data-testid="heading-summary"]')?.textContent).not.toContain('commits');
      expect(loading.getAttribute('aria-label')).toBe('Loading master');
      expect(loading.querySelectorAll('.skeleton-bar').length).toBeGreaterThan(0);
      expect(loading.querySelector('[data-testid="changed-files"]')).toBeNull();
      expect(loading.querySelector('[data-testid="commit"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('.branch-row.is-selected').getAttribute('data-branch')).toBe(
        'master',
      );

      held.release();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="content-loading"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="heading-skeleton"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="heading-summary"]')?.textContent).toContain(
        'changed files',
      );
      expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="changed-files"]')).not.toBeNull();
    } finally {
      held.release();
    }
  });

  it('keeps the terminal row height while the branch content loads', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();
    const split = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(split, { x: 400, y: 200 }, { x: 400, y: 120 });
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    const docked = terminalSectionHeight(body);
    const stackRows = (fixture.nativeElement.querySelector('.sheet-stack') as HTMLElement).style.gridTemplateRows;
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();

      const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]') as HTMLElement;
      const heading = sheet.querySelector('[data-testid="branch-heading"]') as HTMLElement;
      const loading = sheet.querySelector('[data-testid="content-loading"]') as HTMLElement;
      expect(heading.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('feature');
      expect(heading.querySelector('[data-testid="open-ide"]')).not.toBeNull();
      expect(heading.querySelector('[data-testid="heading-skeleton"]')).not.toBeNull();
      expect(loading.querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
      expect(loading.querySelector('[data-testid="terminal-row"]')).toBeNull();
      expect(sheet.querySelector('[data-testid="terminal-split"]')).not.toBeNull();
      expect(terminalSectionHeight(body)).toBe(docked);
      expect((loading.querySelector('.sheet-stack') as HTMLElement).style.gridTemplateRows).toBe(stackRows);

      held.release();
      fixture.detectChanges();

      expect(sheet.querySelector('[data-testid="content-loading"]')).toBeNull();
      expect(terminalSectionHeight(body)).toBe(docked);
      expect((sheet.querySelector('.sheet-stack') as HTMLElement).style.gridTemplateRows).toBe(stackRows);
    } finally {
      held.release();
    }
  });

  it('opens the selected checkout from the header while content is still loading', async () => {
    const launched: Array<{ command: string; cwd: string }> = [];
    setIdeLaunch((command, cwd) => {
      launched.push({ command, cwd });
    });

    const repoPath = createEmptyRepository(roots);
    const checkout = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', checkout, 'feature']);
    const root = join(repoPath, '..');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(settingsPath, '{"ideCommand":"code -n {folder}"}\n');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="open-ide"]').click();
      fixture.detectChanges();

      expect(launched).toEqual([{ command: `code -n '${checkout}'`, cwd: checkout }]);
    } finally {
      held.release();
    }
  });

  it('shows Loading on the row when the terminal section is maximized', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="terminal-maximize"]').click();
    fixture.detectChanges();
    const held = holdPaint();
    try {
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
      const sheet = fixture.nativeElement.querySelector('[data-testid="content-sheet"]') as HTMLElement;
      const heading = sheet.querySelector('[data-testid="branch-heading"]') as HTMLElement;
      const body = sheet.querySelector('.sheet-body') as HTMLElement;
      expect(row.querySelector('[data-testid="branch-activity"]').textContent.trim()).toBe('Loading feature');
      expect(fixture.nativeElement.querySelector('[data-testid="content-loading"]')).toBeNull();
      expect(heading.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('feature');
      expect(heading.querySelector('[data-testid="open-ide"]')).not.toBeNull();
      expect(heading.querySelector('[data-testid="heading-skeleton"]')).not.toBeNull();
      expect(heading.nextElementSibling).toBe(body);
      expect(body.querySelector('[data-testid="changes"]')).toBeNull();
      expect(body.querySelector('[data-testid="terminal-row"]')).not.toBeNull();
      expect(body.style.gridTemplateRows).toBe('minmax(0, 1fr)');

      held.release();
      fixture.detectChanges();

      expect(row.querySelector('[data-testid="branch-activity"]')).toBeNull();
    } finally {
      held.release();
    }
  });

  it('keeps the row hint until an action on the selected worktree has refreshed its content', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    const held = holdPaint();
    try {
      const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
      openWorktreeMenu(row);
      fixture.detectChanges();
      row.querySelector('[data-testid="update-from-master"]').click();
      fixture.detectChanges();

      expect(row.querySelector('[data-testid="branch-activity"]').textContent.trim()).toBe('Updating from master');
      expect(fixture.nativeElement.querySelector('[data-testid="content-loading"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).not.toBeNull();

      held.release();
      fixture.detectChanges();

      expect(row.querySelector('[data-testid="branch-activity"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).not.toBeNull();
    } finally {
      held.release();
    }
  });

  it('clears the selection when the open worktree is removed', async () => {
    const repoPath = createEmptyRepository(roots);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    row.click();
    fixture.detectChanges();
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="remove-worktree"]').click();
    await confirmKeepBranch(fixture);

    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="content-sheet"]').textContent).toContain(
      'Select a branch',
    );
  });

  it('opens Repository settings and Close from a repository tab and shows no close icon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    initGitRepo(pier);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    const fixture = await renderLive();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Pier"]').click();
    fixture.detectChanges();

    const tab = fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]');
    expect(tab.querySelector('svg, [aria-label="Close"]')).toBeNull();
    expect(tab.textContent.trim()).toBe('Pier');

    const menuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 12,
    });
    tab.dispatchEvent(menuEvent);
    fixture.detectChanges();

    expect(menuEvent.defaultPrevented).toBe(true);
    const menu = fixture.nativeElement.querySelector('[data-testid="repository-tab-menu"]');
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('role')).toBe('menu');
    const labels = [...menu.querySelectorAll('button')].map((button) => button.textContent.trim());
    expect(labels).toEqual(['Repository settings', 'Close']);
    expect(menu.querySelector('[data-testid="repository-tab-settings"]').textContent.trim()).toBe(
      'Repository settings',
    );
    expect(menu.querySelector('[data-testid="repository-tab-close"]').textContent.trim()).toBe('Close');
    expect(tab.querySelector('[data-testid="repository-tab-close"]')).toBeNull();
  });

  it('opens repository settings for the clicked tab and leaves the selected workspace in place', async () => {
    const { pier, quay } = registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();

    const menu = openRepositoryTabMenu(fixture, 'Pier');
    menu.querySelector('[data-testid="repository-tab-settings"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab-menu"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
    expect(fixture.nativeElement.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('master');
    const dialog = fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"]');
    expect(dialog.querySelector('[data-testid="repository-location"]').textContent).toBe(pier);
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();

    dialog.querySelector('[data-testid="worktree-mode-sibling"]').click();
    fixture.detectChanges();
    pickColor(dialog.querySelector('[data-testid="repository-sidebar-color"]'), '#123456');
    fixture.detectChanges();

    expect(readFileSync(join(pier, '.git-worktree-manager', 'config.toml'), 'utf8')).toContain('mode = "sibling"');
    expect(readFileSync(join(pier, '.git-worktree-manager', 'config.toml'), 'utf8')).toContain('sidebar_color = "#123456"');
    expect(existsSync(join(quay, '.git-worktree-manager', 'config.toml'))).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
  });

  it('opens the selected repository from the Worktrees row after a tab menu has used another repository', async () => {
    const { pier, quay } = registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] [data-testid="repository-location"]').textContent,
    ).toBe(quay);
    fixture.nativeElement.querySelector('[data-testid="close-repository-settings"]').click();
    fixture.detectChanges();

    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-settings"]').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] [data-testid="repository-location"]').textContent,
    ).toBe(pier);
    fixture.nativeElement.querySelector('[data-testid="close-repository-settings"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="repository-settings-dialog"] [data-testid="repository-location"]').textContent,
    ).toBe(quay);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
  });

  it('selects the repository to the right, or the one to the left when the closed tab was last', async () => {
    registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();

    openRepositoryTabMenu(fixture, 'Quay').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(repositoryTabNames(fixture)).toEqual(['Pier']);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('feature');
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();

    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();
    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(repositoryTabNames(fixture)).toEqual(['Quay']);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
    expect(fixture.nativeElement.querySelector('[data-testid="copy-branch-name"]')?.textContent).toContain('master');
  });

  it('leaves the selection in place when a repository tab that is not selected is closed', async () => {
    registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();

    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(repositoryTabNames(fixture)).toEqual(['Quay']);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
    openRepositoryCard(fixture);
    const offered = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="switching-overlay"] [data-testid="repository"]'),
    ].map((element) => element.getAttribute('data-name'));
    expect(offered).toEqual(['Pier']);
  });

  it('shows the start screen when the last repository tab is closed', async () => {
    const { pier } = registerPair();
    const settingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH ?? '';
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="start-screen"], .start-screen')).not.toBeNull();
    const names = [...fixture.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual(['Pier', 'Quay']);
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    if (existsSync(settingsPath)) {
      expect(readFileSync(settingsPath, 'utf8')).not.toContain(pier);
    }
  });

  it('selects a repository tab without copying its location', async () => {
    const { pier } = registerPair();
    const copied: string[] = [];
    setTextCopy((text) => {
      copied.push(text);
    });
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();

    expect(copied).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    fixture.nativeElement.querySelector('[data-testid="repository-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="repository-location"]').click();

    expect(copied).toEqual([pier]);
  });

  it('closes the repository tab menu on Escape before the repository card and on a click outside', async () => {
    registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    openRepositoryCard(fixture);
    openRepositoryTabMenu(fixture, 'Pier');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab-menu"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="switching-overlay"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]')).not.toBeNull();

    openRepositoryTabMenu(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-testid="branch-list"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab-menu"]')).toBeNull();
    expect(repositoryTabNames(fixture)).toEqual(['Pier']);
  });

  it('keeps each worktree terminal section on its repository tab', async () => {
    registerPair();
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    const body = fixture.nativeElement.querySelector('.sheet-body') as HTMLElement;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 648 });
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();
    const split = fixture.nativeElement.querySelector('[data-testid="terminal-split"]') as HTMLElement;
    dragDivider(split, { x: 400, y: 200 }, { x: 400, y: 120 });
    fixture.detectChanges();
    const height = terminalSectionHeight(body);
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();
    await waitForTerminal(() => terminalPaneText(fixture).includes('$') || terminalPaneText(fixture).includes('#'));
    fixture.nativeElement.querySelector('[data-testid="terminal-maximize"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="terminal-pane"]')).toHaveLength(1);

    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]').getAttribute('aria-label')).toBe(
      'Expand terminal',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).not.toBeNull();

    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]').getAttribute('aria-label')).toBe(
      'Expand terminal',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).toBeNull();
    dockTerminalSection(fixture.nativeElement);
    fixture.detectChanges();
    expect(terminalSectionHeight(fixture.nativeElement.querySelector('.sheet-body') as HTMLElement)).toBe(height);
    fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]').getAttribute('aria-label')).toBe(
      'Expand terminal',
    );

    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-maximize"]').getAttribute('aria-label')).toBe(
      'Restore terminal',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="terminal-pane"]')).toHaveLength(1);

    fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-collapse"]').getAttribute('aria-label')).toBe(
      'Expand terminal',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="changes"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="terminal-pane"]')).toBeNull();
  });

  it('ends the closed repository tab in-app terminal and leaves the selected repository terminal running', async () => {
    const { pier, quay } = registerPair();
    const feature = join(pier, '.workspaces', 'feature');
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();
    await waitForTerminal(() => shellProcessesIn(feature).length >= 1);
    const pierShells = shellProcessesIn(feature);
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();
    await waitForTerminal(() => shellProcessesIn(quay).length >= 1);
    const quayShells = shellProcessesIn(quay);

    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(repositoryTabNames(fixture)).toEqual(['Quay']);
    await waitForTerminal(() => pierShells.every((pid) => !processAlive(pid)));
    expect(quayShells.every((pid) => processAlive(pid))).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );

    openRepositoryTabMenu(fixture, 'Quay').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();
    await waitForTerminal(() => quayShells.every((pid) => !processAlive(pid)));
    expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    fixture.destroy();
  });

  it('ends the closed repository tab tmux session and leaves the other repository session running', async () => {
    const { pier, quay } = registerPair();
    const settingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    if (!settingsPath) {
      throw new Error('App settings path is not set');
    }
    writeFileSync(settingsPath, `${JSON.stringify({ terminalMode: 'tmux' })}\n`);
    const fixture = await renderLive();
    await openLiveRepository(fixture, 'Pier');
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();
    await waitForTerminal(() => sessionsForBranch(pier, 'feature').length === 1);
    const pierSession = sessionsForBranch(pier, 'feature')[0] ?? '';
    openRepositoryCard(fixture);
    await openLiveRepository(fixture, 'Quay');
    fixture.nativeElement.querySelector('[data-branch="master"]').click();
    fixture.detectChanges();
    startTerminal(fixture.nativeElement);
    fixture.detectChanges();
    await waitForTerminal(() => sessionsForBranch(quay, 'master').length === 1);
    const quaySession = sessionsForBranch(quay, 'master')[0] ?? '';

    openRepositoryTabMenu(fixture, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(sessionsForBranch(pier, 'feature')).toEqual([]);
    expect(sessionsForBranch(quay, 'master')).toEqual([quaySession]);
    expect(pierSession.length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );

    openRepositoryTabMenu(fixture, 'Quay').querySelector('[data-testid="repository-tab-close"]').click();
    fixture.detectChanges();

    expect(sessionsForBranch(quay, 'master')).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    fixture.destroy();
  });

  it('reopens the repository tabs in the same order with the same one selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    const dock = join(root, 'dock');
    initGitRepo(pier);
    initGitRepo(quay);
    initGitRepo(dock);
    writeFileSync(join(pier, 'README.md'), '# pier\n');
    writeFileSync(join(quay, 'README.md'), '# quay\n');
    writeFileSync(join(dock, 'README.md'), '# dock\n');
    git(pier, ['add', '.']);
    git(pier, ['commit', '-m', 'init']);
    git(quay, ['add', '.']);
    git(quay, ['commit', '-m', 'init']);
    git(dock, ['add', '.']);
    git(dock, ['commit', '-m', 'init']);
    mkdirSync(join(pier, '.workspaces'));
    git(pier, ['branch', 'feature']);
    git(pier, ['worktree', 'add', join(pier, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    addRepository(dock, 'Dock');

    const first = await renderLive();
    await openLiveRepository(first, 'Pier');
    first.nativeElement.querySelector('[data-branch="feature"]').click();
    first.detectChanges();
    startTerminal(first.nativeElement);
    first.detectChanges();
    await waitForTerminal(() => terminalPaneText(first).includes('$') || terminalPaneText(first).includes('#'));
    submitTerminalCommand(first.nativeElement, 'echo pier-before-quit');
    await waitForTerminal(() => terminalPaneText(first).includes('pier-before-quit'));
    openRepositoryCard(first);
    await openLiveRepository(first, 'Quay');
    first.nativeElement.querySelector('[data-branch="master"]').click();
    first.detectChanges();
    startTerminal(first.nativeElement);
    first.detectChanges();
    await waitForTerminal(() => terminalPaneText(first).includes('$') || terminalPaneText(first).includes('#'));
    submitTerminalCommand(first.nativeElement, 'echo quay-before-quit');
    await waitForTerminal(() => terminalPaneText(first).includes('quay-before-quit'));
    openRepositoryCard(first);
    await openLiveRepository(first, 'Dock');
    first.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
    first.detectChanges();
    expect(repositoryTabNames(first)).toEqual(['Pier', 'Quay', 'Dock']);
    expect(first.nativeElement.querySelector('.branch-row.is-selected')?.getAttribute('data-branch')).toBe('master');

    first.destroy();
    addRepository(quay, 'North Quay');
    const again = await renderLive();

    expect(again.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
    expect(repositoryTabNames(again)).toEqual(['Pier', 'North Quay', 'Dock']);
    expect(again.nativeElement.querySelector('[data-testid="repository-tab"][data-name="North Quay"]').textContent.trim()).toBe(
      'North Quay',
    );
    expect(
      again.nativeElement.querySelector('[data-testid="repository-tab"][data-name="North Quay"]').getAttribute('aria-selected'),
    ).toBe('true');
    expect(again.nativeElement.querySelector('.branch-row.is-selected')).toBeNull();
    expect(again.nativeElement.querySelector('[data-testid="content-sheet"]').textContent).toContain('Select a branch');
    expect(again.nativeElement.querySelector('[data-testid="terminal-pane"]')).toBeNull();
    expect(again.nativeElement.textContent).not.toContain('quay-before-quit');
    expect(again.nativeElement.textContent).not.toContain('pier-before-quit');

    again.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').click();
    again.detectChanges();
    await again.whenStable();
    again.detectChanges();

    expect(again.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(again.nativeElement.querySelector('.branch-row.is-selected')).toBeNull();
    expect(again.nativeElement.querySelector('[data-testid="terminal-pane"]')).toBeNull();
    expect(again.nativeElement.textContent).not.toContain('pier-before-quit');
  });

  it('skips a repository that is no longer registered and selects the next tab, or the previous one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    const dock = join(root, 'dock');
    initGitRepo(pier);
    initGitRepo(quay);
    initGitRepo(dock);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    addRepository(dock, 'Dock');

    const first = await renderLive();
    await openLiveRepository(first, 'Pier');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Quay');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Dock');
    first.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
    first.detectChanges();
    expect(repositoryTabNames(first)).toEqual(['Pier', 'Quay', 'Dock']);
    first.destroy();

    unregisterRepository(quay);
    const withoutQuay = await renderLive();

    expect(repositoryTabNames(withoutQuay)).toEqual(['Pier', 'Dock']);
    expect(withoutQuay.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Dock"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(withoutQuay.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'false',
    );
    withoutQuay.destroy();

    unregisterRepository(dock);
    const withoutDock = await renderLive();

    expect(repositoryTabNames(withoutDock)).toEqual(['Pier']);
    expect(withoutDock.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Pier"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(withoutDock.nativeElement.querySelector('[data-testid="start-screen"]')).toBeNull();
    expect(withoutDock.nativeElement.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });

  it('skips a repository tab whose path is no longer a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
    roots.push(root);
    const pier = join(root, 'pier');
    const quay = join(root, 'quay');
    const dock = join(root, 'dock');
    initGitRepo(pier);
    initGitRepo(quay);
    initGitRepo(dock);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(root, 'registry.db');
    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    addRepository(dock, 'Dock');

    const first = await renderLive();
    await openLiveRepository(first, 'Pier');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Quay');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Dock');
    first.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').click();
    first.detectChanges();
    first.destroy();

    rmSync(join(dock, '.git'), { recursive: true, force: true });
    const again = await renderLive();

    expect(repositoryTabNames(again)).toEqual(['Pier', 'Quay']);
    expect(again.nativeElement.querySelector('[data-testid="repository-tab"][data-name="Quay"]').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(again.nativeElement.querySelector('[data-testid="repository"][data-name="Dock"]')).toBeNull();
  });

  it('shows the start screen when every remembered repository tab is skipped', async () => {
    const { pier, quay } = registerPair();
    const first = await renderLive();
    await openLiveRepository(first, 'Pier');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Quay');
    first.destroy();

    unregisterRepository(pier);
    unregisterRepository(quay);
    const again = await renderLive();

    expect(again.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(again.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect(again.nativeElement.querySelector('[data-testid="opening-repository"]')).toBeNull();
    expect(again.nativeElement.querySelector('.start-screen')).not.toBeNull();
    const names = [...again.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) =>
      element.getAttribute('data-name'),
    );
    expect(names).toEqual([]);
    again.destroy();

    addRepository(pier, 'Pier');
    addRepository(quay, 'Quay');
    const later = await renderLive();

    expect(later.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(later.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect([...later.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) => element.getAttribute('data-name'))).toEqual([
      'Pier',
      'Quay',
    ]);
  });

  it('shows the start screen on the next launch after the last repository tab is closed', async () => {
    registerPair();
    const first = await renderLive();
    await openLiveRepository(first, 'Pier');
    openRepositoryCard(first);
    await openLiveRepository(first, 'Quay');
    openRepositoryTabMenu(first, 'Pier').querySelector('[data-testid="repository-tab-close"]').click();
    first.detectChanges();
    openRepositoryTabMenu(first, 'Quay').querySelector('[data-testid="repository-tab-close"]').click();
    first.detectChanges();
    expect(first.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    first.destroy();

    const again = await renderLive();

    expect(again.nativeElement.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(again.nativeElement.querySelector('[data-testid="repository-tab"]')).toBeNull();
    expect(again.nativeElement.querySelector('.start-screen')).not.toBeNull();
    expect([...again.nativeElement.querySelectorAll('[data-testid="repository"]')].map((element) => element.getAttribute('data-name'))).toEqual([
      'Pier',
      'Quay',
    ]);
  });

  it('leaves a stale remote-tracking ref in place when a worktree is removed', async () => {
    const repoPath = createEmptyRepository(roots);
    const origin = join(repoPath, '..', 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', origin]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    git(repoPath, ['update-ref', 'refs/remotes/origin/stale', git(repoPath, ['rev-parse', 'HEAD'])]);

    const row = fixture.nativeElement.querySelector('[data-branch="feature"]');
    openWorktreeMenu(row);
    fixture.detectChanges();
    row.querySelector('[data-testid="remove-worktree"]').click();
    await confirmKeepBranch(fixture);

    expect(fixture.nativeElement.querySelector('[data-branch="feature"]')).toBeNull();
    expect(hasRef(repoPath, 'refs/remotes/origin/stale')).toBe(true);
  });

  it('updates status, changed-file count, and ahead/behind while the repository tab stays open', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const tab = fixture.nativeElement.querySelector('[data-testid="repository-tab"]');
    expect(tab.getAttribute('data-path')).toBe(repoPath);

    const featureRow = () => fixture.nativeElement.querySelector('[data-branch="feature"]');
    expect(featureRow().getAttribute('data-status')).toBe('local-only');
    expect(featureRow().querySelector('[data-testid="changed-file-count"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    featureRow().click();
    fixture.detectChanges();

    mkdirSync(join(feature, 'src'));
    writeFileSync(join(feature, 'src', 'notes.txt'), 'hello\n');
    await untilVisible(fixture, (root) => {
      const row = root.querySelector('[data-branch="feature"]');
      return row?.querySelector('[data-testid="changed-file-count"]')?.textContent?.trim() === '1';
    });

    expect(featureRow().getAttribute('data-status')).toBe('local-only');
    expect(featureRow().querySelector('[data-testid="changed-file-count"]').textContent.trim()).toBe('1');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);

    git(feature, ['add', 'src/notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    await untilVisible(fixture, (root) => {
      const row = root.querySelector('[data-branch="feature"]');
      return (
        row?.querySelector('[data-testid="changed-file-count"]')?.textContent?.trim() === '0' &&
        row?.querySelector('[data-testid="ahead"]')?.textContent?.trim() === '1'
      );
    });

    expect(featureRow().getAttribute('data-status')).toBe('local-only');
    expect(featureRow().querySelector('[data-testid="changed-file-count"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('1');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);
  });

  it('updates ahead and behind after a push from that checkout while the repository tab stays open', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    git(feature, ['push', '-u', 'origin', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const featureRow = () => fixture.nativeElement.querySelector('[data-branch="feature"]');
    expect(featureRow().getAttribute('data-status')).toBe('local-and-remote');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    featureRow().click();
    fixture.detectChanges();

    git(feature, ['commit', '--allow-empty', '-m', 'local only']);
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="feature"] [data-testid="ahead"]')?.textContent?.trim() === '1',
    );
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');

    git(feature, ['push']);
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="feature"] [data-testid="ahead"]')?.textContent?.trim() === '0',
    );

    expect(featureRow().getAttribute('data-status')).toBe('local-and-remote');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);
  });

  it('updates Changes, Commits, and the diff while the repository tab stays open', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    writeFileSync(join(feature, 'notes.txt'), 'hello\n');
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="changed-file"][data-path="notes.txt"]') !== null,
    );
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('hello');

    writeFileSync(join(feature, 'notes.txt'), 'hello\nworld\n');
    await untilVisible(fixture, (root) => root.querySelector('[data-testid="diff"]')?.textContent?.includes('world') === true);

    const notes = fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]');
    expect(notes.classList.contains('is-selected')).toBe(true);
    expect(notes.querySelector('[data-testid="lines-added"]').textContent.trim()).toBe('2');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('world');

    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    await untilVisible(
      fixture,
      (root) =>
        root.querySelector('[data-testid="changed-file"][data-path="notes.txt"]') === null &&
        root.querySelector('[data-testid="commit"][data-subject="Add notes"]') !== null,
    );
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add notes"]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('hello');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('world');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);
  });

  it('keeps the selected file when it still exists', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();

    writeFileSync(join(feature, 'notes.txt'), 'one\n');
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="changed-file"][data-path="notes.txt"]') !== null,
    );
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]').click();
    fixture.detectChanges();

    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\n');
    writeFileSync(join(feature, 'extra.txt'), 'extra\n');
    await untilVisible(fixture, (root) => {
      const notes = root.querySelector('[data-testid="changed-file"][data-path="notes.txt"]');
      return (
        notes?.querySelector('[data-testid="lines-added"]')?.textContent?.trim() === '2' &&
        root.querySelector('[data-testid="changed-file"][data-path="extra.txt"]') !== null
      );
    });

    const notes = fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]');
    const extra = fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="extra.txt"]');
    expect(notes.classList.contains('is-selected')).toBe(true);
    expect(extra.classList.contains('is-selected')).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('two');
  });

  it('keeps the selected commit when it still exists', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'alpha.txt'), 'alpha line\n');
    git(feature, ['add', 'alpha.txt']);
    git(feature, ['commit', '-m', 'Add alpha']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add alpha"]').click();
    fixture.detectChanges();
    const selected = fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add alpha"]');
    expect(selected.classList.contains('is-selected')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('alpha line');

    writeFileSync(join(feature, 'beta.txt'), 'beta line\n');
    git(feature, ['add', 'beta.txt']);
    git(feature, ['commit', '-m', 'Add beta']);
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-testid="commit"][data-subject="Add beta"]') !== null,
    );

    const alpha = fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add alpha"]');
    const beta = fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Add beta"]');
    expect(alpha.classList.contains('is-selected')).toBe(true);
    expect(beta.classList.contains('is-selected')).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).toContain('alpha line');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]').textContent).not.toContain('beta line');
    expect(
      fixture.nativeElement.querySelector('[data-testid="commit-files"] [data-testid="changed-file"][data-path="alpha.txt"]').classList.contains('is-selected'),
    ).toBe(true);
  });

  it('shows a worktree that appears or disappears while the repository tab stays open', async () => {
    const repoPath = createEmptyRepository(roots);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    expect(branchNames(fixture)).toEqual(['master']);

    const notes = join(repoPath, '.workspaces', 'notes');
    git(repoPath, ['branch', 'notes']);
    git(repoPath, ['worktree', 'add', notes, 'notes']);
    await untilVisible(fixture, (root) => root.querySelector('[data-branch="notes"]') !== null);

    expect(branchNames(fixture)).toEqual(listWorktreeBranches(repoPath).map((branch) => branch.name));
    expect(branchNames(fixture)).toContain('notes');
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);

    git(repoPath, ['worktree', 'remove', notes]);
    await untilVisible(fixture, (root) => root.querySelector('[data-branch="notes"]') === null);

    expect(branchNames(fixture)).toEqual(['master']);
    expect(branchNames(fixture)).toEqual(listWorktreeBranches(repoPath).map((branch) => branch.name));
    expect(git(repoPath, ['branch', '--list', 'notes'])).toBe('notes');
  });

  it('refreshes the default branch and the selected worktree, and leaves the others as they were', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    const zeta = join(repoPath, '.workspaces', 'zeta');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['branch', 'zeta']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    git(repoPath, ['worktree', 'add', zeta, 'zeta']);
    commitAt(repoPath, '2020-01-01T00:00:00Z', 'old master');
    commitAt(feature, '2020-06-01T00:00:00Z', 'feature');
    commitAt(zeta, '2020-03-01T00:00:00Z', 'zeta');
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    expect(branchNames(fixture)).toEqual(['master', 'feature', 'zeta']);

    writeFileSync(join(zeta, 'notes.txt'), 'newer\n');
    const started = Date.now();
    while (Date.now() - started < 800) {
      fixture.detectChanges();
      expect(branchNames(fixture)).toEqual(['master', 'feature', 'zeta']);
      expect(
        fixture.nativeElement.querySelector('[data-branch="zeta"] [data-testid="changed-file-count"]').textContent.trim(),
      ).toBe('0');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    fixture.nativeElement.querySelector('[data-branch="zeta"]').click();
    await untilVisible(fixture, (root) => {
      const names = [...root.querySelectorAll('[data-testid="branch-row"]')].map(
        (row) => row.getAttribute('data-branch') ?? '',
      );
      return (
        names.join(',') === 'master,zeta,feature' &&
        root.querySelector('[data-branch="zeta"] [data-testid="changed-file-count"]')?.textContent?.trim() === '1'
      );
    });

    expect(branchNames(fixture)).toEqual(listWorktreeBranches(repoPath).map((branch) => branch.name));

    writeFileSync(join(repoPath, 'local.txt'), 'on master\n');
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="master"] [data-testid="changed-file-count"]')?.textContent?.trim() === '1',
    );
    expect(
      fixture.nativeElement.querySelector('[data-branch="zeta"] [data-testid="changed-file-count"]').textContent.trim(),
    ).toBe('1');
    expect(
      fixture.nativeElement.querySelector('[data-branch="feature"] [data-testid="changed-file-count"]').textContent.trim(),
    ).toBe('0');
  });

  it('keeps ahead and behind on the remote state already fetched', async () => {
    const repoPath = createEmptyRepository(roots);
    const remotePath = join(repoPath, '..', 'origin.git');
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    git(feature, ['push', '-u', 'origin', 'feature']);
    const otherPath = join(repoPath, '..', 'other');
    execFileSync('git', ['clone', remotePath, otherPath], { stdio: 'ignore' });
    git(otherPath, ['config', 'user.name', 'git-worktree-manager test']);
    git(otherPath, ['config', 'user.email', 'test@git-worktree-manager.local']);
    git(otherPath, ['checkout', 'feature']);
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    addRepository(repoPath, 'Harbor');
    const fixture = await renderRepository(repoPath);
    const featureRow = () => fixture.nativeElement.querySelector('[data-branch="feature"]');
    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');

    const fetched = git(repoPath, ['rev-parse', 'refs/remotes/origin/feature']);
    writeFileSync(join(otherPath, 'remote.txt'), 'from remote\n');
    git(otherPath, ['add', 'remote.txt']);
    git(otherPath, ['commit', '-m', 'remote only']);
    git(otherPath, ['push', 'origin', 'feature']);
    featureRow().click();
    fixture.detectChanges();
    writeFileSync(join(feature, 'local.txt'), 'local\n');
    await untilVisible(
      fixture,
      (root) => root.querySelector('[data-branch="feature"] [data-testid="changed-file-count"]')?.textContent?.trim() === '1',
    );

    expect(featureRow().querySelector('[data-testid="ahead"]').textContent.trim()).toBe('0');
    expect(featureRow().querySelector('[data-testid="behind"]').textContent.trim()).toBe('0');
    expect(git(repoPath, ['rev-parse', 'refs/remotes/origin/feature'])).toBe(fetched);
    expect(fixture.nativeElement.querySelector('[data-testid="repository-tab"]').getAttribute('data-path')).toBe(repoPath);
  });

  describe('diff folds', () => {
    it('shows a middle fold and reveals three lines at each edge', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const lines = Array.from({ length: 24 }, (_, index) => `n${String(index + 1).padStart(2, '0')}`);
      writeFileSync(join(feature, 'notes.txt'), `${lines.join('\n')}\n`);
      git(feature, ['add', 'notes.txt']);
      git(feature, ['commit', '-m', 'Add notes']);
      lines[4] = 'N05';
      lines[19] = 'N20';
      writeFileSync(join(feature, 'notes.txt'), `${lines.join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="notes.txt"]').click();
      fixture.detectChanges();

      const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
      const fold = foldWithCount(diff, '8 hidden lines');
      expect(fold.querySelector('[data-testid="diff-fold-more"]')?.textContent).toBe('3 more lines');
      expect(fold.querySelector('[data-testid="diff-fold-all"]')?.textContent).toBe('All lines');
      expect(diff.textContent).toContain('n04');
      expect(diff.textContent).toContain('n17');
      expect(diff.textContent).not.toContain('n09');
      expect(diff.textContent).not.toContain('n16');

      (fold.querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(diff.textContent).toContain('n09');
      expect(diff.textContent).toContain('n11');
      expect(diff.textContent).toContain('n14');
      expect(diff.textContent).toContain('n16');
      expect(diff.textContent).not.toContain('n12');
      expect(foldWithCount(diff, '2 hidden lines')).toBeTruthy();
    });

    it('opens a fold of six hidden lines and reveals three lines at the start and the end', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const middle = Array.from({ length: 21 }, (_, index) => `m${String(index + 1).padStart(2, '0')}`);
      middle[4] = 'M05';
      middle[17] = 'M18';
      writeFileSync(join(feature, 'middle.txt'), `${middle.join('\n')}\n`);
      const edges = Array.from({ length: 18 }, (_, index) => `e${String(index + 1).padStart(2, '0')}`);
      edges[9] = 'E10';
      writeFileSync(join(feature, 'edges.txt'), `${edges.join('\n')}\n`);
      git(feature, ['add', 'middle.txt', 'edges.txt']);
      git(feature, ['commit', '-m', 'Add the folds']);
      middle[4] = 'm05';
      middle[17] = 'm18';
      edges[9] = 'e10';
      writeFileSync(join(feature, 'middle.txt'), `${middle.join('\n')}\n`);
      writeFileSync(join(feature, 'edges.txt'), `${edges.join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();

      fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="middle.txt"]').click();
      fixture.detectChanges();
      let diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
      (foldWithCount(diff, '6 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(diff.textContent).toContain('m09');
      expect(diff.textContent).toContain('m14');
      expect(diff.querySelector('[data-testid="diff-fold-count"]')?.textContent).not.toBe('6 hidden lines');
      expect([...diff.querySelectorAll('[data-testid="diff-fold-count"]')].map((node) => node.textContent)).not.toContain(
        '6 hidden lines',
      );

      fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="edges.txt"]').click();
      fixture.detectChanges();
      diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
      expect(diff.textContent).not.toContain('e01');
      expect(diff.textContent).not.toContain('e18');
      (foldWithCount(diff, '6 hidden lines').querySelector('[data-testid="diff-fold-all"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(diff.textContent).toContain('e01');
      expect(diff.textContent).toContain('e06');
      expect([...diff.querySelectorAll('[data-testid="diff-fold-count"]')].map((node) => node.textContent)).not.toContain(
        '6 hidden lines',
      );
      (foldWithCount(diff, '5 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(diff.textContent).toContain('e14');
      expect(diff.textContent).toContain('e16');
      expect(diff.textContent).not.toContain('e18');
      expect(foldWithCount(diff, '2 hidden lines')).toBeTruthy();
    });

    it('keeps opened folds for the same file and starts folded for another file, a changed file, and the next launch', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const notes = Array.from({ length: 24 }, (_, index) => `n${String(index + 1).padStart(2, '0')}`);
      const other = Array.from({ length: 24 }, (_, index) => `o${String(index + 1).padStart(2, '0')}`);
      writeFileSync(join(feature, 'notes.txt'), `${notes.join('\n')}\n`);
      writeFileSync(join(feature, 'other.txt'), `${other.join('\n')}\n`);
      git(feature, ['add', 'notes.txt', 'other.txt']);
      git(feature, ['commit', '-m', 'Add both files']);
      notes[4] = 'N05';
      notes[19] = 'N20';
      other[4] = 'O05';
      other[19] = 'O20';
      writeFileSync(join(feature, 'notes.txt'), `${notes.join('\n')}\n`);
      writeFileSync(join(feature, 'other.txt'), `${other.join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      openBranchFile(fixture, 'notes.txt');
      (foldWithCount(diffPane(fixture), '8 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(diffPane(fixture).textContent).toContain('n09');

      openBranchFile(fixture, 'other.txt');
      expect(diffPane(fixture).textContent).not.toContain('o09');
      expect(foldWithCount(diffPane(fixture), '8 hidden lines')).toBeTruthy();

      openBranchFile(fixture, 'notes.txt');
      expect(diffPane(fixture).textContent).toContain('n09');
      expect(foldWithCount(diffPane(fixture), '2 hidden lines')).toBeTruthy();

      fixture.destroy();
      const relaunched = await renderRepository(repoPath);
      openBranchFile(relaunched, 'notes.txt');
      expect(diffPane(relaunched).textContent).not.toContain('n09');
      expect(foldWithCount(diffPane(relaunched), '8 hidden lines')).toBeTruthy();

      (foldWithCount(diffPane(relaunched), '8 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      relaunched.detectChanges();
      expect(diffPane(relaunched).textContent).toContain('n09');
      writeFileSync(join(feature, 'notes.txt'), readFileSync(join(feature, 'notes.txt'), 'utf8').replace('n24\n', 'Z24\n'));
      await untilVisible(relaunched, (root) => {
        const diff = root.querySelector('[data-testid="diff"]');
        return diff?.textContent?.includes('n09') !== true && foldCount(diff, '8 hidden lines');
      });
      expect(diffPane(relaunched).textContent).not.toContain('n09');
      expect(foldWithCount(diffPane(relaunched), '8 hidden lines')).toBeTruthy();
    });

    it('leaves a huge fold closed and still opens three lines and a smaller fold', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const head = ['lead-1', 'lead-2', 'lead-3', 'lead-4', 'near-1', 'near-2', 'near-3', 'before', 'near-4', 'near-5', 'near-6'];
      const tail = Array.from({ length: 100004 }, (_, index) => `tail-${index + 1}`);
      writeFileSync(join(feature, 'huge.txt'), `${[...head, ...tail].join('\n')}\n`);
      git(feature, ['add', 'huge.txt']);
      git(feature, ['commit', '-m', 'Add the huge file']);
      head[7] = 'after';
      writeFileSync(join(feature, 'huge.txt'), `${[...head, ...tail].join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      openBranchFile(fixture, 'huge.txt');
      const diff = diffPane(fixture);
      const large = foldWithCount(diff, '100004 hidden lines');
      (large.querySelector('[data-testid="diff-fold-all"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(large.querySelector('[data-testid="diff-fold-too-large"]')?.textContent).toBe('This file is too large to show');
      expect(lineCodes(diff)).toContain('after');
      expect(lineCodes(diff)).not.toContain('tail-1');
      expect(foldWithCount(diff, '100004 hidden lines')).toBeTruthy();

      (foldWithCount(diff, '100004 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(lineCodes(diff)).toEqual(expect.arrayContaining(['tail-1', 'tail-2', 'tail-3']));
      expect(lineCodes(diff)).not.toContain('tail-4');
      expect(foldWithCount(diff, '100001 hidden lines').querySelector('[data-testid="diff-fold-too-large"]')?.textContent).toBe(
        'This file is too large to show',
      );

      (foldWithCount(diff, '4 hidden lines').querySelector('[data-testid="diff-fold-all"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(lineCodes(diff)).toEqual(expect.arrayContaining(['lead-1', 'lead-2', 'lead-3', 'lead-4', 'after']));
      expect(lineCodes(diff)).not.toContain('tail-4');
      expect(foldWithCount(diff, '100001 hidden lines')).toBeTruthy();
    });

    it('draws a fold only when that fold is in view', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const lines = Array.from({ length: 30 }, (_, index) => `row-${String(index).padStart(2, '0')}`);
      writeFileSync(join(feature, 'long.txt'), `${lines.join('\n')}\n`);
      git(feature, ['add', 'long.txt']);
      git(feature, ['commit', '-m', 'Add the long file']);
      lines[0] = 'ROW-00';
      writeFileSync(join(feature, 'long.txt'), `${lines.join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      openBranchFile(fixture, 'long.txt');
      const diff = diffPane(fixture);
      expect(diff.querySelector('[data-testid="diff-fold"]')).not.toBeNull();
      installScrollMetrics(diff, { clientHeight: 40, scrollHeight: 400, scrollTop: 0 });
      diff.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      expect(diff.querySelector('[data-testid="diff-fold"]')).toBeNull();
      expect(diff.textContent).toContain('row-00');

      installScrollMetrics(diff, { clientHeight: 40, scrollHeight: 400, scrollTop: 120 });
      diff.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      expect(diff.querySelector('[data-testid="diff-fold"]')).not.toBeNull();
      expect(diff.textContent).not.toContain('row-00');
    });

    it('reveals a commit fold from the parent file rather than the dirty checkout', async () => {
      const repoPath = createEmptyRepository(roots);
      const feature = join(repoPath, '.workspaces', 'feature');
      git(repoPath, ['branch', 'feature']);
      git(repoPath, ['worktree', 'add', feature, 'feature']);
      const notes = ['same', 'keep-2', 'keep-3', 'keep-4', 'keep-5', 'keep-6', 'keep-7', 'old', 'keep-9', 'keep-10'];
      writeFileSync(join(feature, 'notes.txt'), `${notes.join('\n')}\n`);
      git(feature, ['add', 'notes.txt']);
      git(feature, ['commit', '-m', 'Add the notes']);
      notes[7] = 'new';
      writeFileSync(join(feature, 'notes.txt'), `${notes.join('\n')}\n`);
      git(feature, ['add', 'notes.txt']);
      git(feature, ['commit', '-m', 'Edit the notes']);
      writeFileSync(join(feature, 'notes.txt'), `${['dirty', ...notes.slice(1)].join('\n')}\n`);
      const fixture = await renderRepository(repoPath);
      fixture.nativeElement.querySelector('[data-branch="feature"]').click();
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Edit the notes"]').click();
      fixture.detectChanges();
      const diff = diffPane(fixture);
      (foldWithCount(diff, '4 hidden lines').querySelector('[data-testid="diff-fold-all"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(lineCodes(diff)).toContain('same');
      expect(lineCodes(diff)).not.toContain('dirty');
    });
  });
});

function openBranchFile(fixture: { nativeElement: HTMLElement; detectChanges(): void }, path: string): void {
  const branch = fixture.nativeElement.querySelector('[data-branch="feature"]');
  if (!branch?.classList.contains('is-selected')) {
    branch?.click();
    fixture.detectChanges();
  }
  const file = fixture.nativeElement.querySelector(`[data-testid="changed-file"][data-path="${path}"]`);
  if (!(file instanceof HTMLElement)) {
    throw new Error(`missing file ${path}`);
  }
  file.click();
  fixture.detectChanges();
}

function diffPane(fixture: { nativeElement: HTMLElement }): HTMLElement {
  const diff = fixture.nativeElement.querySelector('[data-testid="diff"]');
  if (!(diff instanceof HTMLElement)) {
    throw new Error('missing diff');
  }
  return diff;
}

function lineCodes(diff: ParentNode): string[] {
  return [...diff.querySelectorAll('[data-testid="diff-line"] .diff-code')].map((node) => node.textContent ?? '');
}

function foldCount(diff: ParentNode | null, count: string): boolean {
  if (!diff) {
    return false;
  }
  return [...diff.querySelectorAll('[data-testid="diff-fold-count"]')].some((node) => node.textContent === count);
}

function foldWithCount(diff: ParentNode, count: string): HTMLElement {
  const fold = [...diff.querySelectorAll('[data-testid="diff-fold"]')].find(
    (row) => row.querySelector('[data-testid="diff-fold-count"]')?.textContent === count,
  );
  if (!(fold instanceof HTMLElement)) {
    throw new Error(`missing fold ${count}`);
  }
  return fold;
}

async function confirmKeepBranch(fixture: {
  detectChanges(): void;
  nativeElement: HTMLElement;
}): Promise<void> {
  fixture.detectChanges();
  const dialog = fixture.nativeElement.querySelector('[data-testid="remove-worktree-dialog"]');
  (dialog.querySelector('[data-testid="confirm-remove-worktree"]') as HTMLButtonElement).click();
  await untilVisible(fixture, (root) => root.querySelector('[data-testid="remove-worktree-dialog"]') === null);
}

async function untilVisible(
  fixture: { detectChanges(): void; nativeElement: HTMLElement },
  ready: (root: HTMLElement) => boolean,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    fixture.detectChanges();
    if (ready(fixture.nativeElement)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  fixture.detectChanges();
}

function paneTrack(element: HTMLElement, property: 'gridTemplateColumns' | 'gridTemplateRows'): number {
  return Number.parseFloat(element.style[property]);
}

function dockTerminalSection(root: ParentNode): void {
  const button = root.querySelector('[data-testid="terminal-collapse"]');
  if (button instanceof HTMLElement && button.getAttribute('aria-label') === 'Expand terminal') {
    button.click();
  }
}

function startTerminal(root: ParentNode): void {
  const button = root.querySelector('[data-testid="terminal-new"]');
  if (!(button instanceof HTMLElement)) {
    throw new Error('New is not shown');
  }
  button.click();
}

function terminalSectionHeight(body: HTMLElement): number {
  const match = /(\d+)px\s*$/.exec(body.style.gridTemplateRows);
  if (!match?.[1]) {
    throw new Error(`Terminal section height is missing from ${body.style.gridTemplateRows}`);
  }
  return Number(match[1]);
}

function dragDivider(split: HTMLElement, start: { x: number; y: number }, end: { x: number; y: number }): void {
  split.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y }));
  split.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: end.x, clientY: end.y }));
  split.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: end.x, clientY: end.y }));
}

function doubleClickDivider(split: HTMLElement): void {
  split.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function sheetSection(element: HTMLElement): HTMLElement {
  const boundary = element.closest('.sheet-stack') ?? element.closest('.sheet-columns');
  let current: HTMLElement | null = element;
  while (current && current.parentElement !== boundary) {
    current = current.parentElement;
  }
  return current ?? element;
}

function blockTop(element: HTMLElement): number {
  return placedBlock(element).top;
}

function blockBottom(element: HTMLElement): number {
  return placedBlock(element).bottom;
}

function placedBlock(element: HTMLElement): { top: number; bottom: number } {
  const rect = element.getBoundingClientRect();
  if (rect.height !== 0 || rect.width !== 0) {
    return { top: rect.top, bottom: rect.bottom };
  }
  const parent = element.parentElement;
  if (!parent) {
    return { top: 0, bottom: 0 };
  }
  const siblings = [...parent.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const index = Math.max(0, siblings.indexOf(element));
  if (stacksVertically(getComputedStyle(parent))) {
    return { top: index, bottom: index + 1 };
  }
  return { top: 0, bottom: 1 };
}

function stacksVertically(style: CSSStyleDeclaration): boolean {
  const display = style.display;
  if (display === 'flex' || display === 'inline-flex') {
    return style.flexDirection === 'column' || style.flexDirection === 'column-reverse';
  }
  if (display === 'grid' || display === 'inline-grid') {
    return columnTrackCount(style.gridTemplateColumns) <= 1;
  }
  return display === 'block' || display === 'flow-root';
}

function columnTrackCount(columns: string): number {
  const value = columns.trim();
  if (value === '' || value === 'none') {
    return 1;
  }
  let depth = 0;
  let tracks = 0;
  let token = '';
  for (const char of value) {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (/\s/.test(char) && depth === 0) {
      if (token.trim() !== '') {
        tracks += 1;
      }
      token = '';
    } else {
      token += char;
    }
  }
  if (token.trim() !== '') {
    tracks += 1;
  }
  return tracks;
}

function pickColor(input: Element | null, color: string): void {
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('missing color input');
  }
  input.value = color;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('change'));
}

function layoutChoice(dialog: ParentNode, name: string): HTMLInputElement {
  const label = [...dialog.querySelectorAll('label')].find((item) => item.textContent.trim() === name);
  const input = label?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`missing layout choice ${name}`);
  }
  return input;
}

function boxEdge(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rightEdge(element: HTMLElement): number {
  const box = element.getBoundingClientRect();
  if (box.width > 0) {
    return box.right;
  }
  const heading = element.closest('.branch-heading');
  if (!(heading instanceof HTMLElement)) {
    return box.right;
  }
  const row = [...heading.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.contains(element) && isHorizontalRow(getComputedStyle(child)),
  );
  if (!row) {
    return box.right;
  }
  const items = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const index = items.findIndex((item) => item.contains(element));
  return index + 1;
}

function isHorizontalRow(style: CSSStyleDeclaration): boolean {
  if (style.display !== 'flex' && style.display !== 'inline-flex') {
    return false;
  }
  return style.flexDirection !== 'column' && style.flexDirection !== 'column-reverse';
}

function horizontalGap(left: HTMLElement, right: HTMLElement): number {
  const leftBox = left.getBoundingClientRect();
  const rightBox = right.getBoundingClientRect();
  if (leftBox.width > 0 && rightBox.width > 0) {
    return rightBox.left - leftBox.right;
  }
  const parent = left.parentElement;
  if (!parent || parent !== right.parentElement) {
    return 0;
  }
  const parentStyle = getComputedStyle(parent);
  const gap = Number.parseFloat(parentStyle.columnGap);
  const between = Number.isFinite(gap) ? gap : 0;
  return between + boxEdge(getComputedStyle(left).marginRight) + boxEdge(getComputedStyle(right).marginLeft);
}

function openWorktreeMenu(row: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 32,
    clientY: 18,
  });
  row.dispatchEvent(event);
  return event;
}

function branchNames(fixture: { nativeElement: HTMLElement }): string[] {
  return [...fixture.nativeElement.querySelectorAll('[data-testid="branch-row"]')].map(
    (row) => row.getAttribute('data-branch') ?? '',
  );
}

function rowText(rows: Element[], testId: string): string[] {
  return rows.map((row) => row.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '');
}

function commitSubjects(list: Element): string[] {
  return [...list.querySelectorAll('[data-testid="commit"]')].map(
    (commit) => commit.getAttribute('data-subject') ?? '',
  );
}

function expectContentSheetCorners(sheet: HTMLElement): void {
  const style = getComputedStyle(sheet);
  expect(Number.parseFloat(style.borderRadius)).toBeGreaterThanOrEqual(4);
  expect(style.overflow).toBe('hidden');
}

function expectOverlayScrollbarsClipped(sheet: HTMLElement): void {
  expect(Number.parseFloat(getComputedStyle(sheet).paddingRight) || 0).toBe(0);
  const scrollbars = [...sheet.querySelectorAll('[data-testid="overlay-scrollbar"]')];
  expect(scrollbars.length).toBeGreaterThan(0);
  for (const scrollbar of scrollbars) {
    expect(sheet.contains(scrollbar)).toBe(true);
    expect(getComputedStyle(scrollbar).position).toBe('absolute');
  }
}

function expectDialogActionsOnTheRight(actions: Element | null): void {
  expect(actions).toBeInstanceOf(HTMLElement);
  if (!(actions instanceof HTMLElement)) {
    return;
  }
  expect(getComputedStyle(actions).justifyContent).toBe('flex-end');
  expect(actions.querySelector('button')).not.toBeNull();
}

function expectDialogWindowInset(panel: Element | null): void {
  expect(panel).toBeInstanceOf(HTMLElement);
  if (!(panel instanceof HTMLElement)) {
    return;
  }
  const style = getComputedStyle(panel);
  expect(style.boxSizing).toBe('border-box');
  expect(style.maxHeight).toBe('calc(100vh - 64px)');
}

async function expectOverlayScrollbar(region: HTMLElement | null): Promise<void> {
  expect(region).toBeInstanceOf(HTMLElement);
  if (!(region instanceof HTMLElement)) {
    return;
  }
  expect(getComputedStyle(region).scrollbarWidth).toBe('none');
  expect(getComputedStyle(region).scrollbarGutter).not.toBe('stable');
  installScrollMetrics(region, { clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
  const thumb = region.querySelector('[data-testid="overlay-scrollbar"]') as HTMLElement;
  expect(thumb).not.toBeNull();

  vi.useFakeTimers();
  region.dispatchEvent(new Event('scroll'));
  expect(thumb.classList.contains('is-visible')).toBe(false);
  await vi.advanceTimersByTimeAsync(700);

  installScrollMetrics(region, { clientHeight: 100, scrollHeight: 400, scrollTop: 0 });
  region.dispatchEvent(new Event('pointerenter'));
  expect(thumb.classList.contains('is-visible')).toBe(false);
  region.dispatchEvent(new Event('scroll'));
  expect(thumb.classList.contains('is-visible')).toBe(true);
  const thumbStyle = getComputedStyle(thumb);
  expect(thumbStyle.opacity).toBe('1');
  expect(thumbStyle.position).toBe('absolute');
  expect(Number.parseFloat(thumbStyle.width)).toBeLessThanOrEqual(8);
  expect(Number.parseFloat(thumbStyle.width)).toBeGreaterThan(0);
  expect(opacityTransitionMs(thumbStyle)).toBeGreaterThan(0);

  region.dispatchEvent(new Event('pointerleave'));
  expect(thumb.classList.contains('is-visible')).toBe(true);
  await vi.advanceTimersByTimeAsync(700);
  expect(thumb.classList.contains('is-visible')).toBe(false);
  expect(getComputedStyle(thumb).opacity).toBe('0');
  expect(opacityTransitionMs(getComputedStyle(thumb))).toBeGreaterThan(opacityTransitionMs(thumbStyle));
  vi.useRealTimers();
}

function opacityTransitionMs(style: CSSStyleDeclaration): number {
  const match = /(?:^|,)\s*opacity\s+(\d+(?:\.\d+)?)(ms|s)\b/.exec(style.transition);
  if (!match) {
    return 0;
  }
  const value = Number.parseFloat(match[1] ?? '');
  return match[2] === 'ms' ? value : value * 1000;
}

function installScrollMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
): void {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
}

function scrollCommitList(
  list: Element,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  if (list instanceof HTMLElement) {
    list.scrollTop = metrics.scrollTop;
  }
  list.dispatchEvent(new Event('scroll'));
}

function commitCountFailureDir(roots: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-worktree-manager-count-fail-'));
  roots.push(dir);
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  echo "count failed" >&2
  exit 1
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  );
  return dir;
}

function createLongFeatureRepository(roots: string[]): string {
  const repoPath = createEmptyRepository(roots);
  git(repoPath, ['checkout', '-b', 'feature']);
  for (let number = 1; number <= 31; number += 1) {
    const label = String(number).padStart(2, '0');
    writeFileSync(join(repoPath, 'note.txt'), `${label}\n`);
    git(repoPath, ['add', 'note.txt']);
    commitWithDate(repoPath, `Feature ${label}`, number);
  }
  git(repoPath, ['checkout', 'master']);
  git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'feature'), 'feature']);
  return repoPath;
}

function createLongHistoryRepository(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
  roots.push(root);
  const repoPath = join(root, 'harbor');
  initGitRepo(repoPath);
  writeFileSync(join(repoPath, 'note.txt'), 'init\n');
  git(repoPath, ['add', '.']);
  commitWithDate(repoPath, 'init', 0);
  for (let number = 1; number <= 30; number += 1) {
    const label = String(number).padStart(2, '0');
    writeFileSync(join(repoPath, 'note.txt'), `${label}\n`);
    git(repoPath, ['add', 'note.txt']);
    commitWithDate(repoPath, `Record ${label}`, number);
  }
  return repoPath;
}

function commitWithDate(repoPath: string, message: string, second: number): void {
  const date = `2030-01-01T00:00:${String(second).padStart(2, '0')}+0000`;
  execFileSync('git', ['commit', '-m', message], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function createRepositoryWithDeletedRemoteBranches(roots: string[]): string {
  const repoPath = createEmptyRepository(roots);
  const origin = join(repoPath, '..', 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
  git(repoPath, ['remote', 'add', 'origin', origin]);
  git(repoPath, ['push', '-u', 'origin', 'master']);

  const committedAt = git(repoPath, ['log', '-1', '--format=%cI']);
  const commit = (message: string): void => {
    execFileSync('git', ['commit', '-m', message], {
      cwd: repoPath,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: committedAt,
        GIT_COMMITTER_DATE: committedAt,
      },
    });
  };

  git(repoPath, ['checkout', '-b', 'kept']);
  git(repoPath, ['checkout', '-b', 'tracked']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'tracked\n');
  git(repoPath, ['add', 'tracked.txt']);
  commit('track');
  git(repoPath, ['push', '-u', 'origin', 'tracked']);

  git(repoPath, ['checkout', '-b', 'gone']);
  writeFileSync(join(repoPath, 'gone.txt'), 'gone\n');
  git(repoPath, ['add', 'gone.txt']);
  commit('gone');
  git(repoPath, ['push', '-u', 'origin', 'gone']);

  git(repoPath, ['checkout', '-b', 'still-remote']);
  writeFileSync(join(repoPath, 'still.txt'), 'still\n');
  git(repoPath, ['add', 'still.txt']);
  commit('still');
  git(repoPath, ['push', '-u', 'origin', 'still-remote']);

  git(repoPath, ['checkout', 'master']);
  git(repoPath, ['branch', '-D', 'gone']);
  git(repoPath, ['branch', '-D', 'still-remote']);
  execFileSync('git', ['--git-dir', origin, 'branch', '-D', 'tracked', 'gone'], { stdio: 'ignore' });
  return repoPath;
}

function createPickerRepository(roots: string[]): string {
  const repoPath = createEmptyRepository(roots);
  const root = join(repoPath, '..');
  git(repoPath, ['branch', 'plain']);
  git(repoPath, ['branch', 'taken']);
  git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'taken'), 'taken']);
  const origin = join(root, 'origin.git');
  const upstream = join(root, 'upstream.git');
  execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', '-b', 'master', upstream], { stdio: 'ignore' });
  git(repoPath, ['remote', 'add', 'origin', origin]);
  git(repoPath, ['remote', 'add', 'upstream', upstream]);
  git(repoPath, ['checkout', '-b', 'shipped']);
  git(repoPath, ['push', 'origin', 'shipped']);
  git(repoPath, ['push', 'upstream', 'shipped']);
  git(repoPath, ['checkout', '-b', 'only-upstream']);
  writeFileSync(join(repoPath, 'only.txt'), 'only\n');
  git(repoPath, ['add', 'only.txt']);
  git(repoPath, ['commit', '-m', 'only upstream']);
  git(repoPath, ['push', 'upstream', 'only-upstream']);
  git(repoPath, ['checkout', 'master']);
  git(repoPath, ['branch', '-D', 'shipped']);
  git(repoPath, ['branch', '-D', 'only-upstream']);
  return repoPath;
}

function createEmptyRepository(roots: string[], branch = 'master'): string {
  const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
  roots.push(root);
  const repoPath = join(root, 'harbor');
  initGitRepo(repoPath, branch);
  writeFileSync(join(repoPath, 'README.md'), '# harbor\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'init']);
  return repoPath;
}

function createRewriteRepository(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-desktop-'));
  roots.push(root);
  const repoPath = join(root, 'harbor');
  mkdirSync(join(repoPath, 'docs'), { recursive: true });
  initGitRepo(repoPath);
  writeFileSync(join(repoPath, 'docs', 'old-guide.md'), 'harbor notes\nold guide\nkeep the rest\n');
  writeFileSync(join(repoPath, '.gitattributes'), '*.png binary\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'Add the old guide']);
  git(repoPath, ['checkout', '-b', 'rewrite']);
  git(repoPath, ['mv', 'docs/old-guide.md', 'docs/guide.md']);
  writeFileSync(join(repoPath, 'docs', 'guide.md'), 'harbor notes\nnew guide\nkeep the rest\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'Retitle the guide']);
  mkdirSync(join(repoPath, 'assets'), { recursive: true });
  writeFileSync(join(repoPath, 'assets', 'logo.png'), Buffer.from([0x89]));
  git(repoPath, ['add', 'assets/logo.png']);
  git(repoPath, ['commit', '-m', 'Add the logo']);
  git(repoPath, ['checkout', 'master']);
  git(repoPath, ['worktree', 'add', join(repoPath, '.workspaces', 'rewrite'), 'rewrite']);
  writeFileSync(
    join(repoPath, '.workspaces', 'rewrite', 'docs', 'guide.md'),
    'harbor notes\nnew guide\nkeep the rest\npier note\n',
  );
  return repoPath;
}

function initGitRepo(repoPath: string, branch = 'master'): void {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'git-worktree-manager test'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@git-worktree-manager.local'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAt(cwd: string, date: string, message: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function hasRef(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

describe('checkoutWatchTargets', () => {
  it('watches the checkout and its source directories and leaves dependency directories out', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-watch-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'leftpad'), { recursive: true });
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'dist'));

    const targets = checkoutWatchTargets(root);
    const paths = targets.map((target) => target.path);

    expect(paths).toContain(root);
    expect(targets.find((target) => target.path === root)?.recursive).toBe(false);
    expect(paths).toContain(join(root, 'src'));
    expect(targets.find((target) => target.path === join(root, 'src'))?.recursive).toBe(true);
    expect(paths).toContain(join(root, '.git'));
    expect(targets.find((target) => target.path === join(root, '.git'))?.recursive).toBe(true);
    expect(paths).not.toContain(join(root, 'node_modules'));
    expect(paths).not.toContain(join(root, 'dist'));
    rmSync(root, { recursive: true, force: true });
  });
});

function holdPaint(): { release(): void } {
  const queued: Array<() => void> = [];
  setAfterPaintScheduler((task) => {
    queued.push(task);
  });
  return {
    release(): void {
      const tasks = queued.splice(0);
      setAfterPaintScheduler((task) => {
        task();
      });
      for (const task of tasks) {
        task();
      }
    },
  };
}

function terminalPaneText(fixture: { nativeElement: HTMLElement }): string {
  return [...fixture.nativeElement.querySelectorAll('[data-testid="terminal-pane"]')]
    .map((pane) => pane.textContent ?? '')
    .join('\n');
}

function submitTerminalCommand(root: HTMLElement, command: string): void {
  const textarea = root.querySelector('.terminal-pane textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('The terminal pane is not accepting input');
  }
  textarea.focus();
  for (const char of command) {
    const keyCode = char === ' ' ? 32 : char === '-' ? 189 : char.toUpperCase().charCodeAt(0);
    textarea.dispatchEvent(terminalKeyEvent('keydown', char, keyCode));
  }
  textarea.dispatchEvent(terminalKeyEvent('keydown', 'Enter', 13));
}

function terminalKeyEvent(type: string, key: string, keyCode: number): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { get: () => keyCode });
  Object.defineProperty(event, 'which', { get: () => keyCode });
  return event;
}

function repositoryTabNames(fixture: { nativeElement: HTMLElement }): string[] {
  return [...fixture.nativeElement.querySelectorAll('[data-testid="repository-tab"]')].map(
    (element) => element.getAttribute('data-name') ?? '',
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellProcessesIn(cwd: string): number[] {
  const wanted = realpathSync(cwd);
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      if (realpathSync(readlinkSync(join('/proc', entry, 'cwd'))) !== wanted) {
        continue;
      }
      const command = readFileSync(join('/proc', entry, 'cmdline')).toString().split('\0')[0] ?? '';
      const name = command.split('/').pop() ?? '';
      if (name !== 'bash' && name !== 'sh' && name !== 'zsh' && name !== 'fish') {
        continue;
      }
      found.push(Number(entry));
    } catch {
      // The process exited while it was being read.
    }
  }
  return found;
}

function remoteUrlValue(root: ParentNode): string {
  const field = root.querySelector('[data-testid="remote-url"]');
  return field instanceof HTMLInputElement ? field.value : '';
}

describe('full file diff', () => {
  const roots: string[] = [];
  const previousRegistryPath = process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
  const previousAppSettingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;

  beforeEach(() => {
    const settingsRoot = mkdtempSync(join(tmpdir(), 'git-worktree-manager-full-file-settings-'));
    roots.push(settingsRoot);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(settingsRoot, 'app-settings.json');
  });

  afterEach(() => {
    setAfterPaintScheduler((task) => {
      task();
    });
    if (previousRegistryPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = previousRegistryPath;
    }
    if (previousAppSettingsPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = previousAppSettingsPath;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function renderRepository(repoPath: string) {
    if (!process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH) {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    }
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceComponent);
    fixture.componentRef.setInput('repositoryPath', repoPath);
    fixture.detectChanges();
    await fixture.whenStable();
    await whenRemoteRefreshIdle();
    fixture.detectChanges();
    return fixture;
  }

  function openChangedFile(fixture: ComponentFixture<WorkspaceComponent>, branch: string, path: string): void {
    fixture.nativeElement.querySelector(`[data-branch="${branch}"]`).click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector(`[data-testid="changed-file"][data-path="${path}"]`).click();
    fixture.detectChanges();
  }

  it('starts on Folded and shows every colored line when Full file is chosen', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n');
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');

    const folded = fixture.nativeElement.querySelector('[data-testid="diff-mode-folded"]') as HTMLButtonElement;
    const full = fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement;
    expect(folded.textContent?.trim()).toBe('Folded');
    expect(full.textContent?.trim()).toBe('Full file');
    expect(folded.getAttribute('aria-pressed')).toBe('true');
    expect(full.getAttribute('aria-pressed')).toBe('false');
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.contains(fixture.nativeElement.querySelector('[data-testid="diff-mode"]'))).toBe(false);
    expect(diff.textContent).not.toContain('one');
    expect(diff.textContent).not.toContain('ten');
    expect(diff.querySelector('[data-testid="diff-fold"]')).not.toBeNull();

    full.click();
    fixture.detectChanges();

    const shown = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(shown.textContent).toContain('one');
    expect(shown.textContent).toContain('ten');
    expect(shown.textContent).toContain('FIVE');
    expect(shown.querySelector('[data-testid="diff-fold"]')).toBeNull();
    const removed = [...shown.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'removed',
    ) as HTMLElement;
    const added = [...shown.querySelectorAll('[data-testid="diff-line"]')].find(
      (line) => line.getAttribute('data-kind') === 'added',
    ) as HTMLElement;
    const removedWord = removed.querySelector('[data-changed="true"]') as HTMLElement;
    expect(removedWord.textContent).toBe('five');
    expect(getComputedStyle(removed).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(getComputedStyle(added).backgroundColor).toBe('rgb(215, 255, 230)');
    expect(getComputedStyle(removedWord).backgroundColor).not.toBe(getComputedStyle(removed).backgroundColor);
    expect(readAppSettings().diffMode).toBe('full');
  });

  it('keeps Full file for the next file and the next launch', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    writeFileSync(join(feature, 'other.txt'), 'kept-start\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nkept-end\n');
    git(feature, ['add', 'notes.txt', 'other.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n');
    writeFileSync(join(feature, 'other.txt'), 'kept-start\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nkept-end\n');
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="other.txt"]').click();
    fixture.detectChanges();

    const next = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(next.textContent).toContain('kept-start');
    expect(next.textContent).toContain('kept-end');
    expect((fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fixture.destroy();

    const again = await renderRepository(repoPath);
    openChangedFile(again, 'feature', 'other.txt');
    const restored = again.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(restored.textContent).toContain('kept-start');
    expect(restored.textContent).toContain('kept-end');
    expect((again.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(readAppSettings().diffMode).toBe('full');
  });

  it('shows every line of a commit file', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Edit notes']);
    const fixture = await renderRepository(repoPath);
    fixture.nativeElement.querySelector('[data-branch="feature"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="commit"][data-subject="Edit notes"]').click();
    fixture.detectChanges();

    const folded = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(folded.textContent).not.toContain('one');
    expect(folded.textContent).not.toContain('ten');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const full = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(full.textContent).toContain('one');
    expect(full.textContent).toContain('ten');
    expect(full.textContent).toContain('FIVE');
    expect(full.querySelector('[data-testid="diff-fold"]')).toBeNull();
  });

  it('draws only the full-file lines in view', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const body = Array.from({ length: 40 }, (_, index) => `row-${String(index).padStart(2, '0')}`).join('\n');
    writeFileSync(join(feature, 'long.txt'), `${body}\n`);
    git(feature, ['add', 'long.txt']);
    git(feature, ['commit', '-m', 'Add long']);
    writeFileSync(join(feature, 'long.txt'), `${body.replace('row-20', 'ROW-20')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'long.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const line = diff.querySelector('[data-testid="diff-line"]') as HTMLElement;
    const rowHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
    expect(diff.textContent).toContain('row-00');
    expect(diff.textContent).toContain('row-39');
    installScrollMetrics(diff, {
      clientHeight: rowHeight * 2,
      scrollHeight: rowHeight * 40,
      scrollTop: rowHeight * 30,
    });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(diff.textContent).not.toContain('row-00');
    expect(diff.textContent).toContain('row-30');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]')).not.toBeNull();
    expect(diff.contains(fixture.nativeElement.querySelector('[data-testid="diff-mode"]'))).toBe(false);
  });

  it('shows only that a file over 100,000 lines is too large, then Folded brings the diff back', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const lines = Array.from({ length: 100_001 }, (_, index) => `row-${index}`);
    lines[50_000] = 'before-change';
    writeFileSync(join(feature, 'huge.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'huge.txt']);
    git(feature, ['commit', '-m', 'Add huge']);
    lines[50_000] = 'after-change';
    writeFileSync(join(feature, 'huge.txt'), `${lines.join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'huge.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="diff"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-too-large"]')?.textContent?.trim()).toBe(
      'This file is too large to show',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]')).not.toBeNull();
    expect(readAppSettings().diffMode).toBe('full');

    (fixture.nativeElement.querySelector('[data-testid="diff-mode-folded"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const folded = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(fixture.nativeElement.querySelector('[data-testid="diff-too-large"]')).toBeNull();
    expect(folded.textContent).toContain('after-change');
    expect(folded.textContent).not.toContain('row-0');
    expect(readAppSettings().diffMode).toBe('folded');
  });

  it('shows only that a side over 2 MiB is too large and keeps Full file', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const line = 'a'.repeat(200);
    const count = Math.ceil((2 * 1024 * 1024 + 1) / (line.length + 1));
    const lines = Array.from({ length: count }, () => line);
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'wide.txt']);
    git(feature, ['commit', '-m', 'Add wide']);
    lines[0] = `b${'a'.repeat(199)}`;
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'wide.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-too-large"]')?.textContent?.trim()).toBe(
      'This file is too large to show',
    );
    expect(readAppSettings().diffMode).toBe('full');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-folded"]')).not.toBeNull();
  });

  it('reveals the real lines of a fold when the file is over 2 MiB', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const filler = 'x'.repeat(200);
    const lines = [
      'before',
      'c2',
      'c3',
      'c4',
      'edge-a',
      'edge-b',
      'edge-c',
      'mid-8',
      'mid-9',
      'mid-10',
      'mid-11',
      'mid-12',
      'mid-13',
      'edge-d',
      'edge-e',
      'edge-f',
      'c17',
      'c18',
      'c19',
      'before-b',
      'c21',
      'c22',
      'c23',
    ];
    while (Buffer.byteLength(`${lines.join('\n')}\n`) <= 2 * 1024 * 1024) {
      lines.push(filler);
    }
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'wide.txt']);
    git(feature, ['commit', '-m', 'Add wide']);
    lines[0] = 'after';
    lines[19] = 'after-b';
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'wide.txt');

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.textContent).not.toContain('edge-a');
    expect(diff.textContent).not.toContain('edge-f');
    (foldWithCount(diff, '12 hidden lines').querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(diff.textContent).toContain('edge-a');
    expect(diff.textContent).toContain('edge-b');
    expect(diff.textContent).toContain('edge-c');
    expect(diff.textContent).toContain('edge-d');
    expect(diff.textContent).toContain('edge-e');
    expect(diff.textContent).toContain('edge-f');
  });

  it('keeps the switch visible when the diff is only a sentence', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="README.md"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="empty-diff"]')?.textContent?.trim()).toBe(
      'No diff for this file',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-folded"]')?.textContent?.trim()).toBe('Folded');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]')?.textContent?.trim()).toBe('Full file');

    fixture.nativeElement.querySelector('[data-branch="rename-docs"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="docs/guide.md"]').click();
    fixture.detectChanges();

    const renamed = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(renamed.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from docs/old-guide.md');
    expect(renamed.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(renamed.contains(fixture.nativeElement.querySelector('[data-testid="diff-mode"]'))).toBe(false);

    fixture.nativeElement.querySelector('[data-branch="abandoned"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="assets/logo.png"]').click();
    fixture.detectChanges();

    const binary = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(binary.querySelector('[data-testid="diff-binary"]')?.textContent).toBe('Binary file');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode"]')).not.toBeNull();
    expect(binary.contains(fixture.nativeElement.querySelector('[data-testid="diff-mode"]'))).toBe(false);
  });

  it('jumps to the next and previous change in the full file', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const lines = Array.from({ length: 100 }, (_, index) => `row-${index}`);
    lines[30] = 'alpha';
    lines[80] = 'beta';
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'wide.txt']);
    git(feature, ['commit', '-m', 'Add wide']);
    lines[30] = 'ALPHA';
    lines[80] = 'BETA';
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'wide.txt');

    expect(fixture.nativeElement.querySelector('[data-testid="diff-change-nav"]')).toBeNull();

    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    installScrollMetrics(diff, { clientHeight: 40, scrollHeight: 2000, scrollTop: 0 });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    const previous = fixture.nativeElement.querySelector('[data-testid="diff-previous-change"]') as HTMLButtonElement;
    const next = fixture.nativeElement.querySelector('[data-testid="diff-next-change"]') as HTMLButtonElement;
    expect(previous.textContent?.trim()).toBe('Previous change');
    expect(next.textContent?.trim()).toBe('Next change');
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(diff.textContent).toContain('row-0');
    expect(diff.textContent).not.toContain('ALPHA');

    next.click();
    fixture.detectChanges();
    expect(diff.textContent).toContain('ALPHA');
    expect(diff.textContent).not.toContain('BETA');
    expect(diff.textContent).not.toContain('row-0');
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    fixture.detectChanges();
    expect(diff.textContent).toContain('BETA');
    expect(diff.textContent).not.toContain('ALPHA');
    expect(next.disabled).toBe(true);
    expect(previous.disabled).toBe(false);

    previous.click();
    fixture.detectChanges();
    expect(diff.textContent).toContain('ALPHA');
    expect(diff.textContent).not.toContain('BETA');
    expect(next.disabled).toBe(false);

    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    installScrollMetrics(diff, { clientHeight: 40, scrollHeight: 2000, scrollTop: 0 });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    next.click();
    fixture.detectChanges();
    const alpha = sideRowContaining(diff, 'ALPHA');
    expect(alpha.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('alpha');
    expect(alpha.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('ALPHA');
    expect(diff.textContent).not.toContain('BETA');
  });
});

async function render() {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [WorkspaceComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(WorkspaceComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  await whenRemoteRefreshIdle();
  fixture.detectChanges();
  return fixture;
}

describe('side by side diff', () => {
  const roots: string[] = [];
  const previousRegistryPath = process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
  const previousAppSettingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;

  beforeEach(() => {
    const settingsRoot = mkdtempSync(join(tmpdir(), 'git-worktree-manager-side-by-side-settings-'));
    roots.push(settingsRoot);
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(settingsRoot, 'app-settings.json');
  });

  afterEach(() => {
    setAfterPaintScheduler((task) => {
      task();
    });
    if (previousRegistryPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = previousRegistryPath;
    }
    if (previousAppSettingsPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = previousAppSettingsPath;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function renderRepository(repoPath: string) {
    if (!process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH) {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = join(repoPath, '..', 'registry.db');
    }
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceComponent);
    fixture.componentRef.setInput('repositoryPath', repoPath);
    fixture.detectChanges();
    await fixture.whenStable();
    await whenRemoteRefreshIdle();
    fixture.detectChanges();
    return fixture;
  }

  function openChangedFile(fixture: ComponentFixture<WorkspaceComponent>, branch: string, path: string): void {
    fixture.nativeElement.querySelector(`[data-branch="${branch}"]`).click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector(`[data-testid="changed-file"][data-path="${path}"]`).click();
    fixture.detectChanges();
  }

  it('starts on Inline beside Folded and stays outside the scroller', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();

    const inline = fixture.nativeElement.querySelector('[data-testid="diff-layout-inline"]') as HTMLButtonElement;
    const side = fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement;
    expect(inline.textContent?.trim()).toBe('Inline');
    expect(side.textContent?.trim()).toBe('Side by side');
    expect(inline.getAttribute('aria-pressed')).toBe('true');
    expect(side.getAttribute('aria-pressed')).toBe('false');
    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const layout = fixture.nativeElement.querySelector('[data-testid="diff-layout"]') as HTMLElement;
    const mode = fixture.nativeElement.querySelector('[data-testid="diff-mode"]') as HTMLElement;
    expect(diff.contains(layout)).toBe(false);
    expect(diff.contains(mode)).toBe(false);
    expect(layout.parentElement).toBe(mode.parentElement);
    expect(getComputedStyle(layout.parentElement).flexDirection).toBe('row');
    expect(diff.querySelector('[data-testid="diff-line"]')).not.toBeNull();
    expect(diff.querySelector('[data-testid="diff-side-row"]')).toBeNull();
  });

  it('puts the old file on the left and the new file on the right in one scroller', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'keep\nold-a\nold-b\ntail\n');
    writeFileSync(join(feature, 'fresh.txt'), 'was\n');
    writeFileSync(join(feature, 'word.txt'), 'alpha beta\n');
    git(feature, ['add', 'notes.txt', 'fresh.txt', 'word.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'keep\nnew-a\ntail\n');
    writeFileSync(join(feature, 'word.txt'), 'alpha gamma\n');
    rmSync(join(feature, 'fresh.txt'));
    writeFileSync(join(feature, 'added.txt'), 'inserted\n');
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="diff"]').length).toBe(1);
    const rows = [...diff.querySelectorAll('[data-testid="diff-side-row"]')] as HTMLElement[];
    expect(rows.map((row) => sideTexts(row))).toEqual([
      ['keep', 'keep'],
      ['old-a', 'new-a'],
      ['old-b', ''],
      ['tail', 'tail'],
    ]);

    const paired = rows[1] as HTMLElement;
    const pairedOld = paired.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    const pairedNew = paired.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    expect(pairedOld.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('2');
    expect(pairedNew.querySelector('[data-testid="diff-new-number"]')?.textContent?.trim()).toBe('2');
    expect(getComputedStyle(pairedOld).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(getComputedStyle(pairedNew).backgroundColor).toBe('rgb(215, 255, 230)');

    const leftover = rows[2] as HTMLElement;
    const leftoverOld = leftover.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    const leftoverNew = leftover.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    expect(leftoverOld.querySelector('[data-testid="diff-old-number"]')?.textContent?.trim()).toBe('3');
    expect(leftoverNew.querySelector('[data-testid="diff-old-number"]')).toBeNull();
    expect(leftoverNew.querySelector('[data-testid="diff-new-number"]')).toBeNull();
    expect(leftoverNew.getAttribute('data-kind')).toBe('empty');
    expect(getComputedStyle(leftoverNew).backgroundColor).not.toBe('rgb(255, 217, 207)');
    expect(getComputedStyle(leftoverNew).backgroundColor).not.toBe('rgb(215, 255, 230)');

    const context = rows[0] as HTMLElement;
    expect(getComputedStyle(context.querySelector('[data-testid="diff-side-old"]')).backgroundColor).not.toBe(
      'rgb(255, 217, 207)',
    );
    expect(context.querySelector('[data-testid="diff-side-old"] [data-testid="diff-old-number"]')?.textContent?.trim()).toBe(
      '1',
    );
    expect(context.querySelector('[data-testid="diff-side-new"] [data-testid="diff-new-number"]')?.textContent?.trim()).toBe(
      '1',
    );

    openChangedFile(fixture, 'feature', 'added.txt');
    const added = fixture.nativeElement.querySelector('[data-testid="diff-side-row"]') as HTMLElement;
    const addedOld = added.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    const addedNew = added.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    expect(addedOld.getAttribute('data-kind')).toBe('empty');
    expect(addedOld.querySelector('[data-testid="diff-old-number"]')).toBeNull();
    expect(addedOld.textContent?.trim()).toBe('');
    expect(getComputedStyle(addedOld).backgroundColor).not.toBe('rgb(215, 255, 230)');
    expect(addedNew.getAttribute('data-kind')).toBe('added');
    expect(addedNew.textContent).toContain('inserted');
    expect(getComputedStyle(addedNew).backgroundColor).toBe('rgb(215, 255, 230)');

    openChangedFile(fixture, 'feature', 'fresh.txt');
    const deleted = fixture.nativeElement.querySelector('[data-testid="diff-side-row"]') as HTMLElement;
    const deletedOld = deleted.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    const deletedNew = deleted.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    expect(deletedOld.getAttribute('data-kind')).toBe('removed');
    expect(deletedOld.textContent).toContain('was');
    expect(getComputedStyle(deletedOld).backgroundColor).toBe('rgb(255, 217, 207)');
    expect(deletedNew.getAttribute('data-kind')).toBe('empty');
    expect(deletedNew.querySelector('[data-testid="diff-new-number"]')).toBeNull();
    expect(getComputedStyle(deletedNew).backgroundColor).not.toBe('rgb(255, 217, 207)');

    openChangedFile(fixture, 'feature', 'word.txt');
    const word = fixture.nativeElement.querySelector('[data-testid="diff-side-row"]') as HTMLElement;
    const wordOld = word.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    const wordNew = word.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    const oldSpan = wordOld.querySelector('[data-changed="true"]') as HTMLElement;
    const newSpan = wordNew.querySelector('[data-changed="true"]') as HTMLElement;
    expect(oldSpan.textContent).toBe('beta');
    expect(newSpan.textContent).toBe('gamma');
    expect(getComputedStyle(oldSpan).backgroundColor).not.toBe(getComputedStyle(wordOld).backgroundColor);
    expect(getComputedStyle(newSpan).backgroundColor).not.toBe(getComputedStyle(wordNew).backgroundColor);
  });

  it('keeps a fold as one row and its buttons change both columns', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const lines = Array.from({ length: 24 }, (_, index) => `n${String(index + 1).padStart(2, '0')}`);
    writeFileSync(join(feature, 'notes.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    lines[4] = 'N05';
    lines[19] = 'N20';
    writeFileSync(join(feature, 'notes.txt'), `${lines.join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const fold = foldWithCount(diff, '8 hidden lines');
    expect(fold.closest('[data-testid="diff-side-row"]')).toBeNull();
    expect([...diff.querySelectorAll('[data-testid="diff-fold-count"]')].filter((node) => node.textContent === '8 hidden lines')).toHaveLength(1);
    expect(fold.parentElement).toBe(diff.querySelector('[data-testid="diff-side-row"]')?.parentElement ?? null);
    expect(diff.textContent).not.toContain('n09');

    (fold.querySelector('[data-testid="diff-fold-more"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const revealed = sideRowContaining(diff, 'n09');
    expect(revealed.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('n09');
    expect(revealed.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('n09');
    expect(revealed.querySelector('[data-testid="diff-side-old"] [data-testid="diff-old-number"]')?.textContent?.trim()).toBe(
      '9',
    );
    expect(revealed.querySelector('[data-testid="diff-side-new"] [data-testid="diff-new-number"]')?.textContent?.trim()).toBe(
      '9',
    );
    expect(diff.textContent).not.toContain('n12');
    expect(foldWithCount(diff, '2 hidden lines')).toBeTruthy();
  });

  it('shows the complete old file on the left and the complete new file on the right', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    git(feature, ['add', 'notes.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n');
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(diff.querySelector('[data-testid="diff-fold"]')).toBeNull();
    expect(diff.querySelector('[data-testid="diff-line"]')).toBeNull();
    const rows = [...diff.querySelectorAll('[data-testid="diff-side-row"]')] as HTMLElement[];
    expect(rows.map((row) => sideTexts(row))).toEqual([
      ['one', 'one'],
      ['two', 'two'],
      ['three', 'three'],
      ['four', 'four'],
      ['five', 'FIVE'],
      ['six', 'six'],
      ['seven', 'seven'],
      ['eight', 'eight'],
      ['nine', 'nine'],
      ['ten', 'ten'],
    ]);
    const changed = rows[4] as HTMLElement;
    expect(changed.querySelector('[data-testid="diff-side-old"]')?.getAttribute('data-kind')).toBe('removed');
    expect(changed.querySelector('[data-testid="diff-side-new"]')?.getAttribute('data-kind')).toBe('added');
    expect(getComputedStyle(changed.querySelector('[data-testid="diff-side-old"]')).backgroundColor).toBe(
      'rgb(255, 217, 207)',
    );
    expect(getComputedStyle(changed.querySelector('[data-testid="diff-side-new"]')).backgroundColor).toBe(
      'rgb(215, 255, 230)',
    );
  });

  it('draws one side-by-side row per scroll position and keeps each number in its cell', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const oldBody = Array.from({ length: 40 }, (_, index) => `old-${String(index).padStart(2, '0')}`).join('\n');
    const newBody = Array.from({ length: 40 }, (_, index) => `new-${String(index).padStart(2, '0')}`).join('\n');
    writeFileSync(join(feature, 'long.txt'), `${oldBody}\n`);
    git(feature, ['add', 'long.txt']);
    git(feature, ['commit', '-m', 'Add long']);
    writeFileSync(join(feature, 'long.txt'), `${newBody}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'long.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const row = diff.querySelector('[data-testid="diff-side-row"]') as HTMLElement;
    const cell = row.querySelector('[data-testid="diff-side-new"]') as HTMLElement;
    const number = cell.querySelector('[data-testid="diff-new-number"]') as HTMLElement;
    expect(getComputedStyle(cell).whiteSpace).toBe('pre');
    expect(getComputedStyle(cell).overflowX).toBe('hidden');
    expect(getComputedStyle(diff).overflowX).toBe('hidden');
    expect(diff.querySelector('.diff-window')?.classList.contains('is-side')).toBe(true);
    const scrolls = diff.parentElement?.querySelector('[data-testid="diff-side-scroll"]') as HTMLElement;
    expect(scrolls).not.toBeNull();
    expect(row.contains(scrolls)).toBe(false);
    expect(diff.parentElement?.querySelectorAll('[data-testid="diff-side-scroll"]').length).toBe(1);
    for (const side of ['diff-side-old', 'diff-side-new']) {
      const sideCell = row.querySelector(`[data-testid="${side}"]`) as HTMLElement;
      Object.defineProperty(sideCell, 'scrollWidth', { configurable: true, value: 200 });
      Object.defineProperty(sideCell, 'clientWidth', { configurable: true, value: 80 });
    }
    diff.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 4 }));
    fixture.detectChanges();
    const oldCode = row.querySelector('[data-testid="diff-side-old"] .diff-code') as HTMLElement;
    const newCode = row.querySelector('[data-testid="diff-side-new"] .diff-code') as HTMLElement;
    expect(oldCode.style.transform).toBe('translateX(-30px)');
    expect(newCode.style.transform).toBe('translateX(-30px)');
    expect(number.style.transform).toBe('');
    diff.dispatchEvent(new WheelEvent('wheel', { deltaX: 2, deltaY: 40 }));
    fixture.detectChanges();
    expect(oldCode.style.transform).toBe('translateX(-30px)');
    let sideScroll = 30;
    Object.defineProperty(scrolls, 'scrollLeft', {
      configurable: true,
      get: () => sideScroll,
      set: (value: number) => {
        sideScroll = value;
      },
    });
    sideScroll = 48;
    scrolls.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(oldCode.style.transform).toBe('translateX(-48px)');
    expect(newCode.style.transform).toBe('translateX(-48px)');
    expect(getComputedStyle(number).position).toBe('sticky');
    expect(getComputedStyle(row).height).toBe('20px');
    expect(fixture.nativeElement.querySelectorAll('[data-testid="diff"]').length).toBe(1);
    const rowHeight = Number.parseFloat(getComputedStyle(row).height);
    installScrollMetrics(diff, {
      clientHeight: rowHeight * 2,
      scrollHeight: rowHeight * 40,
      scrollTop: rowHeight * 30,
    });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(diff.textContent).not.toContain('old-00');
    expect(diff.textContent).not.toContain('new-00');
    const visible = sideRowContaining(diff, 'new-30');
    expect(visible.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('old-30');
    expect(visible.querySelector('[data-testid="diff-side-old"] .diff-code')?.getAttribute('style')).toContain(
      'translateX(-48px)',
    );
    expect(visible.querySelector('[data-testid="diff-side-new"] .diff-code')?.getAttribute('style')).toContain(
      'translateX(-48px)',
    );
    expect(visible.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('new-30');
    expect(diff.querySelector('[data-testid="diff-layout"]')).toBeNull();

    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    installScrollMetrics(diff, {
      clientHeight: rowHeight * 2,
      scrollHeight: rowHeight * 40,
      scrollTop: rowHeight * 30,
    });
    diff.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(diff.textContent).not.toContain('old-00');
    expect(diff.querySelector('[data-testid="diff-fold"]')).toBeNull();
    const fullRow = sideRowContaining(diff, 'new-30');
    expect(fullRow.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('old-30');
  });

  it('applies the fold and full-file size limits to both columns', async () => {
    const repoPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    const head = ['lead-1', 'lead-2', 'lead-3', 'lead-4', 'near-1', 'near-2', 'near-3', 'before', 'near-4', 'near-5', 'near-6'];
    const tail = Array.from({ length: 100004 }, (_, index) => `tail-${index + 1}`);
    writeFileSync(join(feature, 'huge.txt'), `${[...head, ...tail].join('\n')}\n`);
    git(feature, ['add', 'huge.txt']);
    git(feature, ['commit', '-m', 'Add the huge file']);
    head[7] = 'after';
    writeFileSync(join(feature, 'huge.txt'), `${[...head, ...tail].join('\n')}\n`);
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'huge.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const large = foldWithCount(diff, '100004 hidden lines');
    (large.querySelector('[data-testid="diff-fold-all"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(diff.querySelectorAll('[data-testid="diff-fold-too-large"]').length).toBe(1);
    expect(large.querySelector('[data-testid="diff-fold-too-large"]')?.textContent).toBe('This file is too large to show');
    expect(large.closest('[data-testid="diff-side-row"]')).toBeNull();
    const change = sideRowContaining(diff, 'after');
    expect(change.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('before');
    expect(change.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('after');
    expect(diff.textContent).not.toContain('tail-4');

    const lines = Array.from({ length: 100_001 }, (_, index) => `row-${index}`);
    lines[50_000] = 'before-change';
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    git(feature, ['add', 'wide.txt']);
    git(feature, ['commit', '-m', 'Add wide']);
    lines[50_000] = 'after-change';
    writeFileSync(join(feature, 'wide.txt'), `${lines.join('\n')}\n`);
    openChangedFile(fixture, 'feature', 'wide.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="diff-side-row"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-line"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="diff-too-large"]')?.textContent?.trim()).toBe(
      'This file is too large to show',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-mode-full"]')?.getAttribute('aria-pressed')).toBe('true');
    const sentence = fixture.nativeElement.querySelector('[data-testid="diff-too-large"]') as HTMLElement;
    expect(sentence.contains(fixture.nativeElement.querySelector('[data-testid="diff-layout"]'))).toBe(false);
  });

  it('keeps the layout switch visible when the diff shows only a sentence', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="README.md"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="empty-diff"]')?.textContent?.trim()).toBe(
      'No diff for this file',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="diff-layout-inline"]')?.textContent?.trim()).toBe('Inline');
    expect(fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]')?.textContent?.trim()).toBe('Side by side');
    expect(fixture.nativeElement.querySelector('[data-testid="diff"]')).toBeNull();

    fixture.nativeElement.querySelector('[data-branch="rename-docs"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="docs/guide.md"]').click();
    fixture.detectChanges();
    const renamed = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(renamed.querySelector('[data-testid="diff-rename"]')?.textContent).toBe('Renamed from docs/old-guide.md');
    expect(renamed.contains(fixture.nativeElement.querySelector('[data-testid="diff-layout"]'))).toBe(false);

    fixture.nativeElement.querySelector('[data-branch="abandoned"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="assets/logo.png"]').click();
    fixture.detectChanges();
    const binary = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(binary.querySelector('[data-testid="diff-binary"]')?.textContent).toBe('Binary file');
    expect(binary.contains(fixture.nativeElement.querySelector('[data-testid="diff-layout"]'))).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="diff-layout"]')).not.toBeNull();
  });

  it('remembers Side by side for the next file, the next launch, and every repository', async () => {
    const repoPath = createEmptyRepository(roots);
    const otherPath = createEmptyRepository(roots);
    const feature = join(repoPath, '.workspaces', 'feature');
    git(repoPath, ['branch', 'feature']);
    git(repoPath, ['worktree', 'add', feature, 'feature']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    writeFileSync(join(feature, 'other.txt'), 'kept-start\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nkept-end\n');
    git(feature, ['add', 'notes.txt', 'other.txt']);
    git(feature, ['commit', '-m', 'Add notes']);
    writeFileSync(join(feature, 'notes.txt'), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n');
    writeFileSync(join(feature, 'other.txt'), 'kept-start\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nkept-end\n');
    const otherFeature = join(otherPath, '.workspaces', 'feature');
    git(otherPath, ['branch', 'feature']);
    git(otherPath, ['worktree', 'add', otherFeature, 'feature']);
    writeFileSync(join(otherFeature, 'quay.txt'), 'quay-start\nmiddle\nquay-end\n');
    git(otherFeature, ['add', 'quay.txt']);
    git(otherFeature, ['commit', '-m', 'Add quay']);
    writeFileSync(join(otherFeature, 'quay.txt'), 'quay-start\nMIDDLE\nquay-end\n');
    const fixture = await renderRepository(repoPath);
    openChangedFile(fixture, 'feature', 'notes.txt');
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    openChangedFile(fixture, 'feature', 'other.txt');
    const next = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(next.querySelector('[data-testid="diff-line"]')).toBeNull();
    const changed = sideRowContaining(next, 'FIVE');
    expect(changed.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('five');
    expect(changed.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('FIVE');
    expect(
      (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    fixture.destroy();

    const again = await renderRepository(repoPath);
    openChangedFile(again, 'feature', 'other.txt');
    expect(
      (again.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(again.nativeElement.querySelector('[data-testid="diff-side-row"]')).not.toBeNull();
    expect(readAppSettings().diffLayout).toBe('side');
    again.destroy();

    const elsewhere = await renderRepository(otherPath);
    openChangedFile(elsewhere, 'feature', 'quay.txt');
    const quay = elsewhere.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    expect(
      (elsewhere.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    const middle = sideRowContaining(quay, 'MIDDLE');
    expect(middle.querySelector('[data-testid="diff-side-old"]')?.textContent).toContain('middle');
    expect(middle.querySelector('[data-testid="diff-side-new"]')?.textContent).toContain('MIDDLE');
  });

  it('drags the divider between the two sides and restores the share', async () => {
    const fixture = await render();
    fixture.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-branch="feature/login"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const diff = fixture.nativeElement.querySelector('[data-testid="diff"]') as HTMLElement;
    const row = diff.querySelector('[data-testid="diff-side-row"]') as HTMLElement;
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 400 });
    const split = row.querySelector('[data-testid="diff-side-split"]') as HTMLElement;
    const oldSide = row.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    expect(split.getAttribute('role')).toBe('separator');
    expect(split.getAttribute('aria-orientation')).toBe('vertical');
    expect(oldSide.style.width).toBe('calc(0.5 * (100% - 8px))');

    dragDivider(split, { x: 200, y: 10 }, { x: 280, y: 10 });
    fixture.detectChanges();

    expect(oldSide.style.width).toBe('calc(0.7 * (100% - 8px))');
    expect(readAppSettings().diffSideShare).toBe(0.7);

    doubleClickDivider(split);
    fixture.detectChanges();

    expect(oldSide.style.width).toBe('calc(0.5 * (100% - 8px))');
    expect(readAppSettings().diffSideShare).toBe(0.5);

    dragDivider(split, { x: 200, y: 10 }, { x: 280, y: 10 });
    fixture.detectChanges();
    fixture.destroy();

    const again = await render();
    again.nativeElement.querySelector('[data-testid="repository"][data-name="Harbor"]').click();
    again.detectChanges();
    again.nativeElement.querySelector('[data-branch="feature/login"]').click();
    again.detectChanges();
    again.nativeElement.querySelector('[data-testid="changed-file"][data-path="src/login.ts"]').click();
    again.detectChanges();
    (again.nativeElement.querySelector('[data-testid="diff-layout-side"]') as HTMLButtonElement).click();
    again.detectChanges();
    const restored = again.nativeElement.querySelector('[data-testid="diff-side-old"]') as HTMLElement;
    expect(restored.style.width).toBe('calc(0.7 * (100% - 8px))');
  });
});

function sideTexts(row: HTMLElement): [string, string] {
  const oldText = row.querySelector('[data-testid="diff-side-old"] .diff-code')?.textContent ?? '';
  const newText = row.querySelector('[data-testid="diff-side-new"] .diff-code')?.textContent ?? '';
  return [oldText, newText];
}

function sideRowContaining(diff: ParentNode, text: string): HTMLElement {
  const row = [...diff.querySelectorAll('[data-testid="diff-side-row"]')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`missing side row ${text}`);
  }
  return row;
}
