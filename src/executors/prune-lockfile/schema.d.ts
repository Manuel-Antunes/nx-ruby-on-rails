export interface PruneLockfileExecutorSchema {
  /** Root unified `Gemfile.lock`, relative to the workspace root. */
  rootLockfile?: string;
  /** App `Gemfile` to read direct deps from, relative to the project root. */
  gemfile?: string;
  /** Pruned lockfile destination, relative to the project root. */
  outputLockfile?: string;
}
