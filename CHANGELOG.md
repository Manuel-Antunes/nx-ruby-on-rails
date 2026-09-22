# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-22

First public release. The plugin was extracted from a private polyglot Nx monorepo where it
had been running a Rails app's inference and container builds; nothing about its behaviour
changed in the move, but everything around it is new — the tests no longer reach into the
monorepo they came from, and the package now builds and publishes on its own.

### Added

- **Targets inferred from every `Gemfile`.** `install` for any Ruby project; `serve`,
  `precompile` and `test` for actual Rails applications, detected by `bin/rails` or
  `config/application.rb` rather than by the presence of the `rails` gem — so a gem or engine
  in `libs/` is not handed a `rails server` target it cannot run. Gemfiles under
  `node_modules`, `vendor`, `.bundle`, `.workspace-gems`, `.ruby-lsp`, `tmp`, `.nx` and `.git`
  are not projects and are filtered out, as is the repository-root `Gemfile`.

- **Unified-bundle support.** When a root `Gemfile` `eval_gemfile`s an app's, every inferred
  target gets `BUNDLE_GEMFILE` pointing at that root, relative to the app directory so the Nx
  cache hash stays machine-independent. The same environment is merged into the targets the
  project declares itself, for every target whose command actually invokes `bundle`.

- **Path gems in the project graph.** An in-repo gem referenced with `path:` — recorded by
  Bundler as a `PATH` section with a relative `remote:` — becomes a static dependency edge, so
  `nx affected` sees the app when the gem changes and cache inputs can use `^default` instead
  of a hard-coded path. Falls back to the root lock when the app's own lock is a gitignored
  artifact.

- **`prune-lockfile` executor.** Derives an app-scoped `Gemfile.lock` from the unified root
  lock: the app's transitive closure only, `DEPENDENCIES` and `CHECKSUMS` pruned to match, and
  the `PATH remote:` re-anchored to the app directory. The transform only drops lines and
  rewrites that one remote, so Bundler's formatting survives byte for byte and a single-app
  repository round-trips exactly. Warns, by name, about direct gems the root lock has never
  resolved.

- **`prune-path-gems` executor.** Vendors the app's in-repo path gems into
  `<projectRoot>/.workspace-gems`, keeping each gem's basename so a Dockerfile swaps only the
  COPY source and leaves the destination — the path the `Gemfile` already resolves to —
  alone. Together with `prune-lockfile` this is what lets a Rails app be built from its own
  folder as the Docker context instead of the repository root.

[Unreleased]: https://github.com/Manuel-Antunes/nx-ruby-on-rails/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Manuel-Antunes/nx-ruby-on-rails/releases/tag/v0.1.0
