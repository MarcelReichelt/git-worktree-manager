import TOML from '@iarna/toml';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRepositorySidebarColor,
  clearRepositorySidebarText,
  createLayoutForRepository,
  readAppSettings,
  readOpenRepositoryTabs,
  readRepositoryAppearance,
  resetAppColors,
  resolveAppSettingsPath,
  saveArrangement,
  saveContentColor,
  saveDefaultLayout,
  saveDiffLayout,
  saveDiffSideShare,
  saveDiffMode,
  saveIdeCommand,
  saveOpenRepositoryTabs,
  pinWorktree,
  readPinnedWorktrees,
  saveRepositoryLayoutMode,
  saveRepositorySidebarColor,
  saveRepositorySidebarText,
  saveSidebarColor,
  saveSidebarText,
  saveShellCommand,
  saveTerminalBackground,
  saveTerminalFont,
  saveTerminalForeground,
  saveTerminalMode,
  unpinWorktree,
} from '../src/app-settings.js';
import { addRepository, listRepositories } from '../src/registry.js';

describe('app settings', () => {
  const roots: string[] = [];
  const previousRegistryPath = process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;

  afterEach(() => {
    if (previousRegistryPath === undefined) {
      delete process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH;
    } else {
      process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = previousRegistryPath;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses Workspaces when the app settings file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };

    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'workspaces',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
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

  it('reads a stored arrangement and ignores a share, size, or collapsed flag that cannot be used', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","changesShare":0.25,"terminalRowHeight":360,"changesFileWidth":180,"commitFileWidth":160,"terminalExpanded":false}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).changesShare).toBe(0.25);
    expect(readAppSettings(env).terminalRowHeight).toBe(360);
    expect(readAppSettings(env).changesFileWidth).toBe(180);
    expect(readAppSettings(env).commitFileWidth).toBe(160);
    expect('terminalExpanded' in readAppSettings(env)).toBe(false);

    writeFileSync(
      settingsPath,
      '{"changesShare":1,"terminalRowHeight":"360","changesFileWidth":false,"commitFileWidth":null,"terminalExpanded":"false"}\n',
    );

    expect(readAppSettings(env).changesShare).toBe(1);
    expect(readAppSettings(env).terminalRowHeight).toBe(240);
    expect(readAppSettings(env).changesFileWidth).toBe(240);
    expect(readAppSettings(env).commitFileWidth).toBe(240);
    expect('terminalExpanded' in readAppSettings(env)).toBe(false);
  });

  it('saves the arrangement together and omits the share when it is unset', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"theme":"mint","terminalMode":"tmux","changesShare":0.25,"terminalExpanded":false}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveArrangement(
      {
        changesShare: null,
        terminalRowHeight: 320,
        changesFileWidth: 180,
        commitFileWidth: 160,
      },
      env,
    );

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      terminalMode: 'tmux',
      terminalRowHeight: 320,
      changesFileWidth: 180,
      commitFileWidth: 160,
    });
    expect(readAppSettings(env).changesShare).toBeNull();
    expect(readAppSettings(env).terminalRowHeight).toBe(320);
    expect('terminalExpanded' in readAppSettings(env)).toBe(false);

    saveArrangement(
      {
        changesShare: 0.75,
        terminalRowHeight: 240,
        changesFileWidth: 240,
        commitFileWidth: 240,
      },
      env,
    );

    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).changesShare).toBe(0.75);
    expect(readAppSettings(env).changesShare).toBe(0.75);
  });

  it('uses the original terminal colors and UbuntuMono Nerd Font Mono when those settings are not text', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"terminalBackground":1,"terminalForeground":false,"terminalFont":["UbuntuMono Nerd Font Mono"]}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).terminalBackground).toBe('#1e1e1e');
    expect(readAppSettings(env).terminalForeground).toBe('#d4d4d4');
    expect(readAppSettings(env).terminalFont).toBe('UbuntuMono Nerd Font Mono');
  });

  it('uses the original terminal colors and UbuntuMono Nerd Font Mono when app settings are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };

    expect(readAppSettings(env).terminalBackground).toBe('#1e1e1e');
    expect(readAppSettings(env).terminalForeground).toBe('#d4d4d4');
    expect(readAppSettings(env).terminalFont).toBe('UbuntuMono Nerd Font Mono');
  });

  it('starts the IDE command empty when that key is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling","sidebarColor":"#112233"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).ideCommand).toBe('');
  });

  it('uses Workspaces when the app settings file is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'workspaces',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
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

  it('stores app settings at ~/.config/git-worktree-manager/app-settings.json unless the path is overridden', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'custom', 'app-settings.json');

    expect(resolveAppSettingsPath({})).toBe(
      join(homedir(), '.config', 'git-worktree-manager', 'app-settings.json'),
    );
    expect(resolveAppSettingsPath({ GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath })).toBe(settingsPath);
  });

  it('ignores GIT_MANAGER_APP_SETTINGS_PATH', () => {
    expect(resolveAppSettingsPath({ GIT_MANAGER_APP_SETTINGS_PATH: '/old/app-settings.json' })).toBe(
      join(homedir(), '.config', 'git-worktree-manager', 'app-settings.json'),
    );
  });

  it('reads a stored sidebar color and keeps the original content color when that key is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling","sidebarColor":"#112233"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'sibling',
      sidebarColor: '#112233',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
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

  it('reads the process environment when no env argument is passed', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    const previous = process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
    process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = settingsPath;
    try {
      saveDefaultLayout('sibling');
      expect(readAppSettings().defaultLayout).toBe('sibling');
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH;
      } else {
        process.env.GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH = previous;
      }
    }
  });

  it('saves the default layout immediately', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'nested', 'app-settings.json') };

    saveDefaultLayout('sibling', env);

    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'sibling',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
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

  it('keeps unknown app settings when the default layout is saved', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"theme":"mint","defaultLayout":"workspaces"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveDefaultLayout('sibling', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
    });
    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'sibling',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
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

  it('saves the sidebar color without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","contentColor":"#abcdef"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveSidebarColor('#112233', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      contentColor: '#abcdef',
      sidebarColor: '#112233',
    });
    expect(readAppSettings(env).sidebarColor).toBe('#112233');
  });

  it('saves the IDE command without dropping the layout, colors, or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","sidebarColor":"#112233","contentColor":"#abcdef"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveIdeCommand('code -n {folder}', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
      ideCommand: 'code -n {folder}',
    });
    expect(readAppSettings(env).ideCommand).toBe('code -n {folder}');
  });

  it('saves the terminal background without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","terminalForeground":"#ffffff","terminalFont":"JetBrains Mono"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveTerminalBackground('#065f46', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
      terminalForeground: '#ffffff',
      terminalFont: 'JetBrains Mono',
      terminalBackground: '#065f46',
    });
    expect(readAppSettings(env).terminalBackground).toBe('#065f46');
    expect(readAppSettings(env).terminalFont).toBe('JetBrains Mono');
    expect(readAppSettings(env).terminalForeground).toBe('#ffffff');
  });

  it('saves the terminal foreground without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"workspaces","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","terminalBackground":"#065f46","terminalFont":"JetBrains Mono"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveTerminalForeground('#ffffff', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'workspaces',
      ideCommand: 'cursor',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
      terminalBackground: '#065f46',
      terminalFont: 'JetBrains Mono',
      terminalForeground: '#ffffff',
    });
    expect(readAppSettings(env).terminalForeground).toBe('#ffffff');
    expect(readAppSettings(env).terminalBackground).toBe('#065f46');
  });

  it('saves the terminal font family without dropping the layout, colors, or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","terminalBackground":"#065f46","terminalForeground":"#ffffff"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveTerminalFont('JetBrains Mono', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
      terminalBackground: '#065f46',
      terminalForeground: '#ffffff',
      terminalFont: 'JetBrains Mono',
    });
    expect(readAppSettings(env).terminalFont).toBe('JetBrains Mono');
  });

  it('saves the content color without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"workspaces","ideCommand":"cursor","sidebarColor":"#112233"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveContentColor('#abcdef', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'workspaces',
      ideCommand: 'cursor',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
    });
    expect(readAppSettings(env).contentColor).toBe('#abcdef');
  });

  it('uses white sidebar text when that key is missing or not white or black', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).sidebarText).toBe('white');

    writeFileSync(settingsPath, '{"sidebarText":"black","sidebarColor":"#112233"}\n');
    expect(readAppSettings(env).sidebarText).toBe('black');
    expect(readAppSettings(env).sidebarColor).toBe('#112233');

    writeFileSync(settingsPath, '{"sidebarText":"blue"}\n');
    expect(readAppSettings(env).sidebarText).toBe('white');

    writeFileSync(settingsPath, '{"sidebarText":1}\n');
    expect(readAppSettings(env).sidebarText).toBe('white');
  });

  it('saves black or white sidebar text without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","terminalFont":"JetBrains Mono"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveSidebarText('black', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      sidebarColor: '#112233',
      contentColor: '#abcdef',
      terminalFont: 'JetBrains Mono',
      sidebarText: 'black',
    });
    expect(readAppSettings(env).sidebarText).toBe('black');
    expect(readAppSettings(env).sidebarColor).toBe('#112233');
    expect(readAppSettings(env).terminalFont).toBe('JetBrains Mono');

    saveSidebarText('white', env);

    expect(readAppSettings(env).sidebarText).toBe('white');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('mint');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).ideCommand).toBe('cursor');
  });

  it('restores the original colors and leaves the layout and other settings in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"defaultLayout":"sibling","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","sidebarText":"black"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    resetAppColors(env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
    });
    expect(readAppSettings(env)).toEqual({
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
  });

  it('restores the terminal background and foreground and leaves the font and layout in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","sidebarColor":"#112233","contentColor":"#abcdef","terminalBackground":"#065f46","terminalForeground":"#ffffff","terminalFont":"JetBrains Mono"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    resetAppColors(env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
      terminalFont: 'JetBrains Mono',
    });
    expect(readAppSettings(env)).toEqual({
      defaultLayout: 'sibling',
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
      contentColor: '#f7f7f5',
      terminalBackground: '#1e1e1e',
      terminalForeground: '#d4d4d4',
      terminalFont: 'JetBrains Mono',
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
  });

  it('uses Terminal mode and a blank shell command when those settings are not text', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"terminalMode":1,"shellCommand":["/bin/zsh"]}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).terminalMode).toBe('terminal');
    expect(readAppSettings(env).shellCommand).toBe('');
  });

  it('saves the terminal mode without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","ideCommand":"cursor","shellCommand":"/bin/zsh"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveTerminalMode('none', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      ideCommand: 'cursor',
      shellCommand: '/bin/zsh',
      terminalMode: 'none',
    });
    expect(readAppSettings(env).terminalMode).toBe('none');

    saveTerminalMode('tmux', env);

    expect(readAppSettings(env).terminalMode).toBe('tmux');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('mint');
  });

  it('saves a shell command path without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"workspaces","terminalMode":"tmux","ideCommand":"cursor"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveShellCommand('/usr/bin/zsh', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'workspaces',
      terminalMode: 'tmux',
      ideCommand: 'cursor',
      shellCommand: '/usr/bin/zsh',
    });
    expect(readAppSettings(env).shellCommand).toBe('/usr/bin/zsh');
  });

  it('stores a shell path that contains a space', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"theme":"mint","shellCommand":"/usr/bin/zsh"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveShellCommand('/opt/Git Manager/bash', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      shellCommand: '/opt/Git Manager/bash',
    });
    expect(readAppSettings(env).shellCommand).toBe('/opt/Git Manager/bash');
  });

  it('leaves the registered repository list unchanged when the default layout is saved', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, stdio: 'ignore' });
    process.env.GIT_WORKTREE_MANAGER_REGISTRY_PATH = registryPath;
    addRepository(repoPath, 'Harbor');
    const before = listRepositories();

    saveDefaultLayout('sibling', {
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json'),
    });

    expect(listRepositories()).toEqual(before);
    expect(before).toEqual([{ path: resolve(repoPath), displayName: 'Harbor' }]);
    const listed = new Database(registryPath, { readonly: true });
    const columns = listed.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    listed.close();
    expect(columns.map((column) => column.name)).toEqual(['path', 'display_name']);
  });

  it('uses the app default Workspaces when the repository has no layout mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);

    expect(
      createLayoutForRepository(repoPath, {
        GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'missing-app-settings.json'),
      }),
    ).toEqual({
      label: 'Workspaces',
      source: 'app',
      supported: true,
    });
  });

  it('ignores a repository config at .git-manager/config.toml', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');

    expect(
      createLayoutForRepository(repoPath, {
        GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'missing-app-settings.json'),
      }),
    ).toEqual({
      label: 'Workspaces',
      source: 'app',
      supported: true,
    });
  });

  it('uses the app default Sibling when the repository has no layout mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };
    saveDefaultLayout('sibling', env);

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'Sibling',
      source: 'app',
      supported: true,
    });
  });

  it('keeps a repository Workspaces layout when the app default is Sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "workspaces"\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };
    saveDefaultLayout('sibling', env);

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'Workspaces',
      source: 'repository',
      supported: true,
    });
  });

  it('keeps a repository Sibling layout when the app default is Workspaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'missing-app-settings.json') };

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'Sibling',
      source: 'repository',
      supported: true,
    });
  });

  it('reports an unsupported repository layout mode without using the app default', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "custom"\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };
    saveDefaultLayout('sibling', env);

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'custom',
      source: 'repository',
      supported: false,
    });
  });

  it('reports a non-string repository layout mode as set by the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = 1\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };
    saveDefaultLayout('sibling', env);

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: '1',
      source: 'repository',
      supported: false,
    });
  });

  it('saves Sibling onto a repository that has no layout config', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'missing-app-settings.json') };

    saveRepositoryLayoutMode(repoPath, 'sibling');

    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'Sibling',
      source: 'repository',
      supported: true,
    });
  });

  it('saves Workspaces without dropping copy files, hooks, or other layout keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      [
        '[layout]',
        'workspaces_dir = ".workspaces"',
        'mode = "sibling"',
        '',
        '[copy]',
        'files = [".env.local"]',
        '',
        '[hooks]',
        'modules = ["./plugins/mark.ts"]',
        '',
        '[hooks.pre_worktree_create]',
        'commands = ["node hooks/mark.mjs"]',
        '',
        '[hooks.post_worktree_create]',
        'commands = ["yarn"]',
        '',
        '[editor]',
        'command = "vim"',
        '',
      ].join('\n'),
    );

    saveRepositoryLayoutMode(repoPath, 'workspaces');

    const parsed = TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'));
    expect(parsed).toEqual({
      layout: { workspaces_dir: '.workspaces', mode: 'workspaces' },
      copy: { files: ['.env.local'] },
      hooks: {
        modules: ['./plugins/mark.ts'],
        pre_worktree_create: { commands: ['node hooks/mark.mjs'] },
        post_worktree_create: { commands: ['yarn'] },
      },
      editor: { command: 'vim' },
    });
    expect(createLayoutForRepository(repoPath)).toEqual({
      label: 'Workspaces',
      source: 'repository',
      supported: true,
    });
  });

  it('replaces an unsupported or non-text repository layout mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const customPath = join(root, 'custom');
    const numericPath = join(root, 'numeric');
    mkdirSync(join(customPath, '.git-worktree-manager'), { recursive: true });
    mkdirSync(join(numericPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(customPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "custom"\n');
    writeFileSync(join(numericPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = 1\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };
    saveDefaultLayout('sibling', env);

    saveRepositoryLayoutMode(customPath, 'workspaces');
    saveRepositoryLayoutMode(numericPath, 'sibling');

    expect(createLayoutForRepository(customPath, env)).toEqual({
      label: 'Workspaces',
      source: 'repository',
      supported: true,
    });
    expect(createLayoutForRepository(numericPath, env)).toEqual({
      label: 'Sibling',
      source: 'repository',
      supported: true,
    });
  });

  it('reads no repository sidebar color or sidebar text when those keys are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);

    expect(readRepositoryAppearance(repoPath)).toEqual({});

    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');

    expect(readRepositoryAppearance(repoPath)).toEqual({});
  });

  it('reads a repository sidebar color and sidebar text and ignores values that cannot be used', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = "#112233"', 'sidebar_text = "black"', ''].join('\n'),
    );

    expect(readRepositoryAppearance(repoPath)).toEqual({
      sidebarColor: '#112233',
      sidebarText: 'black',
    });

    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      ['[appearance]', 'sidebar_color = 1', 'sidebar_text = "blue"', ''].join('\n'),
    );

    expect(readRepositoryAppearance(repoPath)).toEqual({});
  });

  it('saves a repository sidebar color and sidebar text that match the app settings and keeps the layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      [
        '[layout]',
        'workspaces_dir = ".workspaces"',
        'mode = "sibling"',
        '',
        '[copy]',
        'files = [".env.local"]',
        '',
        '[hooks]',
        'modules = ["./plugins/mark.ts"]',
        '',
      ].join('\n'),
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: join(root, 'app-settings.json') };

    saveRepositorySidebarColor(repoPath, '#1a3c2b');
    saveRepositorySidebarText(repoPath, 'white');

    const parsed = TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'));
    expect(parsed).toEqual({
      layout: { workspaces_dir: '.workspaces', mode: 'sibling' },
      copy: { files: ['.env.local'] },
      hooks: { modules: ['./plugins/mark.ts'] },
      appearance: { sidebar_color: '#1a3c2b', sidebar_text: 'white' },
    });
    expect(readRepositoryAppearance(repoPath)).toEqual({
      sidebarColor: '#1a3c2b',
      sidebarText: 'white',
    });
    expect(readAppSettings(env).sidebarColor).toBe('#1a3c2b');
    expect(readAppSettings(env).sidebarText).toBe('white');
    expect(createLayoutForRepository(repoPath, env)).toEqual({
      label: 'Sibling',
      source: 'repository',
      supported: true,
    });
  });

  it('clears only the repository sidebar color or only the repository sidebar text', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const configPath = join(repoPath, '.git-worktree-manager', 'config.toml');
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      configPath,
      ['[layout]', 'mode = "workspaces"', '', '[appearance]', 'sidebar_color = "#112233"', 'sidebar_text = "black"', ''].join(
        '\n',
      ),
    );

    clearRepositorySidebarColor(repoPath);

    expect(readRepositoryAppearance(repoPath)).toEqual({ sidebarText: 'black' });
    expect(TOML.parse(readFileSync(configPath, 'utf8'))).toEqual({
      layout: { mode: 'workspaces' },
      appearance: { sidebar_text: 'black' },
    });

    clearRepositorySidebarText(repoPath);

    expect(readRepositoryAppearance(repoPath)).toEqual({});
    expect(TOML.parse(readFileSync(configPath, 'utf8'))).toEqual({
      layout: { mode: 'workspaces' },
    });
  });

  it('remembers open repository paths and the selected path without changing other app settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readOpenRepositoryTabs(env)).toEqual({ paths: [], selectedPath: null });

    writeFileSync(settingsPath, '{"theme":"mint","defaultLayout":"sibling"}\n');
    saveOpenRepositoryTabs(['/repos/pier', '/repos/quay', '/repos/dock'], '/repos/quay', env);

    expect(readOpenRepositoryTabs(env)).toEqual({
      paths: ['/repos/pier', '/repos/quay', '/repos/dock'],
      selectedPath: '/repos/quay',
    });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      openRepositoryPaths: ['/repos/pier', '/repos/quay', '/repos/dock'],
      selectedRepositoryPath: '/repos/quay',
    });
    expect(readAppSettings(env).defaultLayout).toBe('sibling');

    writeFileSync(
      settingsPath,
      '{"theme":"mint","openRepositoryPaths":["/repos/pier",3,null],"selectedRepositoryPath":false}\n',
    );
    expect(readOpenRepositoryTabs(env)).toEqual({ paths: ['/repos/pier'], selectedPath: null });

    saveOpenRepositoryTabs([], null, env);

    expect(readOpenRepositoryTabs(env)).toEqual({ paths: [], selectedPath: null });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ theme: 'mint' });
  });

  it('keeps worktree pins for that repository and leaves the rest of its config', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);
    saveRepositoryLayoutMode(repoPath, 'sibling');

    expect(readPinnedWorktrees(repoPath)).toEqual([]);
    pinWorktree(repoPath, 'feature');
    pinWorktree(repoPath, 'feature');
    pinWorktree(repoPath, 'zeta');

    expect(readPinnedWorktrees(repoPath)).toEqual(['feature', 'zeta']);
    expect(createLayoutForRepository(repoPath).label).toBe('Sibling');

    unpinWorktree(repoPath, 'feature');
    unpinWorktree(repoPath, 'missing');

    expect(readPinnedWorktrees(repoPath)).toEqual(['zeta']);
    expect(createLayoutForRepository(repoPath).label).toBe('Sibling');

    unpinWorktree(repoPath, 'zeta');

    expect(readPinnedWorktrees(repoPath)).toEqual([]);
    expect(TOML.parse(readFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), 'utf8'))).toEqual({
      layout: { mode: 'sibling' },
    });
  });

  it('does not create a repository config when clearing sidebar color or sidebar text that were never set', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const repoPath = join(root, 'harbor');
    mkdirSync(repoPath);

    clearRepositorySidebarColor(repoPath);
    clearRepositorySidebarText(repoPath);

    expect(existsSync(join(repoPath, '.git-worktree-manager', 'config.toml'))).toBe(false);
  });

  it('starts the diff on Folded when that setting is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling","terminalMode":"tmux"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).diffMode).toBe('folded');
  });

  it('saves Full file without dropping the layout or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","terminalMode":"tmux","shellCommand":"/bin/zsh"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveDiffMode('full', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      terminalMode: 'tmux',
      shellCommand: '/bin/zsh',
      diffMode: 'full',
    });
    expect(readAppSettings(env).diffMode).toBe('full');

    saveDiffMode('folded', env);

    expect(readAppSettings(env).diffMode).toBe('folded');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('mint');
  });

  it('uses Folded when the saved diff mode is not folded or full', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"diffMode":"side-by-side"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).diffMode).toBe('folded');
  });

  it('starts the diff layout on Inline when that setting is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"diffMode":"full"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).diffLayout).toBe('inline');
  });

  it('saves Side by side without dropping the diff mode or other settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(
      settingsPath,
      '{"theme":"mint","defaultLayout":"sibling","diffMode":"full","terminalMode":"tmux"}\n',
    );
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    saveDiffLayout('side', env);

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'mint',
      defaultLayout: 'sibling',
      diffMode: 'full',
      terminalMode: 'tmux',
      diffLayout: 'side',
    });
    expect(readAppSettings(env).diffLayout).toBe('side');

    saveDiffLayout('inline', env);

    expect(readAppSettings(env).diffLayout).toBe('inline');
    expect(readAppSettings(env).diffMode).toBe('full');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).theme).toBe('mint');
  });

  it('saves the side-by-side share and uses half when the saved share is not a number', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).diffSideShare).toBe(0.5);

    saveDiffSideShare(0.7, env);

    expect(readAppSettings(env).diffSideShare).toBe(0.7);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).diffSideShare).toBe(0.7);

    writeFileSync(settingsPath, '{"diffSideShare":"wide"}\n');

    expect(readAppSettings(env).diffSideShare).toBe(0.5);
  });

  it('uses Inline when the saved diff layout is not inline or side', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-worktree-manager-app-settings-'));
    roots.push(root);
    const settingsPath = join(root, 'app-settings.json');
    writeFileSync(settingsPath, '{"diffLayout":"split"}\n');
    const env = { GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath };

    expect(readAppSettings(env).diffLayout).toBe('inline');
  });
});
