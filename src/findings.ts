export type Rule =
  | "config"
  | "coverage"
  | "parse"
  | "schema"
  | "body"
  | "filename_pattern"
  | "extensions"
  | "additional_subfolders"
  | "description"
  | "link_format"
  | "resolve"
  | "collision"
  | "missing";

export type Severity = "violation" | "warning";

export interface Finding {
  rule: Rule;
  severity: Severity;
  /** Vault-relative file or declared folder path, or autofile.yml. */
  file: string;
  message: string;
}

const severityRank: Record<Severity, number> = { violation: 0, warning: 1 };

/** Orders findings exactly as an `autofile check` report does. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || compare(left.file, right.file)
    || compare(left.rule, right.rule)
    || compare(left.message, right.message));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
