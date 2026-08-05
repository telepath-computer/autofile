import { checkVault } from './check.ts';
import { loadConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { findRecords } from './records.ts';

/**
 * What validating a vault came to.
 *
 * The three are kept apart because they are not the same news: a folder with no
 * config is not a vault to find wanting, and a config that cannot be used means
 * nothing was checked rather than that nothing was wrong. Only the third
 * carries findings, so a caller cannot report on records that were never read.
 */
export type VaultValidation =
  | { status: 'missing' }
  | { status: 'unloadable'; finding: Finding }
  | {
      status: 'checked';
      /** Every finding, violations before warnings, each in a fixed order. */
      findings: Finding[];
      /** How many records were checked, and how many listed paths they came from. */
      records: number;
      paths: number;
    };

/**
 * Checks the vault at `root` against the vault rules: reads the config, finds
 * the records the config declares, and checks them against it.
 *
 * The whole of it lives here rather than in the caller, because reading a vault
 * is what this module is for and a second caller would otherwise repeat these
 * three steps — including which order they go in and which rules the check must
 * run, both of which have to be right for the answer to mean anything.
 */
export async function validateVault(root: string): Promise<VaultValidation> {
  const loaded = await loadConfig(root);
  if (loaded.status === 'missing') return { status: 'missing' };
  if (loaded.status === 'violation') return { status: 'unloadable', finding: loaded.finding };

  const { config, rules } = loaded;
  const records = await findRecords(root, config);
  return {
    status: 'checked',
    findings: await checkVault(root, config, rules, records),
    records: records.length,
    paths: Object.keys(config.paths ?? {}).length,
  };
}
