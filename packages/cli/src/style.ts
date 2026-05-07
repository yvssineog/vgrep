import { styleText } from "node:util";

type Format = Parameters<typeof styleText>[0];

// Bun's util.styleText always emits ANSI codes; mirror chalk by suppressing
// when stdout isn't a TTY or NO_COLOR is set, unless FORCE_COLOR overrides.
const enabled =
  process.env.FORCE_COLOR === "1" ||
  (!process.env.NO_COLOR && process.stdout.isTTY === true);

const make =
  (formats: Format) =>
  (value: string | number): string => {
    const text = String(value);
    return enabled ? styleText(formats, text) : text;
  };

export const c = {
  bold: make("bold"),
  dim: make("dim"),
  underline: make("underline"),
  cyan: make("cyan"),
  green: make("green"),
  red: make("red"),
  yellow: make("yellow"),
  magenta: make("magenta"),
  blue: make("blue"),
  boldCyan: make(["bold", "cyan"]),
  boldGreen: make(["bold", "green"]),
  boldBlue: make(["bold", "blue"]),
  boldMagenta: make(["bold", "magenta"]),
};

const LABEL_WIDTH = 8;

export function row(label: string, value: string | number): string {
  return `${c.dim(label.padEnd(LABEL_WIDTH))} ${value}`;
}

export function header(command: string, subject: string): string {
  return `${c.bold(`vgrep ${command}`)} ${c.dim(subject)}`;
}

export function status(text: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[2K${c.dim(text)}`);
  } else {
    console.log(text);
  }
}

export function clearStatus(): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/**
 * Live spinner + elapsed-time ticker that coexists with `console.log`.
 *
 * On a TTY, paints `<spinner> Xs <stage>` on the bottom line and
 * refreshes it every 80ms — the spinner makes activity visible even
 * when nothing else changes. `log()` clears the line, prints the row
 * above, then repaints, so permanent output and the live timer don't
 * collide.
 *
 * Off-TTY (piped, CI), the timer is suppressed and `setStage`/`log`
 * fall back to plain `status()`/`console.log`.
 */
export class Chronometer {
  private startTime = 0;
  private label = "";
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tty = process.stdout.isTTY === true;

  start(): void {
    this.startTime = performance.now();
    if (!this.tty) return;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  setStage(label: string): void {
    if (this.timer) {
      this.label = label;
      this.render();
    } else {
      status(label);
    }
  }

  log(line: string): void {
    if (this.timer && this.tty) process.stdout.write(`\r\x1b[2K`);
    else clearStatus();
    console.log(line);
    if (this.timer && this.tty) this.render();
  }

  stop(): number {
    const elapsed = this.startTime === 0 ? 0 : performance.now() - this.startTime;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) process.stdout.write(`\r\x1b[2K`);
    return elapsed;
  }

  private render(): void {
    const elapsed = (performance.now() - this.startTime) / 1000;
    const spinner = c.cyan(SPINNER_FRAMES[this.frame] ?? "");
    const time = c.dim(`${elapsed.toFixed(1)}s`);
    const tail = this.label ? ` ${c.dim(this.label)}` : "";
    process.stdout.write(`\r\x1b[2K${spinner} ${time}${tail}`);
  }
}

/** Format a duration in ms (`123ms` / `1.23s`). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format a byte count with binary units (`512 B`, `1.5 KB`, `2.0 MB`, `1.0 GB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
