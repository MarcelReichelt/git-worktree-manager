import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { createJiti } from 'jiti';
import { createLayoutForRepository, unpinWorktree } from './app-settings.js';
import { findRepository } from './registry.js';

type LayoutMode = 'workspaces' | 'sibling';

interface RepoConfig {
  layout?: { mode?: string };
  copy?: { files?: string[] };
  hooks?: {
    modules?: string[];
    pre_worktree_create?: { commands?: string[] };
    post_worktree_create?: { commands?: string[] };
    pre_worktree_remove?: { commands?: string[] };
    post_worktree_remove?: { commands?: string[] };
  };
}

export type WorktreeBranchSource =
  | { kind: 'local' }
  | { kind: 'new' }
  | { kind: 'remote'; remote: string };

export interface WorktreeCreateContext {
  branch: string;
  worktreePath: string;
  repositoryPath: string;
  branchSource: WorktreeBranchSource;
}

export interface WorktreeRemoveContext {
  branch: string;
  worktreePath: string;
  repositoryPath: string;
  deleteBranch: boolean;
}

type HookContext = WorktreeCreateContext | WorktreeRemoveContext;

interface WorktreePlugin {
  name: string;
  preWorktreeCreate?: (
    context: WorktreeCreateContext,
  ) => 'abort' | void | Promise<'abort' | void>;
  postWorktreeCreate?: (context: WorktreeCreateContext) => void | Promise<void>;
  preWorktreeRemove?: (
    context: WorktreeRemoveContext,
  ) => 'abort' | void | Promise<'abort' | void>;
  postWorktreeRemove?: (context: WorktreeRemoveContext) => void | Promise<void>;
}

