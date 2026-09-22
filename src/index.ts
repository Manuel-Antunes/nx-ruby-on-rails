import {
  CreateDependencies,
  CreateNodesV2,
  DependencyType,
  RawProjectGraphDependency,
  TargetConfiguration,
  validateDependency,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

/** Nx file paths are always posix; normalize away Windows separators. */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/**
 * The recursive Gemfile glob also matches Gemfiles that are NOT workspace
 * projects: installed/vendored gems (`vendor/bundle`, `vendor/cache`), the path gems we
 * vendor for Docker (`.workspace-gems`), Bundler/tooling scratch dirs
 * (`.bundle`, `.ruby-lsp`, `tmp`), and JS deps (`node_modules`). Inferring
 * projects from those yields nameless graph nodes that fail with
 * "projects ... have no name provided", so they are filtered out. The repo-root
 * `Gemfile` (the unified manifest, projectRoot `.`) is skipped too — it is an
 * aggregation point, not an app to infer Rails/install targets on.
 */
const NON_PROJECT_GEMFILE =
  /(^|\/)(node_modules|vendor|\.bundle|\.workspace-gems|\.ruby-lsp|tmp|\.nx|\.git)(\/|$)/;

function isProjectGemfile(configFilePath: string): boolean {
  const path = toPosix(configFilePath);
  return path !== 'Gemfile' && !NON_PROJECT_GEMFILE.test(path);
}

/** Whether the unified root `Gemfile` `eval_gemfile`s this app's Gemfile. */
function rootEvalsApp(rootGemfileContent: string, projectRoot: string): boolean {
  const escaped = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`eval_gemfile\\s+["']${escaped}/Gemfile["']`).test(
    rootGemfileContent,
  );
}

/**
 * If a unified root `Gemfile` exists that `eval_gemfile`s this app's Gemfile,
 * returns the `BUNDLE_GEMFILE` value (relative to the app dir, e.g.
 * `../../Gemfile`) pointing `bundle` at that root Gemfile — so every `bundle …`
 * command for the app resolves the single unified bundle instead of a per-app
 * one that may never be installed. Returns null when the app is not part of a
 * unified root bundle. The value is relative so the cache hash stays
 * machine-independent; each target's cwd is the app root.
 */
function unifiedBundleGemfile(projectRoot: string, workspaceRoot: string): string | null {
  const rootGemfile = join(workspaceRoot, 'Gemfile');
  if (projectRoot === '.' || !existsSync(rootGemfile)) return null;
  if (!rootEvalsApp(readFileSync(rootGemfile, 'utf8'), projectRoot)) return null;
  const up = projectRoot
    .split('/')
    .map(() => '..')
    .join('/');
  return `${up}/Gemfile`;
}

/**
 * Names of the project's explicitly-declared targets (package.json `nx.targets`
 * or project.json `targets`) whose command runs `bundle`. Used to inject
 * `BUNDLE_GEMFILE` into them via Nx's target merge, so the unified-bundle env is
 * applied to user-defined targets (e.g. `graphql:generate`, `migrate`) without
 * repeating it in every command.
 */
function explicitBundleTargetNames(absoluteRoot: string): string[] {
  const names = new Set<string>();
  const collect = (targets: unknown): void => {
    if (!targets || typeof targets !== 'object') return;
    for (const [name, cfg] of Object.entries(
      targets as Record<string, { options?: { command?: unknown; commands?: unknown } }>,
    )) {
      const opts = cfg?.options ?? {};
      const cmds = [
        opts.command,
        ...(Array.isArray(opts.commands) ? opts.commands : []),
      ].filter((c): c is string => typeof c === 'string');
      if (cmds.some((c) => /(?:^|\s|&&|;|\|)\s*bundle(?:\s|$)/.test(c))) {
        names.add(name);
      }
    }
  };
  const readTargets = (
    file: string,
    pick: (json: { nx?: { targets?: unknown }; targets?: unknown }) => unknown,
  ): void => {
    const path = join(absoluteRoot, file);
    if (!existsSync(path)) return;
    try {
      collect(pick(JSON.parse(readFileSync(path, 'utf8'))));
    } catch {
      /* ignore malformed config */
    }
  };
  readTargets('package.json', (json) => json?.nx?.targets);
  readTargets('project.json', (json) => json?.targets);
  return [...names];
}

