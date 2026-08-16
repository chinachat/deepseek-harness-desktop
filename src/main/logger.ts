import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

let logDir = "";

export function initLogger(): string {
  logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  if (logDir) {
    try {
      fs.appendFileSync(path.join(logDir, "dsh-desktop.log"), line);
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
