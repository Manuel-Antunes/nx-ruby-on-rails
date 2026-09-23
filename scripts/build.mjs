/**
 * Assembles the publishable package into `dist/`.
 *
 * The package is published *from* `dist/`, not from the repository root, so the
 * built layout mirrors the source layout one-to-one: `dist/index.js`,
 * `dist/executors/<name>/executor.js`, `dist/executors.json`. Nx resolves an
 * executor by reading `package.json#executors` and then following the relative
 * `implementation` path, so publishing the build output as the package root is
 * what lets those paths stay short and stable.
 *
 * It also keeps the root `executors.json` free to point at the TypeScript
 * sources (`./src/executors/...`). That matters for consuming the plugin from a
 * checkout — an Nx monorepo that vendors this repository (as a git submodule,
 * say) registers it as a local plugin, and Nx transpiles a local plugin's TS on
 * the fly. No build step, no stale `dist/`. The published copy gets the
 * compiled paths instead, rewritten here.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const write = (p, json) =>
  writeFileSync(join(dist, p), `${JSON.stringify(json, null, 2)}\n`);

rmSync(dist, { recursive: true, force: true });

// 1. Compile. `--force` because the previous build info went out with `dist/`.
//    tsc is resolved rather than shelled out to through a package runner, so the
//    build uses the compiler this repository pinned and nothing else.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '--build', '--force', 'tsconfig.lib.json'], {
  cwd: root,
  stdio: 'inherit',
});
rmSync(join(dist, 'tsconfig.lib.tsbuildinfo'), { force: true });

// 2. Executor schemas are data, not code: tsc walks past them.
const schemas = [];
for (const [name, executor] of Object.entries(read('executors.json').executors)) {
  const from = executor.schema.replace(/^\.\/src\//, '');
  schemas.push([name, from]);
  const target = join(dist, from);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, 'src', from), target);
}
if (schemas.length === 0) {
  throw new Error('executors.json declares no executors — nothing to publish');
}

// 3. Same executor manifest, pointing at the compiled files instead of `src/`.
const manifest = read('executors.json');
for (const executor of Object.values(manifest.executors)) {
  executor.implementation = executor.implementation.replace(/^\.\/src\//, './');
  executor.schema = executor.schema.replace(/^\.\/src\//, './');
}
write('executors.json', manifest);

// 4. A package.json for the published artifact: the same identity, none of the
//    development wiring, and paths relative to `dist/` being the package root.
const pkg = read('package.json');
write('package.json', {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: './index.js',
  types: './index.d.ts',
  executors: './executors.json',
  // Stated rather than inferred: whoever publishes this manifest — pnpm through
  // `publishConfig.directory`, or CI through `npm publish ./dist` — publishes it
  // publicly.
  publishConfig: { access: 'public' },
  peerDependencies: pkg.peerDependencies,
  engines: pkg.engines,
  repository: pkg.repository,
  bugs: pkg.bugs,
  homepage: pkg.homepage,
  keywords: pkg.keywords,
});

// 5. The files npm shows on the package page.
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(dist, file));
}

const rel = (p) => relative(root, p);
console.log(
  `built ${rel(dist)}/ — ${schemas.length} executor(s): ${schemas.map(([n]) => n).join(', ')}`,
);
