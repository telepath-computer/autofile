/**
 * What a check found, in the terms every layer reports in. Loading the config,
 * reading records and checking them against the rules all produce findings, so
 * a reporter renders one shape rather than learning each producer's — and a
 * finding says how much it is worth rather than leaving that to the list it
 * arrived in or the function that rendered it.
 */

/** The vault rule a finding is against. */
export type Rule = 'schema' | 'filename' | 'body' | 'parse' | 'config' | 'empty';

/**
 * What a finding is worth. Only a violation makes the vault invalid: a warning
 * is legal but usually a mistake, and a warning that failed a build would not
 * be a warning.
 */
export type Severity = 'violation' | 'warning';

/** One thing found wanting. */
export interface Finding {
  rule: Rule;
  severity: Severity;
  /**
   * The file it is against, as a path from the vault root. Absent where the
   * finding is against no single file: an `empty` finding is against a path
   * entry, and nothing is filed at it to name.
   */
  file?: string;
  /**
   * The key of the path entry that governs it, as the config writes it. Absent
   * where no entry governs it: a `config` finding concerns the vault's own file.
   */
  path?: string;
  /** What is wrong, in terms of the thing it is against. */
  message: string;
}
