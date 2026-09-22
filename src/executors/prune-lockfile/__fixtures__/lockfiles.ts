/**
 * A unified root `Gemfile.lock` in miniature: one in-repo PATH gem, a GEM
 * source whose specs split cleanly into two apps' closures, and every
 * non-source section Bundler emits (PLATFORMS / DEPENDENCIES / CHECKSUMS /
 * RUBY VERSION / BUNDLED WITH).
 *
 * `web` depends on rails + the path gem; `worker` depends on sidekiq. Pruning
 * for one app must drop the other's gems and keep everything shared.
 */
export const ROOT_LOCKFILE = `PATH
  remote: libs/lighthouse-graphql
  specs:
    lighthouse-graphql (0.1.0)
      graphql (~> 2.0)

GEM
  remote: https://rubygems.org/
  specs:
    activesupport (7.2.1)
      concurrent-ruby (~> 1.0, >= 1.0.2)
    base64 (0.2.0)
    concurrent-ruby (1.3.4)
    connection_pool (2.4.1)
    graphql (2.3.14)
      base64
    rails (7.2.1)
      activesupport (= 7.2.1)
    redis-client (0.22.2)
      connection_pool
    sidekiq (7.3.2)
      redis-client (>= 0.22.2)

PLATFORMS
  ruby
  x86_64-linux

DEPENDENCIES
  lighthouse-graphql!
  rails (~> 7.2)
  sidekiq

CHECKSUMS
  activesupport (7.2.1) sha256=1111
  base64 (0.2.0) sha256=2222
  concurrent-ruby (1.3.4) sha256=3333
  connection_pool (2.4.1) sha256=4444
  graphql (2.3.14) sha256=5555
  rails (7.2.1) sha256=6666
  redis-client (0.22.2) sha256=7777
  sidekiq (7.3.2) sha256=8888

RUBY VERSION
   ruby 3.4.4p34

BUNDLED WITH
   2.6.9
`;

/** The `Gemfile` of the app rooted at `apps/web`. */
export const WEB_GEMFILE = `source "https://rubygems.org"

ruby "3.4.4"

gem "rails", "~> 7.2"
gem "lighthouse-graphql", path: "../../libs/lighthouse-graphql"

group :development do
  gem "sidekiq"
end
`;
