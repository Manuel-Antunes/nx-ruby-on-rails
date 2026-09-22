import { type ExecutorContext, logger } from '@nx/devkit';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { PrunePathGemsExecutorSchema } from './schema';

/**
 * Vendors a Ruby project's local PATH gems into `<projectRoot>/<vendorDir>` so
 * the project's Docker build can use a *folder* context instead of the repo
 * root. This is the Bundler analogue of `@nx/js:copy-workspace-modules`: it
 * copies the in-repo path gems that live outside the project (e.g.
 * `libs/lighthouse-graphql`, referenced as `path: "../../libs/..."`) into the
 * build context.
 *
 * The vendored copy keeps the gem's basename, so a Dockerfile only has to swap
 * the COPY *source* (`<vendorDir>/<gem>` instead of `libs/<gem>`) while the COPY
 * *destination* stays the same absolute path the Gemfile resolves to — no
 * Gemfile / Gemfile.lock rewriting required.
 */

const DEFAULT_VENDOR_DIR = '.workspace-gems';
// Directories never needed inside the build context (rebuilt or irrelevant).
const DEFAULT_SKIP = ['node_modules', 'tmp', 'log', 'coverage', '.git', '.nx'];

export default async function runExecutor(
  options: PrunePathGemsExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const { projectName } = context;
  if (!projectName) {
    logger.error('prune-path-gems: executor must be run for a specific project');
    return { success: false };
  }

  const projectRoot =
    context.projectsConfigurations?.projects[projectName]?.root ??
    context.projectGraph?.nodes[projectName]?.data?.root;
  if (!projectRoot) {
    logger.error(
      `prune-path-gems: could not resolve the root of project "${projectName}"`,
    );
    return { success: false };
  }

  const vendorDir = options.vendorDir ?? DEFAULT_VENDOR_DIR;
  const skip = new Set(options.skip ?? DEFAULT_SKIP);

  const absoluteProjectRoot = resolve(context.root, projectRoot);
  const lockPath = join(absoluteProjectRoot, 'Gemfile.lock');

  if (!existsSync(lockPath)) {
    logger.info(`prune-path-gems: no Gemfile.lock at ${projectRoot}, nothing to do`);
    return { success: true };
  }

  // PATH sections list local gems via `  remote: <relative path>`. Git/rubygems
  // remotes are URLs, so filtering on a leading "." keeps only in-repo path gems.
  const lock = readFileSync(lockPath, 'utf8');
  const remotes = [...lock.matchAll(/^\s+remote:\s+(\.[^\s]+)\s*$/gm)].map((m) => m[1]);

  if (remotes.length === 0) {
    logger.info(`prune-path-gems: ${projectRoot} has no local path gems, nothing to do`);
    return { success: true };
  }

  const vendorRoot = join(absoluteProjectRoot, vendorDir);
  rmSync(vendorRoot, { recursive: true, force: true });
  mkdirSync(vendorRoot, { recursive: true });

  for (const remote of remotes) {
    const src = resolve(absoluteProjectRoot, remote);
    const dest = join(vendorRoot, basename(remote));
    if (!existsSync(src)) {
      logger.error(`prune-path-gems: path gem source not found: ${remote} -> ${src}`);
      return { success: false };
    }
    cpSync(src, dest, {
      recursive: true,
      dereference: true,
      filter: (from) => !skip.has(basename(from)),
    });
    logger.info(
      `prune-path-gems: vendored ${remote} -> ${join(projectRoot, vendorDir, basename(remote))}`,
    );
  }

  return { success: true };
}
