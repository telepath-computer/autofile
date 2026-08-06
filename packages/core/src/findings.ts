/**
 * What a check found, in the terms every layer reports in. Opening a vault,
 * reading records and checking them against the rules all produce findings, so
 * a reporter renders one shape rather than learning each producer's — and a
 * finding says how much it is worth rather than leaving that to the list it
 * arrived in or the function that rendered it.
 *
 * Which rules exist is not settled here. What a vault can find follows from how
 * it stores things — an unparseable header is something only a vault kept as
 * files could have — so each vault names its own.
 */

/**
 * What a finding is worth. Only a violation makes the vault invalid: a warning
 * is legal but usually a mistake, and a warning that failed a build would not
 * be a warning.
 */
export type Severity = 'violation' | 'warning';

/** One thing found wanting. */
export interface Finding {
  /** What was broken. Each vault names its own. */
  rule: string;
  severity: Severity;
  /** The identity at fault, where there is one. */
  id?: string;
  /** The collection at fault, where the finding is about one. */
  collection?: string;
  message: string;
}
