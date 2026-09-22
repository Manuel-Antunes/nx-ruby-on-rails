import { posix } from 'node:path';

/**
 * Pure Bundler-lockfile pruning logic — the Ruby analogue of pnpm's
 * `prune-lockfile` (`@nx/js:prune-lockfile`).
 *
 * A monorepo with a root `Gemfile` that `eval_gemfile`s each app's Gemfile
 * resolves into a single root `Gemfile.lock` (one source of truth, one
 * `bundle install`). For an app's *folder-scoped* Docker build, however, we need
 * a per-app `Gemfile.lock` that contains only the gems that app actually
 * depends on, with the path-gem `remote:` rewritten from root-relative to
 * app-relative.
 *
 * The transform is line-preserving: it only DROPS lines (specs/dependencies/
 * checksums outside the app's closure, and now-empty sources) and REWRITES the
 * `PATH remote:` line. Every kept line is copied verbatim, so Bundler's exact
 * formatting is preserved and a single-app prune round-trips byte-for-byte.
 */

/** Lockfile source sections whose `specs:` participate in the dependency graph. */
const SOURCE_HEADERS = new Set(['GIT', 'PATH', 'GEM', 'PLUGIN SOURCE']);

/** A blank-line-delimited lockfile section (header line + its body lines). */
interface Block {
  header: string;
  lines: string[];
}

/**
 * Gem name out of a spec / dependency / checksum entry line:
 *   "    nokogiri (1.18.9-aarch64-linux)" -> "nokogiri"
 *   "  rails (~> 7.1)!"                   -> "rails"
 *   "  actioncable (7.2.3) sha256=..."    -> "actioncable"
 */
function gemName(entryLine: string): string {
  return entryLine.trim().replace(/!$/, '').split(/[\s(]/)[0];
}

/**
 * Splits a lockfile into sections. Bundler separates top-level sections with a
 * single blank line and never emits a blank line *inside* a section, so a split
 * on runs of blank lines yields exactly one block per section (multiple
 * GIT/GEM/PATH sections each become their own block).
 */
function parseBlocks(lock: string): Block[] {
  return lock
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split(/\n{2,}/)
    .map((chunk) => {
      const lines = chunk.split('\n');
      return { header: lines[0], lines };
    });
}

/** Builds `gemName -> Set<dependencyName>` from every source section's specs. */
function buildGraph(blocks: Block[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const block of blocks) {
    if (!SOURCE_HEADERS.has(block.header)) continue;
    let inSpecs = false;
    let currentDeps: Set<string> | null = null;
    for (const line of block.lines) {
      if (/^ {2}specs:/.test(line)) {
        inSpecs = true;
        continue;
      }
      if (!inSpecs) continue;
      if (/^ {4}\S/.test(line)) {
        // 4-space indent: a spec entry. Platform variants (e.g. nokogiri and
        // nokogiri-aarch64-linux) share a name; union their dependency sets.
        const name = gemName(line);
        currentDeps = graph.get(name) ?? new Set<string>();
        graph.set(name, currentDeps);
      } else if (/^ {6}\S/.test(line) && currentDeps) {
        // 6-space indent: a runtime dependency of the current spec.
        currentDeps.add(gemName(line));
      }
    }
  }
  return graph;
}

/** Transitive closure of `roots` over the dependency graph. */
function closure(roots: string[], graph: Map<string, Set<string>>): Set<string> {
  const kept = new Set<string>();
  const stack = [...roots];
  for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
    if (kept.has(name)) continue;
    kept.add(name);
    for (const dep of graph.get(name) ?? []) {
      if (!kept.has(dep)) stack.push(dep);
    }
  }
  return kept;
}

/**
 * Filters one source section to the kept closure and rewrites a `PATH remote:`
 * from root-relative to `projectRoot`-relative. Returns `null` when the section
 * keeps no specs (so the caller drops it entirely).
 */
function filterSourceBlock(
  block: Block,
  kept: Set<string>,
  projectRoot: string,
): Block | null {
  const out: string[] = [];
  let inSpecs = false;
  let keepingCurrent = false;
  let anyKept = false;

  for (const line of block.lines) {
    if (block.header === 'PATH' && /^ {2}remote:\s+/.test(line) && !inSpecs) {
      const remote = line.replace(/^ {2}remote:\s+/, '').trim();
      // remote is relative to the workspace root; re-anchor it to the app dir.
      const appRelative = posix.relative(projectRoot, remote) || '.';
      out.push(`  remote: ${appRelative}`);
      continue;
    }
    if (/^ {2}specs:/.test(line)) {
      inSpecs = true;
      out.push(line);
      continue;
    }
    if (!inSpecs) {
      // Header metadata (remote/revision/ref/branch/tag/glob) — keep verbatim.
      out.push(line);
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      keepingCurrent = kept.has(gemName(line));
      if (keepingCurrent) {
        out.push(line);
        anyKept = true;
      }
    } else if (/^ {6}\S/.test(line)) {
      if (keepingCurrent) out.push(line);
    } else {
      out.push(line);
    }
  }

  return anyKept ? { header: block.header, lines: out } : null;
}

/** Keeps only the entries in a 2-space list section whose gem name passes `keep`. */
function filterListBlock(block: Block, keep: (name: string) => boolean): Block | null {
  const [header, ...body] = block.lines;
  const kept = body.filter((line) => keep(gemName(line)));
  return kept.length ? { header: block.header, lines: [header, ...kept] } : null;
}

export interface PruneResult {
  lockfile: string;
  /** Direct deps declared by the app but absent from the root lock (a warning). */
  missingDirect: string[];
  keptGemCount: number;
}

/**
 * Produces an app-scoped `Gemfile.lock` from the unified root lockfile.
 *
 * @param rootLock     contents of the root `Gemfile.lock`
 * @param directDeps   the app's direct gem names (from its `Gemfile`)
 * @param projectRoot  the app root, workspace-relative & posix (e.g. `apps/chatwoot`)
 */
export function pruneRubyLockfile(
  rootLock: string,
  directDeps: string[],
  projectRoot: string,
): PruneResult {
  const blocks = parseBlocks(rootLock);
  const graph = buildGraph(blocks);
  const directSet = new Set(directDeps);
  const kept = closure(directDeps, graph);

  const result: Block[] = [];
  for (const block of blocks) {
    if (SOURCE_HEADERS.has(block.header)) {
      const filtered = filterSourceBlock(block, kept, projectRoot);
      if (filtered) result.push(filtered);
    } else if (block.header === 'DEPENDENCIES') {
      const filtered = filterListBlock(block, (n) => directSet.has(n));
      if (filtered) result.push(filtered);
    } else if (block.header === 'CHECKSUMS') {
      const filtered = filterListBlock(block, (n) => kept.has(n));
      if (filtered) result.push(filtered);
    } else {
      // PLATFORMS, RUBY VERSION, BUNDLED WITH — shared, copied verbatim.
      result.push(block);
    }
  }

  const missingDirect = directDeps.filter((name) => !graph.has(name));
  return {
    lockfile: result.map((b) => b.lines.join('\n')).join('\n\n') + '\n',
    missingDirect,
    keptGemCount: kept.size,
  };
}

/** Direct gem names declared in an app `Gemfile` (`gem "name", ...` lines). */
export function readDirectDeps(gemfileContents: string): string[] {
  const names = new Set<string>();
  for (const match of gemfileContents.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
    names.add(match[1]);
  }
  return [...names];
}
