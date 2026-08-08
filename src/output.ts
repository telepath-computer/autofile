import pc from "picocolors";

import type { CheckResult } from "./check.js";

// Report rendering and the loading spinner (spec/cli.md "Output").
// Renderers are pure: the caller decides color, never the renderer, and
// stripping ANSI from the colored output yields the plain output byte for
// byte. The spinner writes only to a TTY, so its styling is always on.

/** Renders the `autofile check` report; ends with a newline. */
export function renderCheckReport(result: CheckResult, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  const files = count(result.filesChecked, "file");
  if (result.findings.length === 0) return `${c.green("✓")} ${c.dim(files)}\n`;

  // The file column is padded to the longest file in the report.
  // Combining marks occupy no column. Wide glyphs (CJK, emoji) can still
  // drift visually — accepted for determinism over a wcwidth dependency.
  const width = result.findings.reduce((widest, f) => Math.max(widest, fileWidth(f.file)), 0);
  const lines = result.findings.map((finding) => {
    const paint = finding.severity === "violation" ? c.red : c.yellow;
    const marker = paint(finding.severity === "violation" ? "✗" : "!");
    const prefix = paint(`${finding.rule}:`);
    const gap = " ".repeat(width - fileWidth(finding.file) + 2);
    const message = finding.message.replace(/\s+/gu, " ").trim();
    return `${marker} ${c.bold(finding.file)}${gap}${prefix} ${message}`;
  });

  const violations = result.findings.filter((f) => f.severity === "violation").length;
  const warnings = result.findings.length - violations;
  const parts = [
    violations > 0 ? count(violations, "violation") : undefined,
    warnings > 0 ? count(warnings, "warning") : undefined,
    files,
  ].filter((part): part is string => part !== undefined);
  const summary = c.dim(parts.join(" · "));
  return `${lines.join("\n")}\n\n${summary}\n`;
}

function fileWidth(file: string): number {
  return file.replace(/\p{M}/gu, "").length;
}

export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Renders the `autofile init` report over the path init created. */
export function renderInitReport(created: string, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  return `Initialized an Autofile vault.\n\n  ${c.green(created)}\n`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K";
const styled = pc.createColors(true);
/** The wait before the loading state appears at all (spec/cli.md "Output"). */
const DELAY_MS = 200;
/** How often the frame advances once it has. */
const INTERVAL_MS = 80;

/** The slice of the report stream the spinner needs; `process.stdout` fits. */
export interface SpinnerStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

/**
 * The loading state: nothing for 200 ms, then a braille spinner — cyan
 * glyph, dim message — redrawn in place every 80 ms. `update` changes the
 * message shown on the next frame; `stop` erases the line, leaving no
 * residue. `start` restarts: it stops any spinner already running, then
 * begins a fresh delay and frame sequence — so timers are never orphaned.
 * On a non-TTY stream it never writes at all.
 */
export class Spinner {
  private readonly stream: SpinnerStream;
  private message = "";
  private frame = 0;
  private delay: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(stream: SpinnerStream) {
    this.stream = stream;
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
      }, INTERVAL_MS);
    }, DELAY_MS);
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
