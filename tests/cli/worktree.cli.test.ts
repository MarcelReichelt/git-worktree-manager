import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  git,
  gitWorktreeManagerEnv,
  initGitRepo,
  makeTempDir,
  removeTemp,
  runGitWorktreeManager,
} from './run.js';

describe('git-worktree-manager worktree create', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      removeTemp(root);
    }
  });

  it('creates a worktree under .workspaces', () => {
    const root = makeTempDir('git-worktree-manager-workspaces-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);

    const added = runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env);
    expect(added.status).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const checkout = resolve(repoPath, '.workspaces', 'login');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('login');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
  });

  it('creates a sibling worktree next to the repository', () => {
    const root = makeTempDir('git-worktree-manager-sibling-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);

    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');
    const added = runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env);
    expect(added.status).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const checkout = resolve(root, 'login');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('login');
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
  });

  it('creates under .workspaces when only the old config directory is present', () => {
    const root = makeTempDir('git-worktree-manager-old-config-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);

    mkdirSync(join(repoPath, '.git-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    expect(existsSync(resolve(repoPath, '.workspaces', 'login'))).toBe(true);
    expect(existsSync(resolve(root, 'login'))).toBe(false);
  });

  it('creates feature/foo in a feature-foo folder without renaming the branch', () => {
    const root = makeTempDir('git-worktree-manager-sanitize-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'feature/foo']);
    const env = gitWorktreeManagerEnv(registryPath);

    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'feature/foo', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const checkout = resolve(repoPath, '.workspaces', 'feature-foo');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature/foo');
  });

  it('stops when that folder already exists and leaves git unchanged', () => {
    const root = makeTempDir('git-worktree-manager-exists-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const checkout = join(repoPath, '.workspaces', 'login');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'keep.txt'), 'stay');
    const worktreesBefore = git(repoPath, ['worktree', 'list']);
    const branchesBefore = git(repoPath, ['branch', '--list']);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );

    expect(created.status).toBe(1);
    expect(created.stderr).not.toBe('');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(git(repoPath, ['branch', '--list'])).toBe(branchesBefore);
    expect(readFileSync(join(checkout, 'keep.txt'), 'utf8')).toBe('stay');
  });

  it('uses the layout mode from the repository config when that key is set', () => {
    const root = makeTempDir('git-worktree-manager-config-layout-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[layout]\nmode = "sibling"\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const checkout = resolve(root, 'login');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('login');
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
  });

  it('fetches a remote-only branch before the create hook runs', () => {
    const root = makeTempDir('git-worktree-manager-fetch-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const remotePath = join(root, 'origin.git');
    const otherPath = join(root, 'other');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], {
      cwd: remotePath,
      stdio: 'ignore',
    });
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

    mkdirSync(join(repoPath, 'hooks'), { recursive: true });
    writeFileSync(
      join(repoPath, 'hooks', 'mark.mjs'),
      [
        "import { execFileSync } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const ref = execFileSync('git', ['show-ref', '--verify', 'refs/remotes/origin/feature'], { encoding: 'utf8' }).trim();",
        "console.log('fetched-ref ' + ref);",
        "writeFileSync('hook-ran.txt', 'ran');",
        "writeFileSync('hook-source.json', JSON.stringify({",
        '  branchSource: process.env.GIT_WORKTREE_MANAGER_BRANCH_SOURCE,',
        '  remote: process.env.GIT_WORKTREE_MANAGER_REMOTE ?? null,',
        '}));',
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks.pre_worktree_create]\ncommands = ["node hooks/mark.mjs"]\n',
    );

    expect(() =>
      execFileSync('git', ['show-ref', '--verify', 'refs/remotes/origin/feature'], {
        cwd: repoPath,
        stdio: 'ignore',
      }),
    ).toThrow();

    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'feature', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(
      /fetched-ref [0-9a-f]{40} refs\/remotes\/origin\/feature/,
    );
    expect(readFileSync(join(repoPath, 'hook-ran.txt'), 'utf8')).toBe('ran');
    expect(JSON.parse(readFileSync(join(repoPath, 'hook-source.json'), 'utf8'))).toEqual({
      branchSource: 'remote',
      remote: 'origin',
    });

    const checkout = resolve(repoPath, '.workspaces', 'feature');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature');
  });

  it('leaves no worktree when a TypeScript plugin returns abort', () => {
    const root = makeTempDir('git-worktree-manager-abort-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
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
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    const worktreesBefore = git(repoPath, ['worktree', 'list']);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );

    expect(created.status).toBe(1);
    expect(created.stderr).toContain('abort');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
  });

  it('keeps the loader error when a configured hook module is missing', () => {
    const root = makeTempDir('git-worktree-manager-missing-module-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks]\nmodules = ["plugins/missing.ts"]\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);
    const worktreesBefore = git(repoPath, ['worktree', 'list']);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(1);
    expect(created.stderr).not.toBe('');
    expect(created.stderr).not.toContain('Could not load hook module:');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);

    const checkout = join(repoPath, '.workspaces', 'login');
    git(repoPath, ['worktree', 'add', checkout, 'login']);
    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--keep-branch'],
      env,
    );
    expect(removed.status).toBe(1);
    expect(removed.stderr).not.toBe('');
    expect(removed.stderr).not.toContain('Could not load hook module:');
    expect(existsSync(checkout)).toBe(true);
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('runs a shell command and a TypeScript plugin when creating a worktree', () => {
    const root = makeTempDir('git-worktree-manager-both-hooks-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, 'hooks'), { recursive: true });
    writeFileSync(
      join(repoPath, 'hooks', 'mark.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('shell-ran.txt', 'ran');\n",
    );
    const pluginMarker = join(repoPath, 'plugin-ran.txt');
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    writeFileSync(
      join(repoPath, 'plugins', 'mark.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        'export default {',
        "  name: 'mark',",
        '  preWorktreeCreate(): void {',
        `    writeFileSync(${JSON.stringify(pluginMarker)}, 'ran');`,
        '  },',
        '};',
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
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);
    expect(readFileSync(join(repoPath, 'shell-ran.txt'), 'utf8')).toBe('ran');
    expect(readFileSync(pluginMarker, 'utf8')).toBe('ran');
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(true);
  });

  it('passes the branch and paths into create plugins', () => {
    const root = makeTempDir('git-worktree-manager-plugin-context-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    const contextPath = join(repoPath, 'context.json');
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    writeFileSync(
      join(repoPath, 'plugins', 'record.ts'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        'const seen = [];',
        'export default {',
        "  name: 'record-context',",
        '  preWorktreeCreate(ctx) {',
        '    seen.push({ phase: "pre", ...ctx, worktreeExists: existsSync(ctx.worktreePath) });',
        '  },',
        '  postWorktreeCreate(ctx) {',
        '    seen.push({ phase: "post", ...ctx, worktreeExists: existsSync(ctx.worktreePath) });',
        `    writeFileSync(${JSON.stringify(contextPath)}, JSON.stringify(seen));`,
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks]\nmodules = ["plugins/record.ts"]\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'feature/login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const checkout = resolve(repoPath, '.workspaces', 'feature-login');
    expect(JSON.parse(readFileSync(contextPath, 'utf8'))).toEqual([
      {
        phase: 'pre',
        branch: 'feature/login',
        worktreePath: checkout,
        repositoryPath: resolve(repoPath),
        branchSource: { kind: 'new' },
        worktreeExists: false,
      },
      {
        phase: 'post',
        branch: 'feature/login',
        worktreePath: checkout,
        repositoryPath: resolve(repoPath),
        branchSource: { kind: 'new' },
        worktreeExists: true,
      },
    ]);
  });

  it('passes the branch and paths to create commands', () => {
    const root = makeTempDir('git-worktree-manager-hook-env-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, 'hooks'), { recursive: true });
    writeFileSync(
      join(repoPath, 'hooks', 'env.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(',
        "  'hook-env.json',",
        '  JSON.stringify({',
        '    branch: process.env.GIT_WORKTREE_MANAGER_BRANCH,',
        '    worktreePath: process.env.GIT_WORKTREE_MANAGER_WORKTREE_PATH,',
        '    repositoryPath: process.env.GIT_WORKTREE_MANAGER_REPOSITORY_PATH,',
        '    branchSource: process.env.GIT_WORKTREE_MANAGER_BRANCH_SOURCE,',
        '    remote: process.env.GIT_WORKTREE_MANAGER_REMOTE ?? null,',
        '  }),',
        ');',
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks.pre_worktree_create]\ncommands = ["node hooks/env.mjs"]\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);
    expect(JSON.parse(readFileSync(join(repoPath, 'hook-env.json'), 'utf8'))).toEqual({
      branch: 'login',
      worktreePath: resolve(repoPath, '.workspaces', 'login'),
      repositoryPath: resolve(repoPath),
      branchSource: 'local',
      remote: null,
    });
  });

  it('copies .env into the worktree as a file that can be edited', () => {
    const root = makeTempDir('git-worktree-manager-copy-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    writeFileSync(join(repoPath, '.env'), 'SECRET=1\n');
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[copy]\nfiles = [".env"]\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const created = runGitWorktreeManager(
      ['worktree', 'create', 'login', '--repo', 'Harbor'],
      env,
    );
    expect(created.status).toBe(0);

    const copied = join(repoPath, '.workspaces', 'login', '.env');
    expect(readFileSync(copied, 'utf8')).toBe('SECRET=1\n');
    writeFileSync(copied, 'SECRET=2\n');
    expect(readFileSync(copied, 'utf8')).toBe('SECRET=2\n');
    expect(readFileSync(join(repoPath, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('lists only the repository after a worktree is created', () => {
    const root = makeTempDir('git-worktree-manager-list-after-create-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);

    const listed = runGitWorktreeManager(['list'], env);
    expect(listed.stdout).toBe(`Harbor\t${resolve(repoPath)}\n`);
  });

  it('removes the worktree and leaves the branch', () => {
    const root = makeTempDir('git-worktree-manager-remove-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--keep-branch'],
      env,
    );
    expect(removed.status).toBe(0);
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
  });

  it('does not remove the primary checkout', () => {
    const root = makeTempDir('git-worktree-manager-remove-primary-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'master', '--repo', 'Harbor'],
      env,
    );
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('No worktree for branch');
    expect(git(repoPath, ['worktree', 'list'])).toContain(resolve(repoPath));
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
  });

  it('refuses remove when both branch flags are set', () => {
    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch', '--keep-branch'],
      {},
    );
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('Pass only one of --delete-branch or --keep-branch');
  });

  it('asks for a branch choice when remove has no terminal and no flag', () => {
    const root = makeTempDir('git-worktree-manager-remove-flag-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor'],
      env,
    );

    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('Pass --delete-branch or --keep-branch');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('deletes the local branch and leaves the remote branch', () => {
    const root = makeTempDir('git-worktree-manager-delete-branch-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const remotePath = join(root, 'origin.git');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: remotePath, stdio: 'ignore' });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    git(repoPath, ['branch', 'login']);
    git(repoPath, ['push', '-u', 'origin', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch'],
      env,
    );

    expect(removed.status).toBe(0);
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(() => git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toThrow();
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/remotes/origin/login'])).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it('refuses a dirty checkout until remove is forced', () => {
    const root = makeTempDir('git-worktree-manager-remove-dirty-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');
    writeFileSync(join(checkout, 'dirty.txt'), 'dirty\n');

    const refused = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch'],
      env,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('use --force to delete it');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toMatch(/^[0-9a-f]{40}$/);

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch', '--force'],
      env,
    );
    expect(removed.status).toBe(0);
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(checkout);
    expect(() => git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toThrow();
  });

  it('stops before removing a worktree when a plugin returns abort', () => {
    const root = makeTempDir('git-worktree-manager-remove-abort-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    writeFileSync(
      join(repoPath, 'plugins', 'abort.ts'),
      [
        'export default {',
        "  name: 'abort-remove',",
        "  preWorktreeRemove(): 'abort' {",
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
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch'],
      env,
    );

    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain('abort-remove aborted worktree remove');
    expect(git(repoPath, ['worktree', 'list'])).toContain(checkout);
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('passes the branch, path, and delete choice into remove plugins', () => {
    const root = makeTempDir('git-worktree-manager-remove-context-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    const contextPath = join(repoPath, 'remove-context.json');
    mkdirSync(join(repoPath, 'plugins'), { recursive: true });
    writeFileSync(
      join(repoPath, 'plugins', 'record.ts'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        'const seen = [];',
        'export default {',
        "  name: 'record-remove',",
        '  preWorktreeRemove(ctx) {',
        '    seen.push({ phase: "pre", ...ctx, worktreeExists: existsSync(ctx.worktreePath) });',
        '  },',
        '  postWorktreeRemove(ctx) {',
        '    seen.push({ phase: "post", ...ctx, worktreeExists: existsSync(ctx.worktreePath) });',
        `    writeFileSync(${JSON.stringify(contextPath)}, JSON.stringify(seen));`,
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git-worktree-manager', 'config.toml'),
      '[hooks]\nmodules = ["plugins/record.ts"]\n',
    );
    const env = gitWorktreeManagerEnv(registryPath);
    expect(
      runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status,
    ).toBe(0);
    expect(
      runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env).status,
    ).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');

    const removed = runGitWorktreeManager(
      ['worktree', 'remove', 'login', '--repo', 'Harbor', '--delete-branch'],
      env,
    );

    expect(removed.status).toBe(0);
    expect(JSON.parse(readFileSync(contextPath, 'utf8'))).toEqual([
      {
        phase: 'pre',
        branch: 'login',
        worktreePath: checkout,
        repositoryPath: resolve(repoPath),
        deleteBranch: true,
        worktreeExists: true,
      },
      {
        phase: 'post',
        branch: 'login',
        worktreePath: checkout,
        repositoryPath: resolve(repoPath),
        deleteBranch: true,
        worktreeExists: false,
      },
    ]);
    expect(() => git(repoPath, ['rev-parse', '--verify', 'refs/heads/login'])).toThrow();
  });

  it('leaves an existing workspaces checkout in place when the app default becomes Sibling', () => {
    const root = makeTempDir('git-worktree-manager-app-default-stays-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    git(repoPath, ['branch', 'notes']);
    const env = {
      ...gitWorktreeManagerEnv(registryPath),
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath,
    };
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env);
    expect(created.status).toBe(0);
    const existing = resolve(repoPath, '.workspaces', 'login');
    expect(existsSync(existing)).toBe(true);
    expect(git(existing, ['branch', '--show-current'])).toBe('login');

    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');

    const next = runGitWorktreeManager(['worktree', 'create', 'notes', '--repo', 'Harbor'], env);
    expect(next.status).toBe(0);
    expect(existsSync(existing)).toBe(true);
    expect(git(existing, ['branch', '--show-current'])).toBe('login');
    const sibling = resolve(root, 'notes');
    expect(existsSync(sibling)).toBe(true);
    expect(git(sibling, ['branch', '--show-current'])).toBe('notes');
    expect(existsSync(join(repoPath, '.workspaces', 'notes'))).toBe(false);
  });

  it('uses the repository Workspaces layout when the app default is Sibling', () => {
    const root = makeTempDir('git-worktree-manager-repo-workspaces-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "workspaces"\n');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');
    const env = {
      ...gitWorktreeManagerEnv(registryPath),
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath,
    };
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env);
    expect(created.status).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'login');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('login');
    expect(existsSync(resolve(root, 'login'))).toBe(false);
  });

  it('uses the repository Sibling layout when the app default is Workspaces', () => {
    const root = makeTempDir('git-worktree-manager-repo-sibling-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "sibling"\n');
    writeFileSync(settingsPath, '{"defaultLayout":"workspaces"}\n');
    const env = {
      ...gitWorktreeManagerEnv(registryPath),
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath,
    };
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env);
    expect(created.status).toBe(0);
    const checkout = resolve(root, 'login');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('login');
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
  });

  it('creates nothing when the repository layout mode is unsupported', () => {
    const root = makeTempDir('git-worktree-manager-unsupported-layout-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = "custom"\n');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');
    const env = {
      ...gitWorktreeManagerEnv(registryPath),
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath,
    };
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);
    const worktreesBefore = git(repoPath, ['worktree', 'list']);

    const created = runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env);

    expect(created.status).toBe(1);
    expect(created.stderr).toContain('Unsupported layout: custom');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
    expect(existsSync(resolve(root, 'login'))).toBe(false);
  });

  it('creates nothing when the repository layout mode is not text', () => {
    const root = makeTempDir('git-worktree-manager-unsupported-layout-number-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    const settingsPath = join(root, 'app-settings.json');
    initGitRepo(repoPath);
    git(repoPath, ['branch', 'login']);
    mkdirSync(join(repoPath, '.git-worktree-manager'), { recursive: true });
    writeFileSync(join(repoPath, '.git-worktree-manager', 'config.toml'), '[layout]\nmode = 1\n');
    writeFileSync(settingsPath, '{"defaultLayout":"sibling"}\n');
    const env = {
      ...gitWorktreeManagerEnv(registryPath),
      GIT_WORKTREE_MANAGER_APP_SETTINGS_PATH: settingsPath,
    };
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);
    const worktreesBefore = git(repoPath, ['worktree', 'list']);

    const created = runGitWorktreeManager(['worktree', 'create', 'login', '--repo', 'Harbor'], env);

    expect(created.status).toBe(1);
    expect(created.stderr).toContain('Unsupported layout: 1');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'login'))).toBe(false);
    expect(existsSync(resolve(root, 'login'))).toBe(false);
  });

  it('creates a local branch when the name is not on the remote', () => {
    const root = makeTempDir('git-worktree-manager-new-local-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const remotePath = join(root, 'origin.git');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'master'], {
      cwd: remotePath,
      stdio: 'ignore',
    });
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'master']);
    writeFileSync(join(repoPath, 'local.txt'), 'only local\n');
    git(repoPath, ['add', 'local.txt']);
    git(repoPath, ['commit', '-m', 'local only']);
    const head = git(repoPath, ['rev-parse', 'HEAD']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(['worktree', 'create', 'test', '--repo', 'Harbor'], env);

    expect(created.status).toBe(0);
    expect(created.stderr).not.toContain('Command failed');
    const checkout = resolve(repoPath, '.workspaces', 'test');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('test');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
    expect(() => git(checkout, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toThrow();
  });

  it('creates a new local branch with a slash in the name when there is no remote', () => {
    const root = makeTempDir('git-worktree-manager-new-local-slash-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    const head = git(repoPath, ['rev-parse', 'HEAD']);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);

    const created = runGitWorktreeManager(['worktree', 'create', 'feature/foo', '--repo', 'Harbor'], env);

    expect(created.status).toBe(0);
    const checkout = resolve(repoPath, '.workspaces', 'feature-foo');
    expect(existsSync(checkout)).toBe(true);
    expect(git(checkout, ['branch', '--show-current'])).toBe('feature/foo');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('master');
  });

  it('does not create a local branch when fetch fails for another reason', () => {
    const root = makeTempDir('git-worktree-manager-fetch-unreadable-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    git(repoPath, ['remote', 'add', 'origin', join(root, 'missing.git')]);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);
    const branchesBefore = git(repoPath, ['branch', '--list']);

    const created = runGitWorktreeManager(['worktree', 'create', 'test', '--repo', 'Harbor'], env);

    expect(created.status).toBe(1);
    expect(created.stderr).toContain('does not appear to be a git repository');
    expect(created.stderr).not.toContain('Command failed');
    expect(git(repoPath, ['branch', '--list'])).toBe(branchesBefore);
    expect(existsSync(join(repoPath, '.workspaces', 'test'))).toBe(false);
  });

  it('asks for a branch name when the name is empty', () => {
    const root = makeTempDir('git-worktree-manager-empty-branch-');
    roots.push(root);
    const repoPath = join(root, 'harbor');
    const registryPath = join(root, 'registry.db');
    initGitRepo(repoPath);
    const env = gitWorktreeManagerEnv(registryPath);
    expect(runGitWorktreeManager(['add', '--path', repoPath, '--name', 'Harbor'], env).status).toBe(0);
    const worktreesBefore = git(repoPath, ['worktree', 'list']);

    const created = runGitWorktreeManager(['worktree', 'create', ' ', '--repo', 'Harbor'], env);

    expect(created.status).toBe(1);
    expect(created.stderr).toContain('Enter a branch name');
    expect(git(repoPath, ['worktree', 'list'])).toBe(worktreesBefore);
  });
});
