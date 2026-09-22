import { type ExecutorContext, logger } from '@nx/devkit';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pruneRubyLockfile, readDirectDeps } from './prune';
import type { PruneLockfileExecutorSchema } from './schema';

/**
 * Generates an app-scoped `Gemfile.lock` from the monorepo's unified root
 * `Gemfile.lock`, pruned to the app's dependency closure with the path-gem
 * `remote:` re-anchored to the app directory. The Bundler analogue of
 * `@nx/js:prune-lockfile`; see `./prune.ts` for the transform.
 */
export default async function runExecutor(
  options: PruneLockfileExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const { projectName } = context;
  if (!projectName) {
    logger.error('prune-lockfile: executor must be run for a specific project');
    return { success: false };
  }

  const projectRoot =
    context.projectsConfigurations?.projects[projectName]?.root ??
    context.projectGraph?.nodes[projectName]?.data?.root;
  if (!projectRoot) {
    logger.error(
      `prune-lockfile: could not resolve the root of project "${projectName}"`,
    );
    return { success: false };
  }

  const rootLockPath = resolve(context.root, options.rootLockfile ?? 'Gemfile.lock');
  const gemfilePath = resolve(context.root, projectRoot, options.gemfile ?? 'Gemfile');
  const outputPath = resolve(
    context.root,
    projectRoot,
    options.outputLockfile ?? 'Gemfile.lock',
  );

  if (!existsSync(rootLockPath)) {
    logger.error(`prune-lockfile: root lockfile not found at ${rootLockPath}`);
    return { success: false };
  }
  if (!existsSync(gemfilePath)) {
    logger.error(`prune-lockfile: app Gemfile not found at ${gemfilePath}`);
    return { success: false };
  }

  const directDeps = readDirectDeps(readFileSync(gemfilePath, 'utf8'));
  if (directDeps.length === 0) {
    logger.error(`prune-lockfile: no \`gem\` declarations found in ${gemfilePath}`);
    return { success: false };
  }

  const { lockfile, missingDirect, keptGemCount } = pruneRubyLockfile(
    readFileSync(rootLockPath, 'utf8'),
    directDeps,
    projectRoot,
  );

  if (missingDirect.length > 0) {
    // A direct dep absent from the root lock means the root `bundle install` is
    // stale (the app declares a gem the unified lock hasn't resolved yet).
    logger.warn(
      `prune-lockfile: ${missingDirect.length} direct gem(s) missing from the root lock — run \`bundle install\` at the repo root: ${missingDirect.join(', ')}`,
    );
  }

  writeFileSync(outputPath, lockfile);
  logger.info(
    `prune-lockfile: wrote ${join(projectRoot, options.outputLockfile ?? 'Gemfile.lock')} (${keptGemCount} gems, ${directDeps.length} direct) from ${options.rootLockfile ?? 'Gemfile.lock'}`,
  );

  return { success: true };
}