/**
 * Reads the local PATH gems out of a `Gemfile.lock` — in-repo gems referenced
 * with `path:` (e.g. `path: "../../libs/lighthouse-graphql"`), which Bundler
 * records as `remote: <relative path>` under a `PATH` section. GIT/GEM remotes
 * are URLs, so a non-URL `remote:` selects the local path gems — covering both
 * app-lock paths (`../../libs/…`) and unified root-lock paths (`libs/…`, which
 * have no leading dot). A bare `remote: .` is the gem's own self-reference and
 * is skipped. Returns the remotes verbatim, relative to the lockfile's dir.
 */
function readLocalPathGems(lockPath: string): string[] {
  if (!existsSync(lockPath)) {
    return [];
  }
  const lock = readFileSync(lockPath, 'utf8');
  return [...lock.matchAll(/^\s+remote:\s+(?!\w+:\/\/|git@)(\S+)\s*$/gm)]
    .map((m) => m[1])
    .filter((remote) => remote !== '.');
}

/**
 * Infers targets for Ruby projects from their Gemfile.
 *
 * Every Gemfile project gets an `install` target. Rails-specific targets
 * (`serve`, `precompile`, `test` → `rails test`) are only added for actual Rails
 * applications — detected by the presence of `bin/rails` or
 * `config/application.rb`. This prevents plain gems/libraries (which also have a
 * Gemfile, e.g. libs/lighthouse-graphql) from being mistaken for Rails apps and
 * given nonsensical `rails server` / `rails test` targets. Those projects define
 * their own targets (e.g. `bundle exec rspec`) via project.json.
 *
 * Two pruning executors prepare a Rails app for its folder-scoped Docker build:
 *   - `prune-lockfile` derives the app's `Gemfile.lock` from the monorepo's
 *     unified root `Gemfile.lock` (the Bundler analogue of
 *     `@nx/js:prune-lockfile`), keeping only the app's dependency closure and
 *     re-anchoring the path-gem `remote:` to the app directory.
 *   - `prune-path-gems` vendors the app's in-repo path gems into
 *     `<projectRoot>/.workspace-gems` (the Bundler analogue of
 *     `@nx/js:copy-workspace-modules`) so the build can use a folder context
 *     instead of the repo root.
 *
 * Both targets are declared explicitly in the app's package.json (e.g.
 * apps/chatwoot); `prune` (path-gems) `dependsOn` `prune-lockfile` so the
 * vendoring reads the freshly-pruned lock, and deploys reach them via the root
 * `deploy-sst`/`pre-deploy-sst` targets' `^prune` dependency. The path-gems
 * cache inputs use `^default` rather than a hardcoded gem path — the path gem is
 * registered as a project dependency by `createDependencies` below, so
 * `^default` automatically (and transitively) picks up the gem's source.
 */
