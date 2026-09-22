# nx-ruby-on-rails

[![npm version](https://img.shields.io/npm/v/nx-ruby-on-rails.svg)](https://www.npmjs.com/package/nx-ruby-on-rails)
[![CI](https://github.com/Manuel-Antunes/nx-ruby-on-rails/actions/workflows/ci.yml/badge.svg)](https://github.com/Manuel-Antunes/nx-ruby-on-rails/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/nx-ruby-on-rails.svg)](./LICENSE)

An [Nx](https://nx.dev) plugin that makes Ruby and Rails projects first-class citizens of a
polyglot monorepo: targets inferred from the `Gemfile`, project-graph edges for in-repo path
gems, and the two Bundler equivalents of Nx's JavaScript packaging executors that a
folder-scoped Docker build needs.

No generators, no scaffolding, no opinions about how your app is laid out. It reads what
Bundler already wrote down.

```bash
npm install --save-dev nx-ruby-on-rails
```

```jsonc
// nx.json
{
  "plugins": ["nx-ruby-on-rails"]
}
```

That is the whole setup. Every `Gemfile` in the workspace now describes a project.

---

## Why this exists

Nx infers everything it knows about a JavaScript project from `package.json`: which targets
exist, which projects depend on which, what is affected by a change. Drop a Rails app into the
same repository and all of that stops at the language boundary. The app becomes a folder Nx
runs nothing in, depends on nothing, and cannot tell has changed.

You can paper over it with a `project.json` full of `nx:run-commands` — and then three things
go wrong, in this order:

1. **The bundle splits.** Each app installs its own `Gemfile.lock`, so a gem shared by two
   apps resolves to two different versions, and CI installs the same gems twice. Bundler's
   answer is a root `Gemfile` that `eval_gemfile`s each app's — one resolution, one
   `bundle install` — but then every `bundle` command in the repo needs `BUNDLE_GEMFILE`
   pointing back at the root, repeated in every target, in every app, forever.
2. **The graph has a hole.** An in-repo gem pulled in with `path: "../../libs/my-gem"` is a
   real dependency, and Nx cannot see it. `nx affected` misses the app when the gem changes.
   Caches stay warm that should have been busted.
3. **The Docker context swallows the repo.** The app's `Gemfile` reaches outside its own
   folder for that path gem, so `docker build` has to be pointed at the repository root.
   Every Node module, every other app, every `.git` object is now part of the build context,
   and every unrelated commit invalidates the layer cache.

This plugin closes all three. The first two are inference — you install it and they are
simply true. The third is the pair of executors below.

---

## What you get

### Targets inferred from the `Gemfile`

Every project with a `Gemfile` gets:

| Target    | Command          |
| --------- | ---------------- |
| `install` | `bundle install` |

A project that is an actual **Rails application** — detected by `bin/rails` or
`config/application.rb`, never by the presence of the `rails` gem — also gets:

| Target       | Command                              | Notes              |
| ------------ | ------------------------------------ | ------------------ |
| `serve`      | `bundle exec rails server`           | marked `continuous` |
| `precompile` | `bundle exec rails assets:precompile` |                    |
| `test`       | `bundle exec rails test`             |                    |

The distinction matters: a gem or engine in `libs/` has a `Gemfile` too, and giving it a
`rails server` target would be nonsense. Those projects declare their own targets
(`bundle exec rspec`, say) in `project.json`, and the plugin leaves them alone.

Every inferred target runs with `cwd` set to the project root, so `nx run web:install`
behaves exactly like `cd apps/web && bundle install`.

Inference never overwrites anything. Nx merges inferred targets *under* what a project
declares itself, so redefining `test` in `project.json` wins.

### Gemfiles that are not projects

The `**/Gemfile` glob matches far more than your apps. Inferring a project from any of these
produces nameless graph nodes and the error `projects ... have no name provided`, so they are
filtered out:

`node_modules/`, `vendor/` (including `vendor/bundle` and `vendor/cache`), `.bundle/`,
`.workspace-gems/` (this plugin's own output), `.ruby-lsp/`, `tmp/`, `.nx/`, `.git/`

The repository-root `Gemfile` is skipped as well. In a unified bundle it is an aggregation
point, not an app — there is nothing to serve or precompile there.

### One bundle, without repeating yourself

If a root `Gemfile` `eval_gemfile`s an app's `Gemfile`:

```ruby
# ./Gemfile
source 'https://rubygems.org'
ruby '3.4.4'

gem 'rails', '~> 7.1'

eval_gemfile 'apps/web/Gemfile'
```

…then the plugin sets `BUNDLE_GEMFILE` on that app's targets, relative to the app directory:

```jsonc
{ "options": { "cwd": "apps/web", "env": { "BUNDLE_GEMFILE": "../../Gemfile" } } }
```

Every `bundle` command for the app now resolves the single unified bundle instead of a per-app
one that may never have been installed. The value is relative on purpose: an absolute path
would make the Nx cache hash machine-dependent, and the same cache entry has to be usable on
CI and on a laptop.

This is not limited to inferred targets. The plugin reads the project's own
`package.json#nx.targets` and `project.json#targets`, finds every target whose `command` or
`commands` actually invokes `bundle`, and merges the same environment into them:

```jsonc
// apps/web/package.json — you write this
{
  "nx": {
    "targets": {
      "migrate": { "options": { "command": "bundle exec rails db:migrate" } },
      "codegen": { "options": { "command": "bundle exec rake graphql:schema:dump" } }
    }
  }
}
```

Both get `BUNDLE_GEMFILE` without mentioning it. A target that does not run `bundle` is left
untouched.

An app the root `Gemfile` does not `eval_gemfile` is treated as self-contained, and nothing is
injected.

### Path gems become project-graph edges

A `Gemfile.lock` records an in-repo gem as a `PATH` section with a relative `remote:`:

```
PATH
  remote: ../../libs/lighthouse-graphql
  specs:
    lighthouse-graphql (0.1.0)
```

The plugin resolves that path against the workspace, matches it to a project root, and
registers a static dependency — the same edge Nx would create for a workspace `package.json`
dependency:

```
web  →  lighthouse-graphql
```

So `nx affected` marks the app when the gem changes, `nx graph` draws it, and the app's cache
inputs can use `^default` instead of hard-coding the gem's path. Because the edge is derived
per project from each lockfile, a path gem that itself references another resolves
transitively.

Remotes that are URLs (`GIT` and `GEM` sources) are skipped, as is a bare `remote: .`, which
is a gem's self-reference. In a unified bundle the app's own lock is usually a generated,
gitignored artifact — when it is absent, the plugin reads the root lock instead, so the edge
survives. The dependency always cites the app's `Gemfile` as its source file, because that is
the tracked file where `path:` is actually written, and Nx rejects a dependency whose source
file is not in the workspace.

---

## The executors: a Docker context the size of your app

These two exist to answer one question — *how do I `docker build` a Rails app in a monorepo
without making the whole repository the build context?* They are the Bundler analogues of
`@nx/js:prune-lockfile` and `@nx/js:copy-workspace-modules`, and they are meant to be used
together, in that order.

### `prune-lockfile`

Derives an app-scoped `Gemfile.lock` from the unified root lock.

It reads the app's direct gems from its `Gemfile`, walks the transitive closure through the
root lock's spec graph, and drops everything outside it — specs, `DEPENDENCIES`, `CHECKSUMS`
— while re-anchoring the `PATH remote:` from repository-relative to app-relative. Shared
sections (`PLATFORMS`, `RUBY VERSION`, `BUNDLED WITH`) are copied through untouched.

The transform only ever **drops** lines and **rewrites** the one `remote:` line; every kept
line is copied byte for byte. Bundler's exact formatting survives, and a single-app repository
round-trips exactly. The resolved versions in the app's lock are, by construction, the
versions the root `bundle install` resolved — that is the whole point of the unified bundle,
and pruning must not quietly re-resolve anything.

If the app declares a gem the root lock has never seen, the executor warns and names it: that
means the root `bundle install` is stale, not that the prune failed.

| Option           | Default         | Description                                                         |
| ---------------- | --------------- | ------------------------------------------------------------------- |
| `rootLockfile`   | `Gemfile.lock`  | The unified lock, relative to the workspace root.                    |
| `gemfile`        | `Gemfile`       | Where to read the app's direct gems, relative to the project root.    |
| `outputLockfile` | `Gemfile.lock`  | Destination, relative to the project root. Keep in sync with `outputs`. |

### `prune-path-gems`

Vendors the app's in-repo path gems into the app folder.

It reads the app's `Gemfile.lock` (the pruned one), takes every `PATH` remote that is a
relative path, and copies each gem into `<projectRoot>/.workspace-gems/<gem-name>`. The
vendored copy keeps the gem's own basename, which is the trick that makes the rest work: the
Dockerfile swaps only the COPY *source*, while the COPY *destination* stays the path the
`Gemfile` already resolves to. No `Gemfile` rewrite, no `Gemfile.lock` rewrite, nothing to
keep in sync.

`node_modules`, `tmp`, `log`, `coverage`, `.git` and `.nx` are excluded from the copy by
default.

| Option      | Default                                                 | Description                                                |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `vendorDir` | `.workspace-gems`                                       | Destination inside the project. Keep in sync with `outputs`. |
| `skip`      | `["node_modules","tmp","log","coverage",".git",".nx"]`  | Directory basenames excluded when copying each gem.          |

Add the vendor directory to `.gitignore` and to `.dockerignore`'s exceptions — it is build
output, and it is the one thing the build context must keep.

### Wiring them up

```jsonc
// apps/web/package.json
{
  "nx": {
    "targets": {
      "prune-lockfile": {
        "executor": "nx-ruby-on-rails:prune-lockfile",
        "cache": true,
        "inputs": ["{workspaceRoot}/Gemfile.lock", "{projectRoot}/Gemfile"],
        "outputs": ["{projectRoot}/Gemfile.lock"],
        "options": {}
      },
      "prune": {
        "executor": "nx-ruby-on-rails:prune-path-gems",
        "cache": true,
        "dependsOn": ["prune-lockfile"],
        "inputs": ["{projectRoot}/Gemfile.lock", "^default"],
        "outputs": ["{projectRoot}/.workspace-gems"],
        "options": {}
      }
    }
  }
}
```

Two details in there are load-bearing:

- `dependsOn: ["prune-lockfile"]` — the vendoring reads the *pruned* lock, whose remotes have
  already been re-anchored to the app directory.
- `"^default"` in the inputs, rather than a hard-coded `libs/my-gem/**`. The path gem is a
  project dependency now (see above), so `^default` picks up its sources automatically, and
  transitively, and keeps working when a gem is added or moved.

Then build with the app folder as the context:

```dockerfile
WORKDIR /app

# The Gemfile pulls in lighthouse-graphql as a path gem at ../../libs/lighthouse-graphql,
# which resolves to /libs/lighthouse-graphql relative to this Gemfile at /app/Gemfile.
# `nx prune web` vendored it into .workspace-gems, inside the folder context; copying it
# to the destination the Gemfile already expects means no lockfile rewrite.
COPY Gemfile Gemfile.lock ./
COPY .workspace-gems/lighthouse-graphql /libs/lighthouse-graphql

RUN bundle install --jobs 4 --retry 3
```

```bash
nx run web:prune && docker build -f apps/web/Dockerfile apps/web
```

The build context is now the app folder. The layer cache survives every commit that did not
touch the app or its gems, which in a busy monorepo is most of them.

---

## The intended model, end to end

1. **One `Gemfile.lock` in the repository**, at the root, from a root `Gemfile` that
   `eval_gemfile`s each app's. App-level locks are generated artifacts; add them to
   `.gitignore`. One resolution, one `bundle install`, no version skew between apps.
2. **Register the plugin and delete the boilerplate.** The `install`/`serve`/`precompile`/
   `test` targets and every `BUNDLE_GEMFILE` you had copy-pasted come from the `Gemfile` now.
3. **Declare in-repo gems with `path:`** and let the lockfile describe the graph. Do not add
   `implicitDependencies` by hand — the edges are derived, so they cannot drift.
4. **Wire `prune-lockfile` → `prune` on any app you containerize**, and build from the app
   folder. Deploy pipelines depend on `^prune`; nothing calls the executors directly.
5. **Write your own targets for everything else** — `rspec`, `rubocop`, `rake`, whatever your
   app uses. If the command runs `bundle`, it inherits the unified-bundle environment for
   free. This plugin infers the targets that are the same in every Rails app and deliberately
   stops there.

## Compatibility and scope

- **Nx 20, 21 and 22.** Declared as a peer dependency on `nx` and `@nx/devkit`; the plugin
  itself has no runtime dependencies at all.
- **Node 20+**, CommonJS.
- **Bundler-format lockfiles.** The pruning is a text transform over the format Bundler
  writes, not a re-resolution: no Ruby, no Bundler, no gem installation runs on the Nx side.
- **Not** a generator collection. There is nothing here that writes a new app or a new gem for
  you, and no plan to add it.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports that come with a lockfile excerpt are
the most useful kind.

## License

[MIT](./LICENSE) © Manuel Antunes
