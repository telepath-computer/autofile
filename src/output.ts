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

  const rows = result.findings.map((finding) => ({
    finding,
    file: escapeControls(finding.file),
    message: escapeControls(finding.message),
  }));
  // The escaped file column is padded by terminal cells, not UTF-16/code-point count.
  const width = rows.reduce((widest, row) => Math.max(widest, displayWidth(row.file)), 0);
  const lines = rows.map(({ finding, file, message }) => {
    const paint = finding.severity === "violation" ? c.red : c.yellow;
    const marker = paint(finding.severity === "violation" ? "✗" : "!");
    const prefix = paint(`${finding.rule}:`);
    const gap = " ".repeat(width - displayWidth(file) + 2);
    return `${marker} ${c.bold(file)}${gap}${prefix} ${message}`;
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

function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || /[\p{M}\p{Cf}]/u.test(character)
    ) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

// East Asian Wide/Fullwidth ranges, following the compact range approach
// used by wcwidth implementations. Ambiguous characters remain one cell.
function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x16fe0 && codePoint <= 0x16fe4)
    || (codePoint >= 0x17000 && codePoint <= 0x18d8f)
    || (codePoint >= 0x1aff0 && codePoint <= 0x1afff)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Renders the `autofile init` report over the path init created. */
export function renderInitReport(created: string, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  return `Initialized an Autofile vault.\n\n  ${c.green(created)}\n`;
}

/** Renders a command-stopping error as exactly one stderr line. */
export function renderError(message: string, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  return `${c.red("✗")} ${escapeControls(message)}\n`;
}

export interface ServeReport {
  version: string;
  root: string;
  notes: number;
  url: string;
}

/** Renders the three aligned lines printed once a vault is listening. */
export function renderServeReport(report: ServeReport, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  return [
    `${c.bold("autofile")} ${report.version}`,
    `${c.dim("vault:")}  ${report.root} ${c.dim(`(${count(report.notes, "note")})`)}`,
    `${c.dim("url:")}    ${c.cyan(report.url)}`,
    "",
  ].join("\n");
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
