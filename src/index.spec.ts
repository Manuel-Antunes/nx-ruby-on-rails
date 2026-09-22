import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDependencies, createNodes } from './index';

const [, inferTargets] = createNodes;

let workspaceRoot: string;

/** Writes a file inside the throwaway workspace, creating its parents. */
function file(path: string, contents = ''): void {
  const absolute = join(workspaceRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Runs the inference exactly as Nx does, and indexes the result by project root. */
async function infer(configFilePaths: string[]) {
  const results = await inferTargets(
    configFilePaths,
    {},
    // The plugin reads nothing else off the context.
    { workspaceRoot, nxJsonConfiguration: {} } as never,
  );
  return Object.fromEntries(
    results.flatMap(([, result]) => Object.entries(result.projects ?? {})),
  );
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-ruby-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('createNodes', () => {
  it('matches every Gemfile in the workspace', () => {
    expect(createNodes[0]).toBe('**/Gemfile');
  });

  it('gives a Rails app the full target set', async () => {
    file('apps/web/Gemfile', 'gem "rails"\n');
    file('apps/web/bin/rails', '#!/usr/bin/env ruby\n');

    const projects = await infer(['apps/web/Gemfile']);

    expect(Object.keys(projects['apps/web'].targets ?? {}).sort()).toEqual([
      'install',
      'precompile',
      'serve',
      'test',
    ]);
    expect(projects['apps/web'].targets?.serve).toMatchObject({
      command: 'bundle exec rails server',
      options: { cwd: 'apps/web' },
      continuous: true,
    });
  });

  it('detects a Rails app that has config/application.rb but no bin/rails', async () => {
    file('apps/web/Gemfile', 'gem "rails"\n');
    file('apps/web/config/application.rb', 'module Web; end\n');

    const projects = await infer(['apps/web/Gemfile']);

    expect(projects['apps/web'].targets?.test).toMatchObject({
      command: 'bundle exec rails test',
    });
  });

  it('gives a plain gem only an install target', async () => {
    file('libs/lighthouse-graphql/Gemfile', 'gemspec\n');

    const projects = await infer(['libs/lighthouse-graphql/Gemfile']);

    expect(Object.keys(projects['libs/lighthouse-graphql'].targets ?? {})).toEqual([
      'install',
    ]);
  });

  it('skips the root Gemfile and every non-project Gemfile', async () => {
    file('Gemfile', 'gem "rails"\n');
    file('vendor/bundle/ruby/3.4.0/gems/rake-13.2.1/Gemfile');
    file('node_modules/some-package/Gemfile');
    file('apps/web/.workspace-gems/lighthouse-graphql/Gemfile');
    file('apps/web/tmp/Gemfile');

    const projects = await infer([
      'Gemfile',
      'vendor/bundle/ruby/3.4.0/gems/rake-13.2.1/Gemfile',
      'node_modules/some-package/Gemfile',
      'apps/web/.workspace-gems/lighthouse-graphql/Gemfile',
      'apps/web/tmp/Gemfile',
    ]);

    expect(projects).toEqual({});
  });

  it('points every bundle command at a unified root Gemfile', async () => {
    file('Gemfile', 'source "https://rubygems.org"\neval_gemfile "apps/web/Gemfile"\n');
    file('apps/web/Gemfile', 'gem "rails"\n');
    file('apps/web/bin/rails', '');

    const projects = await infer(['apps/web/Gemfile']);

    for (const target of Object.values(projects['apps/web'].targets ?? {})) {
      expect(target.options?.env).toEqual({ BUNDLE_GEMFILE: '../../Gemfile' });
    }
  });

  it('merges BUNDLE_GEMFILE into the bundle targets the project declares itself', async () => {
    file('Gemfile', 'eval_gemfile "apps/web/Gemfile"\n');
    file('apps/web/Gemfile', 'gem "rails"\n');
    file(
      'apps/web/package.json',
      JSON.stringify({
        name: 'web',
        nx: {
          targets: {
            migrate: { options: { command: 'bundle exec rails db:migrate' } },
            codegen: { options: { commands: ['yarn gen', 'bundle exec rake gql'] } },
            lint: { options: { command: 'npx eslint .' } },
          },
        },
      }),
    );

    const targets = (await infer(['apps/web/Gemfile']))['apps/web'].targets ?? {};

    expect(targets.migrate?.options?.env).toEqual({ BUNDLE_GEMFILE: '../../Gemfile' });
    expect(targets.codegen?.options?.env).toEqual({ BUNDLE_GEMFILE: '../../Gemfile' });
    expect(targets.lint).toBeUndefined();
  });

  it('leaves a project the root Gemfile does not eval_gemfile alone', async () => {
    file('Gemfile', 'eval_gemfile "apps/other/Gemfile"\n');
    file('apps/web/Gemfile', 'gem "rails"\n');

    const projects = await infer(['apps/web/Gemfile']);

    expect(projects['apps/web'].targets?.install?.options?.env).toBeUndefined();
  });
});

describe('createDependencies', () => {
  /**
   * A CreateDependenciesContext with the fields the plugin reads, plus the file
   * map `validateDependency` checks the `sourceFile` against — every project's
   * `Gemfile`, which is what the plugin always cites as the dependency's source.
   */
  function context(projects: Record<string, string>) {
    const projectFileMap = Object.fromEntries(
      Object.entries(projects).map(([name, root]) => [
        name,
        [{ file: `${root}/Gemfile`, hash: '' }],
      ]),
    );
    const fileMap = { nonProjectFiles: [], projectFileMap };
    return {
      workspaceRoot,
      projects: Object.fromEntries(
        Object.entries(projects).map(([name, root]) => [name, { name, root }]),
      ),
      externalNodes: {},
      fileMap,
      filesToProcess: fileMap,
      nxJsonConfiguration: {},
      projectGraph: { nodes: {}, dependencies: {}, externalNodes: {} },
    } as never;
  }

  it('turns a path-gem remote into a project-graph edge', async () => {
    file(
      'apps/web/Gemfile',
      'gem "lighthouse-graphql", path: "../../libs/lighthouse-graphql"\n',
    );
    file(
      'apps/web/Gemfile.lock',
      'PATH\n  remote: ../../libs/lighthouse-graphql\n  specs:\n    lighthouse-graphql (0.1.0)\n',
    );
    file('libs/lighthouse-graphql/Gemfile', 'gemspec\n');

    const deps = await createDependencies(
      {},
      context({ web: 'apps/web', 'lighthouse-graphql': 'libs/lighthouse-graphql' }),
    );

    expect(deps).toEqual([
      {
        source: 'web',
        target: 'lighthouse-graphql',
        type: 'static',
        sourceFile: 'apps/web/Gemfile',
      },
    ]);
  });

  it('falls back to the root lock when the app lock is not checked in', async () => {
    file('Gemfile', 'eval_gemfile "apps/web/Gemfile"\n');
    file(
      'apps/web/Gemfile',
      'gem "lighthouse-graphql", path: "../../libs/lighthouse-graphql"\n',
    );
    file(
      'Gemfile.lock',
      'PATH\n  remote: libs/lighthouse-graphql\n  specs:\n    lighthouse-graphql (0.1.0)\n',
    );
    file('libs/lighthouse-graphql/Gemfile', 'gemspec\n');

    const deps = await createDependencies(
      {},
      context({ web: 'apps/web', 'lighthouse-graphql': 'libs/lighthouse-graphql' }),
    );

    expect(deps).toMatchObject([{ source: 'web', target: 'lighthouse-graphql' }]);
  });

  it('ignores remotes that are URLs, self-references, or unknown projects', async () => {
    file('apps/web/Gemfile', 'gem "rails"\n');
    file(
      'apps/web/Gemfile.lock',
      [
        'GIT',
        '  remote: https://github.com/rails/rails.git',
        '  specs:',
        '    rails (8.0.0)',
        '',
        'PATH',
        '  remote: .',
        '  specs:',
        '    web (0.1.0)',
        '',
        'PATH',
        '  remote: ../../libs/not-a-project',
        '  specs:',
        '    not-a-project (0.1.0)',
        '',
      ].join('\n'),
    );

    const deps = await createDependencies({}, context({ web: 'apps/web' }));

    expect(deps).toEqual([]);
  });
});