export const createNodes: CreateNodesV2 = [
  '**/Gemfile',
  (configFilePaths, _options, context) => {
    return configFilePaths.filter(isProjectGemfile).map((configFilePath) => {
      const projectRoot = dirname(configFilePath);
      const absoluteRoot = join(context.workspaceRoot, projectRoot);
      const isRailsApp =
        existsSync(join(absoluteRoot, 'bin', 'rails')) ||
        existsSync(join(absoluteRoot, 'config', 'application.rb'));

      const targets: Record<string, TargetConfiguration> = {
        install: {
          command: 'bundle install',
          options: { cwd: projectRoot },
        },
      };

      if (isRailsApp) {
        targets.serve = {
          command: 'bundle exec rails server',
          options: { cwd: projectRoot },
          continuous: true,
        };
        targets.precompile = {
          command: 'bundle exec rails assets:precompile',
          options: { cwd: projectRoot },
        };
        targets.test = {
          command: 'bundle exec rails test',
          options: { cwd: projectRoot },
        };
      }

      // Unified bundle: when a root Gemfile `eval_gemfile`s this app, point every
      // `bundle …` command at it via BUNDLE_GEMFILE so they resolve the single
      // root-installed bundle. Applied to inferred targets here and merged into
      // the app's explicitly-declared bundle targets (graphql:generate, migrate,
      // …) by Nx, so it never has to be repeated per command.
      const bundleGemfile = unifiedBundleGemfile(projectRoot, context.workspaceRoot);
      if (bundleGemfile) {
        const withEnv = (t: TargetConfiguration): TargetConfiguration => ({
          ...t,
          options: {
            ...t.options,
            env: { ...t.options?.env, BUNDLE_GEMFILE: bundleGemfile },
          },
        });
        for (const name of Object.keys(targets)) {
          targets[name] = withEnv(targets[name]);
        }
        for (const name of explicitBundleTargetNames(absoluteRoot)) {
          targets[name] = withEnv(targets[name] ?? {});
        }
      }

      return [
        configFilePath,
        {
          projects: {
            [projectRoot]: {
              targets,
            },
          },
        },
      ];
    });
  },
];

/**
 * Registers each Ruby project's in-repo PATH gems as project-graph
 * dependencies. A `Gemfile.lock` entry like `remote: ../../libs/lighthouse-graphql`
 * becomes a static edge `<project> -> lighthouse-graphql`, mirroring how
 * workspace package deps are tracked for JS/TS projects. This lets Nx know the
 * app is affected when the gem changes and lets the app's `prune` target pull
 * the gem's source into its cache inputs via `^default` instead of hardcoding
 * the gem path. Because the edge is derived per project from each lockfile,
 * nested path gems (a path gem that itself references another) resolve
 * transitively through the graph.
 */
export const createDependencies: CreateDependencies = (_options, context) => {
  const rootToProject = new Map<string, string>();
  for (const [name, config] of Object.entries(context.projects)) {
    rootToProject.set(toPosix(config.root), name);
  }

  const rootGemfilePath = join(context.workspaceRoot, 'Gemfile');
  const rootGemfile = existsSync(rootGemfilePath)
    ? readFileSync(rootGemfilePath, 'utf8')
    : '';

  const dependencies: RawProjectGraphDependency[] = [];
  for (const [name, config] of Object.entries(context.projects)) {
    // Prefer the project's own Gemfile.lock. In a unified-bundle setup the app
    // lock is a generated/gitignored artifact, so fall back to the root lock
    // when the root Gemfile `eval_gemfile`s this app — keeping the path-gem edge
    // (and thus affected-detection) intact. `lockBase` is the directory the
    // lock's relative remotes resolve against.
    const ownLock = join(context.workspaceRoot, config.root, 'Gemfile.lock');
    let lockPath: string;
    let lockBase: string;
    if (existsSync(ownLock)) {
      lockPath = ownLock;
      lockBase = config.root;
    } else if (rootEvalsApp(rootGemfile, toPosix(config.root))) {
      lockPath = join(context.workspaceRoot, 'Gemfile.lock');
      lockBase = '.';
    } else {
      continue;
    }
    // The app's Gemfile (where `path:` is declared) is the source file: it is
    // always tracked, whereas a unified-setup app lock is gitignored — and Nx
    // rejects a dependency whose sourceFile is not a workspace file.
    const sourceFile = toPosix(join(config.root, 'Gemfile'));

    for (const remote of readLocalPathGems(lockPath)) {
      const targetRoot = toPosix(
        relative(context.workspaceRoot, resolve(context.workspaceRoot, lockBase, remote)),
      );
      const target = rootToProject.get(targetRoot);
      if (!target || target === name) {
        continue;
      }

      const dependency: RawProjectGraphDependency = {
        source: name,
        target,
        type: DependencyType.static,
        sourceFile,
      };
      validateDependency(dependency, context);
      dependencies.push(dependency);
    }
  }

  return dependencies;
};
