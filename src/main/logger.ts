import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

let logDir = "";

/** Rotate once the log grows past this, so it cannot grow without bound. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Lines kept from the tail of the log when it is rotated. */
const RETAINED_TAIL_LINES = 2000;
/** How often to consider rotating, so the size probe is not per line. */
const ROTATE_INTERVAL_MS = 60_000;

let lastRotateCheck = 0;

export function initLogger(): string {
  logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  lastRotateCheck = Date.now();
  return logDir;
}

function rotate(logPath: string): void {
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  try {
    // Keep the recent tail: it is what a bug report actually needs.
    const content = fs.readFileSync(logPath, "utf8");
    const tail = content.split("\n").slice(-RETAINED_TAIL_LINES).join("\n");
    fs.writeFileSync(logPath, tail, "utf8");
  } catch {
    /* rotation is best-effort; never block logging on it */
  }
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  if (logDir) {
    try {
      const logPath = path.join(logDir, "dsh-desktop.log");
      const now = Date.now();
      if (now - lastRotateCheck >= ROTATE_INTERVAL_MS) {
        lastRotateCheck = now;
        rotate(logPath);
      }
      fs.appendFileSync(logPath, line);
    } catch {
      /* ignore */
    }
  }
  if (process.env.DSH_DESKTOP_DEBUG === "1") {
    process.stdout.write(line);
  }
}

export const logger = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string) => write("ERROR", message),
};