function folderName(branch: string): string {
  return branch.replace(/[/\\<>:"|?*\u0000-\u001f\u007f]/g, '-');
}

function readRepoConfig(repoPath: string): RepoConfig {
  const configPath = join(repoPath, '.git-worktree-manager', 'config.toml');
  if (!existsSync(configPath)) {
    return {};
  }
  return TOML.parse(readFileSync(configPath, 'utf8')) as RepoConfig;
}

export interface CreateHookRow {
  id: string;
  phase: 'pre' | 'post';
  label: string;
}

export interface CreateHookListing {
  rows: CreateHookRow[];
  loadErrors: string[];
}

export function createHookModulePaths(repoPath: string): string[] {
  return readRepoConfig(repoPath).hooks?.modules ?? [];
}

export function listCreateHooks(repoPath: string): CreateHookListing {
  const config = readRepoConfig(repoPath);
  const { loaded, loadErrors } = loadListedPlugins(repoPath, config.hooks?.modules);
  return {
    rows: [
      ...createCommandRows('pre', 'pre-command', config.hooks?.pre_worktree_create?.commands),
      ...createPluginRows('pre', 'pre-plugin', loaded, 'preWorktreeCreate'),
      ...createCommandRows('post', 'post-command', config.hooks?.post_worktree_create?.commands),
      ...createPluginRows('post', 'post-plugin', loaded, 'postWorktreeCreate'),
    ],
    loadErrors,
  };
}

export function listRemoveHooks(repoPath: string): CreateHookListing {
  const config = readRepoConfig(repoPath);
  const { loaded, loadErrors } = loadListedPlugins(repoPath, config.hooks?.modules);
  return {
    rows: [
      ...createCommandRows('pre', 'pre-command', config.hooks?.pre_worktree_remove?.commands),
      ...createPluginRows('pre', 'pre-plugin', loaded, 'preWorktreeRemove'),
      ...createCommandRows('post', 'post-command', config.hooks?.post_worktree_remove?.commands),
      ...createPluginRows('post', 'post-plugin', loaded, 'postWorktreeRemove'),
    ],
    loadErrors,
  };
}

function createCommandRows(
  phase: 'pre' | 'post',
  kind: string,
  commands: string[] | undefined,
): CreateHookRow[] {
  return (commands ?? []).map((command, index) => ({
    id: `${kind}:${index}`,
    phase,
    label: command,
  }));
}

interface ListedPlugin {
  moduleIndex: number;
  modulePath: string;
  plugin: WorktreePlugin;
}

function loadListedPlugins(
  repoPath: string,
  modules: string[] | undefined,
): { loaded: ListedPlugin[]; loadErrors: string[] } {
  if (!modules || modules.length === 0) {
    return { loaded: [], loadErrors: [] };
  }
  const jiti = createJiti(join(repoPath, 'package.json'));
  const loaded: ListedPlugin[] = [];
  const loadErrors: string[] = [];
  for (const [moduleIndex, modulePath] of modules.entries()) {
    try {
      const imported = jiti(resolve(repoPath, modulePath)) as WorktreePlugin & {
        default?: WorktreePlugin;
      };
      loaded.push({ moduleIndex, modulePath, plugin: imported.default ?? imported });
    } catch {
      loadErrors.push(`Could not load hook module: ${modulePath}`);
    }
  }
  return { loaded, loadErrors };
}

function createPluginRows(
  phase: 'pre' | 'post',
  kind: string,
  loaded: ListedPlugin[],
  method: 'preWorktreeCreate' | 'postWorktreeCreate' | 'preWorktreeRemove' | 'postWorktreeRemove',
): CreateHookRow[] {
  const peers = loaded.filter((entry) => typeof entry.plugin[method] === 'function');
  return peers.map((entry) => ({
    id: `${kind}:${entry.moduleIndex}`,
    phase,
    label: createPluginLabel(entry, peers),
  }));
}

function createPluginLabel(entry: ListedPlugin, peers: ListedPlugin[]): string {
  const name = pluginName(entry.plugin);
  if (name === '') {
    return entry.modulePath;
  }
  const sameName = peers.filter((peer) => pluginName(peer.plugin) === name);
  return sameName.length > 1 ? entry.modulePath : name;
}

function pluginName(plugin: WorktreePlugin): string {
  return typeof plugin.name === 'string' ? plugin.name.trim() : '';
}

function layoutForCreate(repoPath: string): LayoutMode {
  const layout = createLayoutForRepository(repoPath);
  if (!layout.supported) {
    throw new Error(`Unsupported layout: ${layout.label}`);
  }
  return layout.label === 'Sibling' ? 'sibling' : 'workspaces';
}

function remoteNames(repoPath: string): string[] {
  try {
    return execFileSync('git', ['remote'], { cwd: repoPath, encoding: 'utf8' })
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  } catch {
    return [];
  }
}

function remoteToFetch(repoPath: string, branch: string): string {
  const names = remoteNames(repoPath);
  const holders = names.filter((name) => hasRef(repoPath, `refs/remotes/${name}/${branch}`));
  if (holders.includes('origin') || holders.length === 0) {
    return 'origin';
  }
  return holders[0] ?? 'origin';
}

function commandText(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

function gitCommandError(error: unknown): Error {
  const failed = error as { stderr?: string | Buffer; message?: string };
  const detail = commandText(failed.stderr).trim();
  if (detail !== '') {
    return new Error(detail);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error('git failed');
}

function isMissingRemoteBranch(error: unknown): boolean {
  const failed = error as { stderr?: string | Buffer; message?: string };
  const text = `${commandText(failed.stderr)}\n${failed.message ?? ''}`;
  return text.toLowerCase().includes('find remote ref');
}

function runGit(repoPath: string, args: string[]): void {
  try {
    execFileSync('git', args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (error) {
    throw gitCommandError(error);
  }
}

type BranchCheckout = 'local' | 'new' | { remote: string };

function resolveBranch(repoPath: string, branch: string): BranchCheckout {
  if (hasRef(repoPath, `refs/heads/${branch}`)) {
    return 'local';
  }
  const remote = remoteToFetch(repoPath, branch);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const expectsRemote = hasRef(repoPath, trackingRef);
  if (!expectsRemote && !remoteNames(repoPath).includes(remote)) {
    return 'new';
  }
  try {
    execFileSync('git', ['fetch', remote, branch], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (error) {
    if (!expectsRemote && isMissingRemoteBranch(error)) {
      return 'new';
    }
    throw gitCommandError(error);
  }
  if (!hasRef(repoPath, trackingRef)) {
    if (expectsRemote) {
      throw new Error(`Branch not found: ${branch}`);
    }
    return 'new';
  }
  return { remote };
}

function hasRef(repoPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function worktreeBranchSource(mode: BranchCheckout): WorktreeBranchSource {
  if (mode === 'local') {
    return { kind: 'local' };
  }
  if (mode === 'new') {
    return { kind: 'new' };
  }
  return { kind: 'remote', remote: mode.remote };
}

function hookEnvironment(context: HookContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_WORKTREE_MANAGER_BRANCH: context.branch,
    GIT_WORKTREE_MANAGER_WORKTREE_PATH: context.worktreePath,
    GIT_WORKTREE_MANAGER_REPOSITORY_PATH: context.repositoryPath,
  };
  delete env.GIT_WORKTREE_MANAGER_BRANCH_SOURCE;
  delete env.GIT_WORKTREE_MANAGER_REMOTE;
  delete env.GIT_WORKTREE_MANAGER_DELETE_BRANCH;
  if ('branchSource' in context) {
    env.GIT_WORKTREE_MANAGER_BRANCH_SOURCE = context.branchSource.kind;
    if (context.branchSource.kind === 'remote') {
      env.GIT_WORKTREE_MANAGER_REMOTE = context.branchSource.remote;
    }
  }
  if ('deleteBranch' in context) {
    env.GIT_WORKTREE_MANAGER_DELETE_BRANCH = context.deleteBranch ? 'true' : 'false';
  }
  return env;
}

function runHookCommands(
  repoPath: string,
  commands: string[] | undefined,
  context: HookContext,
  skip?: ReadonlySet<number>,
): void {
  for (const [index, command] of (commands ?? []).entries()) {
    if (skip?.has(index)) {
      continue;
    }
    execSync(command, {
      cwd: repoPath,
      stdio: 'inherit',
      env: hookEnvironment(context),
    });
  }
}

interface LoadedPlugin {
  moduleIndex: number;
  plugin: WorktreePlugin;
}

async function loadPlugins(
  repoPath: string,
  modules: string[] | undefined,
  options?: { createLoadError?: boolean },
): Promise<LoadedPlugin[]> {
  if (!modules || modules.length === 0) {
    return [];
  }
  const jiti = createJiti(join(repoPath, 'package.json'));
  const plugins: LoadedPlugin[] = [];
  for (const [moduleIndex, modulePath] of modules.entries()) {
    try {
      // jiti.import() uses dynamic import(). The desktop window is a classic
      // script, so that import tries to fetch node builtins such as node:fs.
      const loaded = jiti(resolve(repoPath, modulePath)) as WorktreePlugin & {
        default?: WorktreePlugin;
      };
      plugins.push({ moduleIndex, plugin: loaded.default ?? loaded });
    } catch (error) {
      if (options?.createLoadError) {
        throw new Error(`Could not load hook module: ${modulePath}`);
      }
      throw error;
    }
  }
  return plugins;
}

function skippedHookIndexes(skip: ReadonlySet<string> | undefined, kind: string): ReadonlySet<number> | undefined {
  if (!skip || skip.size === 0) {
    return undefined;
  }
  const indexes = new Set<number>();
  const prefix = `${kind}:`;
  for (const id of skip) {
    if (!id.startsWith(prefix)) {
      continue;
    }
    const index = Number(id.slice(prefix.length));
    if (Number.isInteger(index) && index >= 0) {
      indexes.add(index);
    }
  }
  return indexes;
}

async function runPrePlugins(
  plugins: LoadedPlugin[],
  context: WorktreeCreateContext,
  skip?: ReadonlySet<number>,
): Promise<void> {
  for (const entry of plugins) {
    if (skip?.has(entry.moduleIndex)) {
      continue;
    }
    const result = await entry.plugin.preWorktreeCreate?.(context);
    if (result === 'abort') {
      throw new Error(`${entry.plugin.name} aborted worktree create`);
    }
  }
}

async function runPostPlugins(
  plugins: LoadedPlugin[],
  context: WorktreeCreateContext,
  skip?: ReadonlySet<number>,
): Promise<void> {
  for (const entry of plugins) {
    if (skip?.has(entry.moduleIndex)) {
      continue;
    }
    await entry.plugin.postWorktreeCreate?.(context);
  }
}

async function runPreRemovePlugins(
  plugins: LoadedPlugin[],
  context: WorktreeRemoveContext,
  skip?: ReadonlySet<number>,
): Promise<void> {
  for (const entry of plugins) {
    if (skip?.has(entry.moduleIndex)) {
      continue;
    }
    const result = await entry.plugin.preWorktreeRemove?.(context);
    if (result === 'abort') {
      throw new Error(`${entry.plugin.name} aborted worktree remove`);
    }
  }
}

async function runPostRemovePlugins(
  plugins: LoadedPlugin[],
  context: WorktreeRemoveContext,
  skip?: ReadonlySet<number>,
): Promise<void> {
  for (const entry of plugins) {
    if (skip?.has(entry.moduleIndex)) {
      continue;
    }
    await entry.plugin.postWorktreeRemove?.(context);
  }
}

function removableCheckout(repoQuery: string, branch: string): { repoPath: string; checkout: string } {
  const repository = findRepository(repoQuery);
  if (!repository) {
    throw new Error(`Repository not found: ${repoQuery}`);
  }
  return {
    repoPath: repository.path,
    checkout: findBranchCheckout(repository.path, branch),
  };
}

export function assertWorktreeRemovable(repoQuery: string, branch: string): void {
  removableCheckout(repoQuery, branch);
}

function copyConfiguredFiles(
  repoPath: string,
  checkout: string,
  files: string[] | undefined,
): void {
  for (const file of files ?? []) {
    const source = join(repoPath, file);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(checkout, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

export function findCheckout(repoPath: string, branch: string): string | undefined {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  for (const block of output.split('\n\n')) {
    let path: string | undefined;
    let ref: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        ref = line.slice('branch '.length);
      }
    }
    if (path && ref === `refs/heads/${branch}`) {
      return path;
    }
  }
  return undefined;
}

export function findBranchCheckout(repoPath: string, branch: string): string {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  const primary = resolve(repoPath);
  for (const block of output.split('\n\n')) {
    let path: string | undefined;
    let ref: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        ref = line.slice('branch '.length);
      }
    }
    if (path && ref === `refs/heads/${branch}` && resolve(path) !== primary) {
      return path;
    }
  }
  throw new Error(`No worktree for branch: ${branch}`);
}

function checkoutPath(repositoryPath: string, layout: LayoutMode, folder: string): string {
  if (layout === 'sibling') {
    return join(dirname(repositoryPath), folder);
  }
  return join(repositoryPath, '.workspaces', folder);
}

export interface CreateWorktreeOptions {
  skip?: ReadonlySet<string>;
}

export async function createWorktree(
  repoQuery: string,
  branch: string,
  options?: CreateWorktreeOptions,
): Promise<string> {
  const repository = findRepository(repoQuery);
  if (!repository) {
    throw new Error(`Repository not found: ${repoQuery}`);
  }
  if (branch.trim() === '') {
    throw new Error('Enter a branch name');
  }

  const config = readRepoConfig(repository.path);
  const checkout = checkoutPath(repository.path, layoutForCreate(repository.path), folderName(branch));
  if (existsSync(checkout)) {
    throw new Error(`Worktree folder already exists: ${checkout}`);
  }

  const mode = resolveBranch(repository.path, branch);
  const context: WorktreeCreateContext = {
    branch,
    worktreePath: checkout,
    repositoryPath: repository.path,
    branchSource: worktreeBranchSource(mode),
  };

  const plugins = await loadPlugins(repository.path, config.hooks?.modules, { createLoadError: true });
  const skip = options?.skip;
  runHookCommands(
    repository.path,
    config.hooks?.pre_worktree_create?.commands,
    context,
    skippedHookIndexes(skip, 'pre-command'),
  );
  await runPrePlugins(plugins, context, skippedHookIndexes(skip, 'pre-plugin'));

  mkdirSync(dirname(checkout), { recursive: true });
  if (mode === 'local') {
    runGit(repository.path, ['worktree', 'add', checkout, branch]);
  } else if (mode === 'new') {
    runGit(repository.path, ['worktree', 'add', '-b', branch, checkout, 'HEAD']);
  } else {
    runGit(repository.path, [
      'worktree',
      'add',
      '--track',
      '-b',
      branch,
      checkout,
      `${mode.remote}/${branch}`,
    ]);
  }

  copyConfiguredFiles(repository.path, checkout, config.copy?.files);
  runHookCommands(
    repository.path,
    config.hooks?.post_worktree_create?.commands,
    context,
    skippedHookIndexes(skip, 'post-command'),
  );
  await runPostPlugins(plugins, context, skippedHookIndexes(skip, 'post-plugin'));
  return checkout;
}

export async function removeWorktree(
  repoQuery: string,
  branch: string,
  options: { deleteBranch: boolean; force?: boolean; skip?: ReadonlySet<string> },
): Promise<void> {
  const { repoPath, checkout } = removableCheckout(repoQuery, branch);
  const config = readRepoConfig(repoPath);
  const context: WorktreeRemoveContext = {
    branch,
    worktreePath: checkout,
    repositoryPath: repoPath,
    deleteBranch: options.deleteBranch,
  };
  const plugins = await loadPlugins(repoPath, config.hooks?.modules, { createLoadError: true });
  const skip = options.skip;
  runHookCommands(
    repoPath,
    config.hooks?.pre_worktree_remove?.commands,
    context,
    skippedHookIndexes(skip, 'pre-command'),
  );
  await runPreRemovePlugins(plugins, context, skippedHookIndexes(skip, 'pre-plugin'));
  const removeArgs = ['worktree', 'remove'];
  if (options.force) {
    removeArgs.push('--force');
  }
  removeArgs.push(checkout);
  runGit(repoPath, removeArgs);
  if (options.deleteBranch) {
    runGit(repoPath, ['branch', '-D', branch]);
  }
  unpinWorktree(repoPath, branch);
  runHookCommands(
    repoPath,
    config.hooks?.post_worktree_remove?.commands,
    context,
    skippedHookIndexes(skip, 'post-command'),
  );
  await runPostRemovePlugins(plugins, context, skippedHookIndexes(skip, 'post-plugin'));
}
