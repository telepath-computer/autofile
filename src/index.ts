export { check } from "./check.js";
export type { CheckResult, Finding, Rule, Severity } from "./check.js";
export { isIgnored, loadConfig, parseConfig, resolve } from "./config.js";
export { renderCheckReport, renderInitReport, Spinner } from "./output.js";
export { starterConfig } from "./starter.js";
export type { SpinnerStream } from "./output.js";
export type {
  AssetsBlock,
  CompiledPattern,
  CompiledSchema,
  Config,
  ConfigError,
  ConfigResult,
  FilenamesBlock,
  IgnoreBlock,
  PathEntry,
  RecordsBlock,
  RuleBlocks,
} from "./config.js";
