import { describe, expect, it } from 'vitest';
import { pruneRubyLockfile, readDirectDeps } from './prune';
import { ROOT_LOCKFILE, WEB_GEMFILE } from './__fixtures__/lockfiles';

/** The inverse of the prune's PATH re-anchoring, used to assert the round-trip. */
function reanchorToRoot(appLock: string): string {
  return appLock.replace(
    /^( {2}remote:)\s+\.\.\/\.\.\/libs\/lighthouse-graphql\s*$/m,
    '$1 libs/lighthouse-graphql',
  );
}

describe('readDirectDeps', () => {
  it('reads every `gem` declaration, including the ones inside a group', () => {
    expect(readDirectDeps(WEB_GEMFILE).sort()).toEqual([
      'lighthouse-graphql',
      'rails',
      'sidekiq',
    ]);
  });

  it('deduplicates a gem declared more than once', () => {
    expect(readDirectDeps('gem "rails"\ngem "rails", require: false\n')).toEqual([
      'rails',
    ]);
  });

  it('ignores a commented-out declaration', () => {
    expect(readDirectDeps('gem "rails"\n# gem "puma"\n')).toEqual(['rails']);
  });
});

describe('pruneRubyLockfile', () => {
  const directDeps = readDirectDeps(WEB_GEMFILE);

  it('round-trips: with the whole lock in the closure only the PATH remote moves', () => {
    const { lockfile } = pruneRubyLockfile(ROOT_LOCKFILE, directDeps, 'apps/web');
    expect(reanchorToRoot(lockfile)).toBe(ROOT_LOCKFILE);
  });

  it('re-anchors the path-gem remote to the app directory', () => {
    const { lockfile } = pruneRubyLockfile(ROOT_LOCKFILE, directDeps, 'apps/web');
    expect(lockfile).toContain('remote: ../../libs/lighthouse-graphql');
    expect(lockfile).not.toMatch(/^ {2}remote: libs\/lighthouse-graphql$/m);
  });

  it('keeps the transitive closure and drops everything outside it', () => {
    const { lockfile, keptGemCount } = pruneRubyLockfile(
      ROOT_LOCKFILE,
      ['rails', 'lighthouse-graphql'],
      'apps/web',
    );

    // rails -> activesupport -> concurrent-ruby, lighthouse-graphql -> graphql -> base64
    expect(keptGemCount).toBe(6);
    expect(lockfile).toContain('    activesupport (7.2.1)');
    expect(lockfile).toContain('    concurrent-ruby (1.3.4)');
    expect(lockfile).toContain('    base64 (0.2.0)');

    // sidekiq's closure belongs to another app.
    expect(lockfile).not.toContain('sidekiq');
    expect(lockfile).not.toContain('redis-client');
    expect(lockfile).not.toContain('connection_pool');
  });

  it('prunes DEPENDENCIES to the app’s own direct gems', () => {
    const { lockfile } = pruneRubyLockfile(
      ROOT_LOCKFILE,
      ['rails', 'lighthouse-graphql'],
      'apps/web',
    );
    expect(lockfile).toMatch(
      /DEPENDENCIES\n {2}lighthouse-graphql!\n {2}rails \(~> 7\.2\)\n/,
    );
  });

  it('prunes CHECKSUMS to the kept closure', () => {
    const { lockfile } = pruneRubyLockfile(ROOT_LOCKFILE, ['rails'], 'apps/web');
    expect(lockfile).toContain('  activesupport (7.2.1) sha256=1111');
    expect(lockfile).not.toContain('sha256=8888');
  });

  it('drops a source section that keeps no specs', () => {
    const { lockfile } = pruneRubyLockfile(ROOT_LOCKFILE, ['rails'], 'apps/web');
    // The app no longer uses the path gem, so the whole PATH section goes.
    expect(lockfile).not.toContain('PATH');
    expect(lockfile).not.toContain('lighthouse-graphql');
  });

  it('copies the shared sections through verbatim', () => {
    const { lockfile } = pruneRubyLockfile(ROOT_LOCKFILE, ['rails'], 'apps/web');
    expect(lockfile).toContain('PLATFORMS\n  ruby\n  x86_64-linux');
    expect(lockfile).toContain('RUBY VERSION\n   ruby 3.4.4p34');
    expect(lockfile).toContain('BUNDLED WITH\n   2.6.9');
    expect(lockfile.endsWith('\n')).toBe(true);
  });

  it('reports direct gems the root lock has never resolved', () => {
    const { missingDirect } = pruneRubyLockfile(
      ROOT_LOCKFILE,
      ['rails', 'a-gem-nobody-installed'],
      'apps/web',
    );
    expect(missingDirect).toEqual(['a-gem-nobody-installed']);
  });

  it('unions the dependencies of platform-specific spec variants', () => {
    const lock = [
      'GEM',
      '  remote: https://rubygems.org/',
      '  specs:',
      '    nokogiri (1.18.9)',
      '      racc (~> 1.4)',
      '    nokogiri (1.18.9-aarch64-linux-gnu)',
      '      mini_portile2 (~> 2.8)',
      '    mini_portile2 (2.8.8)',
      '    racc (1.8.1)',
      '',
      'DEPENDENCIES',
      '  nokogiri',
      '',
      'BUNDLED WITH',
      '   2.6.9',
      '',
    ].join('\n');

    const { keptGemCount, lockfile } = pruneRubyLockfile(lock, ['nokogiri'], 'apps/web');
    expect(keptGemCount).toBe(3);
    expect(lockfile).toContain('racc (1.8.1)');
    expect(lockfile).toContain('mini_portile2 (2.8.8)');
  });
});
