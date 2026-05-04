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
