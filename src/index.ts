// The package ships the `autofile` binary (spec/cli.md); this entry is the
// one thing worth embedding — running a check and reading its findings.
// Everything else (config parsing, reference resolution, rendering, the
// spinner) is internal, and the tests import those modules directly.
export { check } from "./check.js";
export type { CheckOptions, CheckResult, Finding, Rule, Severity } from "./check.js";
