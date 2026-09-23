/**
 * Runs before every publish, so `dist/` is never a stale leftover of whatever
 * was built last.
 *
 * The package *is* `dist/` — `scripts/build.mjs` assembles it, and
 * `publishConfig.directory` in package.json points the publish at it. That
 * field is a pnpm feature: plain `npm publish` ignores it and would ship the
 * repository root, whose `executors.json` points at TypeScript sources that no
 * consumer can run. So this refuses anything but pnpm rather than letting a
 * broken tarball reach the registry.
 */
const agent = process.env.npm_config_user_agent ?? '';

if (!agent.startsWith('pnpm')) {
  console.error(
    [
      'Publish with `pnpm publish` (or `pnpm run release`), not `npm publish`.',
      '',
      'The published package is the assembled dist/, which this repository points at',
      'through `publishConfig.directory` — a field only pnpm honours. Publishing from',
      'the repository root would ship an executors.json that references src/*.ts.',
      '',
      'CI publishes the directory explicitly (`npm publish ./dist`) after its own build',
      'step, which is why the release workflow does not go through this script.',
    ].join('\n'),
  );
  process.exit(1);
}

await import('./build.mjs');
