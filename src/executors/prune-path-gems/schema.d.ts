export interface PrunePathGemsExecutorSchema {
  /** Directory (relative to the project root) the path gems are vendored into. */
  vendorDir?: string;
  /** Directory basenames excluded when copying each path gem. */
  skip?: string[];
}
