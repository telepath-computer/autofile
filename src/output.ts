import pc from "picocolors";

import type { CheckResult, Finding } from "./check.js";

// Report rendering and the loading spinner (spec/cli.md "Output").
// Renderers are pure: the caller decides color, never the renderer, and
// stripping ANSI from the colored output yields the plain output byte for
// byte. The spinner writes only to a TTY, so its styling is always on.

/** Renders the `autofile check` report; ends with a newline. */
export function renderCheckReport(result: CheckResult, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  const files = count(result.filesChecked, "file");
  if (result.findings.length === 0) return `${c.green("✓")} ${c.dim(files)}\n`;

  // The file column is padded to the longest file in the report; findings
  // without a file (config) render as marker, then rule prefix and message.
  // Padding counts UTF-16 code units (String#length), so wide glyphs (CJK,
  // emoji) can drift visually — accepted for determinism over a wcwidth
  // dependency.
  const width = Math.max(...result.findings.map((f) => f.file?.length ?? 0));
  const lines = result.findings.map((finding) => {
    const paint = finding.severity === "violation" ? c.red : c.yellow;
    const marker = paint(finding.severity === "violation" ? "✗" : "!");
    const prefix = paint(`${finding.rule}:`);
    if (finding.file === undefined) return `${marker} ${prefix} ${finding.message}`;
    const gap = " ".repeat(width - finding.file.length + 2);
    return `${marker} ${c.bold(finding.file)}${gap}${prefix} ${finding.message}`;
  });

  const violations = result.findings.filter(isViolation).length;
  const warnings = result.findings.length - violations;
  const summary = c.dim(
    `${count(violations, "violation")} · ${count(warnings, "warning")} · ${files}`,
  );
  return `${lines.join("\n")}\n\n${summary}\n`;
}

function isViolation(finding: Finding): boolean {
  return finding.severity === "violation";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Renders the `autofile init` report; folders get a trailing slash. */
export function renderInitReport(
  created: { config: string; folders: string[] },
  opts: { color: boolean },
): string {
  const c = pc.createColors(opts.color);
  const entries = [created.config, ...created.folders.map((folder) => `${folder}/`)];
  const lines = entries.map((entry) => `  ${c.green(entry)}`);
  return `Initialized an Autofile vault.\n\n${lines.join("\n")}\n`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K";
const styled = pc.createColors(true);

/** The slice of a write stream the spinner needs; `process.stderr` fits. */
export interface SpinnerStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

/**
 * The loading state: nothing for `delayMs`, then a braille spinner — cyan
 * glyph, dim message — redrawn in place every `intervalMs`. `update`
 * changes the message shown on the next frame; `stop` erases the line,
 * leaving no residue. `start` restarts: it stops any spinner already
 * running, then begins a fresh delay and frame sequence — so timers are
 * never orphaned. On a non-TTY stream it never writes at all.
 */
export class Spinner {
  private readonly stream: SpinnerStream;
  private readonly delayMs: number;
  private readonly intervalMs: number;
  private message = "";
  private frame = 0;
  private delay: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(stream: SpinnerStream, opts: { delayMs?: number; intervalMs?: number } = {}) {
    this.stream = stream;
    this.delayMs = opts.delayMs ?? 200;
    this.intervalMs = opts.intervalMs ?? 80;
  }

  start(label: string): void {
    this.stop();
    if (this.stream.isTTY !== true) return;
    this.message = label;
    this.frame = 0;
    this.delay = setTimeout(() => {
      this.draw();
      this.interval = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        this.draw();
      }, this.intervalMs);
    }, this.delayMs);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.delay !== undefined) clearTimeout(this.delay);
    this.delay = undefined;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
      this.stream.write(CLEAR_LINE);
    }
  }

  private draw(): void {
    this.stream.write(`${CLEAR_LINE}${styled.cyan(FRAMES[this.frame])} ${styled.dim(this.message)}`);
  }
}
