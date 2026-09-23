# Contributing to nx-ruby-on-rails

Thanks for taking the time. This is a small plugin with a narrow job, so the bar for a change
is mostly "does it read the files Bundler and Nx already wrote, and does a test prove it?"

## Getting started

```bash
git clone https://github.com/YOUR_USERNAME/nx-ruby-on-rails.git
cd nx-ruby-on-rails
pnpm install
```

`pnpm` is the package manager; the lockfile is committed and CI installs with
`--frozen-lockfile`.

```bash
pnpm test           # vitest, once
pnpm test:watch
pnpm test:coverage
pnpm typecheck      # tsc --build over lib + spec
pnpm lint           # eslint
pnpm lint:fix
pnpm format         # prettier
pnpm build          # assemble the publishable package into dist/
```

Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` before you push — that is exactly
what CI runs.

## How the repository is laid out

```
src/
  index.ts                             createNodes + createDependencies (the inference)
  index.spec.ts
  executors/
    prune-lockfile/
      executor.ts                      the Nx entry point: resolve paths, read, write, report
      prune.ts                         the pure transform — no fs, no Nx
      prune.spec.ts
      __fixtures__/lockfiles.ts        a miniature unified root Gemfile.lock
      schema.json                      option schema Nx validates against
      schema.d.ts                      the same options, for TypeScript
    prune-path-gems/
executors.json                         the executor manifest
scripts/build.mjs                      assembles dist/
```

The split inside `prune-lockfile` is deliberate and worth preserving: `prune.ts` is a pure
string-to-string function, which is why it can be tested against realistic lockfiles without
a filesystem, a Ruby toolchain, or an Nx workspace. Put logic there and keep `executor.ts` to
resolving paths and reporting.

`schema.json` and `schema.d.ts` describe the same options twice — one for Nx's runtime
validation and its `--help`, one for the compiler. Change one and change the other.

### Two `executors.json`, on purpose

The `executors.json` at the repository root points at **TypeScript sources**
(`./src/executors/…`). `scripts/build.mjs` writes a second one into `dist/` with those paths
rewritten to the compiled files, and the package is published *from* `dist/`, which is why the
published paths are short (`./executors/…`).

This is what lets the plugin be consumed straight from a checkout — vendored into an Nx
monorepo as a git submodule, for instance. Nx transpiles a local plugin's TypeScript on the
fly, so a checkout needs no build step and can never go stale against a forgotten `dist/`.
Installed from npm, Nx gets plain CommonJS. If you add an executor, add it to the root
manifest with `./src/…` paths and the build handles the rest.

## Testing

Every test is hermetic: no Docker, no Ruby, no network.

- **Lockfile logic** is tested against `__fixtures__/lockfiles.ts`, a miniature unified root
  lock with a `PATH` gem and two apps' worth of `GEM` specs. If you are fixing a parsing bug,
  the fix starts by adding the shape that broke it to that fixture — real lockfile excerpts
  are welcome, trimmed to the sections that matter.
- **Inference** is tested by writing a throwaway workspace into `mkdtemp` and calling
  `createNodes` / `createDependencies` the way Nx calls them. The context objects there
  contain only the fields the plugin actually reads.

A change to the pruning transform should keep the round-trip test passing: pruning a lockfile
whose closure is the whole file must change nothing except the re-anchored `PATH remote:`.
That test is the guard against the transform quietly reformatting Bundler's output.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(inference): infer a rubocop target when .rubocop.yml is present
fix(prune-lockfile): keep platform-specific spec variants in the closure
docs(readme): explain the unified-bundle setup
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

## Pull requests

1. Rebase on `main`.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green.
3. Add a note to the `## [Unreleased]` section of [CHANGELOG.md](./CHANGELOG.md), written for
   someone deciding whether to upgrade.
4. Open the PR and say which Nx version you ran against.

## Releasing

Maintainers only.

1. Move the `## [Unreleased]` entries into a `## [x.y.z] - YYYY-MM-DD` section.
2. Bump `version` in `package.json`.
3. Commit, then tag: `git tag vx.y.z && git push --follow-tags`.

The `Release` workflow takes it from there: it builds, publishes to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no token is stored in
the repository), and creates the GitHub Release using that version's changelog section as the
body, so the notes on GitHub and the notes in the repository cannot drift apart.

Trusted publishing has to be configured once on npmjs.com, under the package's *Settings →
Trusted Publisher*: this repository, workflow `release.yml`.

### Publishing by hand

```bash
pnpm publish          # or: pnpm run release
```

There is no `pnpm build` to remember first. `publishConfig.directory` points the publish at
`dist/`, and `prepublishOnly` rebuilds it — so what goes to the registry is always compiled
from the working tree, never whatever `dist/` happened to be left over from the last `pnpm
build`. pnpm also refuses on a dirty tree or off `main`; `--no-git-checks` overrides that when
you mean it.

`publishConfig.directory` is a pnpm field. Plain `npm publish` ignores it and would ship the
repository root, whose `executors.json` points at `src/*.ts`, so `scripts/prepublish.mjs`
refuses that publish instead of letting a broken tarball out. The release workflow names the
directory explicitly (`npm publish ./dist`) after its own build step, which is why it does not
go through that script: npm's OIDC publishing is a plain `npm publish`, and routing it through
pnpm would put a layer between the workflow and the credential exchange.
