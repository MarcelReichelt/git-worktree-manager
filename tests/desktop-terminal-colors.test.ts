import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { readAppSettings } from '../src/app-settings';
import { killTmuxSession, listTmuxSessions, sessionDirectory } from '../src/desktop/tmux-sessions';
import { WorkspaceComponent } from '../src/desktop/workspace.component';

const emptyGitConfig = join(tmpdir(), 'git-worktree-manager-desktop-gitconfig');
writeFileSync(emptyGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfig;
process.env.GIT_TERMINAL_PROMPT = '0';

function createRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-terminal-colors-'));
  const repo = join(root, 'billing');
  mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'master'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@git-worktree-manager.local'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'git-worktree-manager test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README'), 'hi\n');
  execFileSync('git', ['add', 'README'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' });
  const worktree = join(repo, '.workspaces', 'feature');
  mkdirSync(join(repo, '.workspaces'));
  execFileSync('git', ['worktree', 'add', worktree, 'feature'], { cwd: repo, stdio: 'ignore' });
  return { root, repo };
}

async function renderWorkspace(repo: string, platform?: string): Promise<ComponentFixture<WorkspaceComponent>> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [WorkspaceComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(WorkspaceComponent);
  fixture.componentRef.setInput('repositoryPath', repo);
  if (platform) {
    fixture.componentRef.setInput('platform', platform);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function clickBranch(fixture: ComponentFixture<WorkspaceComponent>, name: string): void {
  const row = fixture.nativeElement.querySelector(`[data-testid="branch-row"][data-branch="${name}"]`);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Branch ${name} is not shown`);
  }
  row.click();
  fixture.detectChanges();
}

function startTerminal(fixture: ComponentFixture<WorkspaceComponent>): void {
  const button = fixture.nativeElement.querySelector('[data-testid="terminal-new"]');
  if (!(button instanceof HTMLElement)) {
    throw new Error('New is not shown');
  }
  button.click();
  fixture.detectChanges();
}

function paneBackground(pane: HTMLElement): string {
  return pane.getAttribute('style') ?? '';
}

function terminalSurfaceBackground(pane: HTMLElement): string {
  const surface = pane.querySelector('.xterm-scrollable-element');
  if (!(surface instanceof HTMLElement)) {
    throw new Error('The terminal surface is not open');
  }
  return surface.style.backgroundColor;
}

function terminalStyles(pane: HTMLElement): string {
  return [...pane.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the terminal');
}

describe('terminal font and colors', () => {
  let root = '';
  let fixture: ComponentFixture<WorkspaceComponent> | undefined;
  const previousSettingsPath = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    fixture?.destroy();
    fixture = undefined;
    if (previousSettingsPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = previousSettingsPath;
    }
    if (root) {
      for (const name of listTmuxSessions()) {
        if (sessionDirectory(name).startsWith(root)) {
          killTmuxSession(name);
        }
      }
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('chooses the terminal font family in App settings', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]') as HTMLElement;
    const font = dialog.querySelector('[data-testid="terminal-font"]') as HTMLInputElement;
    expect(font).toBeInstanceOf(HTMLInputElement);
    expect(font.type).toBe('text');
    expect(font.value).toBe('UbuntuMono Nerd Font Mono');
    expect(font.closest('label')?.textContent).toContain('Font family');
    expect(dialog.querySelector('[data-testid="terminal-font-size"]')).toBeNull();
    expect(dialog.textContent).not.toMatch(/font size/i);

    font.value = 'JetBrains Mono';
    font.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(font.value).toBe('JetBrains Mono');
    expect(readAppSettings().terminalFont).toBe('JetBrains Mono');
  });

  it('chooses a terminal background from the dark swatches or a custom color', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]') as HTMLElement;
    const choice = [...dialog.querySelectorAll('.color-choice')].find((item) =>
      item.textContent?.includes('Terminal background'),
    ) as HTMLElement;
    expect(choice).toBeTruthy();
    const swatches = [...choice.querySelectorAll('[data-testid="terminal-background-swatch"]')];
    expect(swatches.map((swatch) => swatch.getAttribute('data-color'))).toEqual([
      '#1e1e1e',
      '#065f46',
      '#166534',
      '#3f6212',
      '#991b1b',
      '#9a3412',
      '#92400e',
      '#854d0e',
      '#115e59',
      '#155e75',
      '#075985',
      '#1e40af',
      '#3730a3',
      '#5b21b6',
      '#6b21a8',
      '#86198f',
      '#9d174d',
      '#9f1239',
      '#1e293b',
    ]);
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
      'Original',
      'Emerald',
      'Green',
      'Lime',
      'Red',
      'Orange',
      'Amber',
      'Yellow',
      'Teal',
      'Cyan',
      'Sky',
      'Blue',
      'Indigo',
      'Violet',
      'Purple',
      'Fuchsia',
      'Pink',
      'Rose',
      'Slate',
    ]);
    expect(swatches[0]?.classList.contains('is-selected')).toBe(true);
    const custom = choice.querySelector('[data-testid="terminal-background-color"]') as HTMLInputElement;
    expect(custom).toBeInstanceOf(HTMLInputElement);
    expect(custom.type).toBe('color');
    expect(custom.getAttribute('aria-label')).toBe('Custom terminal background');
    expect(custom.value).toBe('#1e1e1e');

    (swatches[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(readAppSettings().terminalBackground).toBe('#065f46');
    expect(swatches[1]?.classList.contains('is-selected')).toBe(true);
    expect(swatches[0]?.classList.contains('is-selected')).toBe(false);

    custom.value = '#123456';
    custom.dispatchEvent(new Event('input'));
    custom.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(readAppSettings().terminalBackground).toBe('#123456');
    expect(swatches.some((swatch) => swatch.classList.contains('is-selected'))).toBe(false);
    expect(custom.value).toBe('#123456');
  });

  it('chooses a terminal foreground of Original, White, or a custom color', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]') as HTMLElement;
    const choice = [...dialog.querySelectorAll('.color-choice')].find((item) =>
      item.textContent?.includes('Terminal foreground'),
    ) as HTMLElement;
    expect(choice).toBeTruthy();
    const swatches = [...choice.querySelectorAll('[data-testid="terminal-foreground-swatch"]')];
    expect(swatches.map((swatch) => swatch.getAttribute('data-color'))).toEqual(['#d4d4d4', '#ffffff']);
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual(['Original', 'White']);
    expect(swatches[0]?.classList.contains('is-selected')).toBe(true);
    const custom = choice.querySelector('[data-testid="terminal-foreground-color"]') as HTMLInputElement;
    expect(custom).toBeInstanceOf(HTMLInputElement);
    expect(custom.type).toBe('color');
    expect(custom.getAttribute('aria-label')).toBe('Custom terminal foreground');
    expect(custom.value).toBe('#d4d4d4');

    (swatches[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(readAppSettings().terminalForeground).toBe('#ffffff');
    expect(swatches[1]?.classList.contains('is-selected')).toBe(true);
    expect(swatches[0]?.classList.contains('is-selected')).toBe(false);

    custom.value = '#112233';
    custom.dispatchEvent(new Event('input'));
    custom.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(readAppSettings().terminalForeground).toBe('#112233');
    expect(swatches.some((swatch) => swatch.classList.contains('is-selected'))).toBe(false);
  });

  it('opens a terminal with the font and colors stored in app settings', async () => {
    const repo = createRepo();
    root = repo.root;
    const settingsPath = join(root, 'app-settings.json');
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        terminalBackground: '#065f46',
        terminalForeground: '#ffffff',
        terminalFont: 'JetBrains Mono',
        sidebarColor: '#112233',
      })}\n`,
    );
    fixture = await renderWorkspace(repo.repo);

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('.xterm-scrollable-element') !== null);
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(paneBackground(pane)).toMatch(/background-color:\s*(#065f46|rgb\(6,\s*95,\s*70\))/);
    expect(terminalSurfaceBackground(pane)).toBe('rgb(6, 95, 70)');
    expect(terminalStyles(pane)).toContain('.xterm-rows { pointer-events: none; color: #ffffff;');
    expect(terminalStyles(pane)).toContain('font-family: JetBrains Mono, monospace;');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).sidebarColor).toBe('#112233');
  });

  it('paints an open terminal with a new background and leaves the header #252526', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('[data-testid="terminal-pane"]') !== null);
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(paneBackground(pane)).toMatch(/background-color:\s*(#1e1e1e|rgb\(30,\s*30,\s*30\))/);
    expect(terminalSurfaceBackground(pane)).toBe('rgb(30, 30, 30)');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="terminal-background-swatch"][data-color="#065f46"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(paneBackground(pane)).toMatch(/background-color:\s*(#065f46|rgb\(6,\s*95,\s*70\))/);
    expect(terminalSurfaceBackground(pane)).toBe('rgb(6, 95, 70)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('.terminal-chrome')).backgroundColor).toBe(
      'rgb(37, 37, 38)',
    );
  });

  it('paints an open terminal with a new foreground and keeps the ANSI colors', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('[data-testid="terminal-pane"]') !== null);
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(terminalStyles(pane)).toContain('.xterm-rows { pointer-events: none; color: #d4d4d4;');
    expect(terminalStyles(pane)).toContain('.xterm-bg-1 { background-color: #cc0000; }');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="terminal-foreground-swatch"][data-color="#ffffff"]').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(terminalStyles(pane)).toContain('.xterm-rows { pointer-events: none; color: #ffffff;');
    expect(terminalStyles(pane)).toContain('.xterm-bg-1 { background-color: #cc0000; }');
    expect(terminalSurfaceBackground(pane)).toBe('rgb(30, 30, 30)');
    expect(paneBackground(pane)).toMatch(/background-color:\s*(#1e1e1e|rgb\(30,\s*30,\s*30\))/);
  });

  it('uses the chosen font family, with monospace as the fallback, on an open terminal', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('[data-testid="terminal-pane"]') !== null);
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(terminalStyles(pane)).toContain('font-family: UbuntuMono Nerd Font Mono, monospace;');
    expect(terminalStyles(pane)).toContain('font-size: 15px;');

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const font = fixture.nativeElement.querySelector('[data-testid="terminal-font"]') as HTMLInputElement;
    font.value = 'JetBrains Mono';
    font.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(readAppSettings().terminalFont).toBe('JetBrains Mono');
    expect(terminalStyles(pane)).toContain('font-family: JetBrains Mono, monospace;');
    expect(terminalStyles(pane)).toContain('font-size: 15px;');
  });

  it('paints an open shell with the terminal font and colors', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo, 'win32');

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('.xterm-scrollable-element') !== null);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="terminal-background-swatch"][data-color="#065f46"]').click();
    fixture.nativeElement.querySelector('[data-testid="terminal-foreground-swatch"][data-color="#ffffff"]').click();
    const font = fixture.nativeElement.querySelector('[data-testid="terminal-font"]') as HTMLInputElement;
    font.value = 'JetBrains Mono';
    font.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(paneBackground(pane)).toMatch(/background-color:\s*(#065f46|rgb\(6,\s*95,\s*70\))/);
    expect(terminalSurfaceBackground(pane)).toBe('rgb(6, 95, 70)');
    expect(terminalStyles(pane)).toContain('.xterm-rows { pointer-events: none; color: #ffffff;');
    expect(terminalStyles(pane)).toContain('font-family: JetBrains Mono, monospace;');
    expect(terminalStyles(pane)).toContain('.xterm-bg-1 { background-color: #cc0000; }');
  });

  it('resets the terminal colors on an open terminal and leaves the chosen font', async () => {
    const repo = createRepo();
    root = repo.root;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = join(root, 'app-settings.json');
    fixture = await renderWorkspace(repo.repo);

    clickBranch(fixture, 'feature');
    startTerminal(fixture);
    await waitFor(() => fixture!.nativeElement.querySelector('.xterm-scrollable-element') !== null);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="app-settings"]').click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('[data-testid="app-settings-dialog"]') as HTMLElement;
    (dialog.querySelector('[data-testid="terminal-background-swatch"][data-color="#065f46"]') as HTMLButtonElement).click();
    (dialog.querySelector('[data-testid="terminal-foreground-swatch"][data-color="#ffffff"]') as HTMLButtonElement).click();
    (dialog.querySelector('[data-testid="sidebar-swatch"][data-color="#1e293b"]') as HTMLButtonElement).click();
    const font = dialog.querySelector('[data-testid="terminal-font"]') as HTMLInputElement;
    font.value = 'JetBrains Mono';
    font.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (dialog.querySelector('[data-testid="reset-colors"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pane = fixture.nativeElement.querySelector('[data-testid="terminal-pane"]') as HTMLElement;
    expect(paneBackground(pane)).toMatch(/background-color:\s*(#1e1e1e|rgb\(30,\s*30,\s*30\))/);
    expect(terminalSurfaceBackground(pane)).toBe('rgb(30, 30, 30)');
    expect(terminalStyles(pane)).toContain('.xterm-rows { pointer-events: none; color: #d4d4d4;');
    expect(terminalStyles(pane)).toContain('font-family: JetBrains Mono, monospace;');
    expect(getComputedStyle(fixture.nativeElement.querySelector('aside')).backgroundColor).toBe('rgb(26, 60, 43)');
    expect(getComputedStyle(fixture.nativeElement.querySelector('[data-testid="content-sheet"]')).backgroundColor).toBe(
      'rgb(247, 247, 245)',
    );
    expect(readAppSettings()).toEqual({
      defaultLayout: 'workspaces',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
      terminalFont: 'JetBrains Mono',
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
});
