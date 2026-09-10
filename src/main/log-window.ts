import { BrowserWindow, ipcMain } from "electron";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { guardFilePage } from "./ipc-guard";

let logWindow: BrowserWindow | null = null;

const LOG_LINES = 2000;
/** Bytes read from the tail of the log; the file itself is never unbounded. */
const LOG_TAIL_BYTES = 512 * 1024;

export function registerLogIpc(): void {
  ipcMain.handle("logs:read", (event) => {
    guardFilePage(event);
    const logPath = path.join(app.getPath("userData"), "logs", "dsh-desktop.log");
    try {
      if (!fs.existsSync(logPath)) return "";
      const size = fs.statSync(logPath).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const length = size - start;
      const buf = Buffer.alloc(length);
      const handle = fs.openSync(logPath, "r");
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(handle, buf, 0, length, start);
      } finally {
        fs.closeSync(handle);
      }
      const content = buf.subarray(0, bytesRead).toString("utf8");
      const lines = content.split("\n");
      // A tail read can begin mid-line; drop that partial first line.
      if (start > 0) lines.shift();
      return lines.slice(-LOG_LINES).join("\n");
    } catch (error) {
      return `(failed to read log: ${String(error)})`;
    }
  });
}

export function openLogWindow(): void {
  if (logWindow) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 900,
    height: 650,
    title: "DeepSeek Harness 日志",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "log-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Left off deliberately: the compiled CommonJS preload has not been
      // verified under a sandboxed preload environment, and a silent bridge
      // failure here would leave the log window permanently empty.
      sandbox: false,
    },
  });
  logWindow.on("closed", () => {
    logWindow = null;
  });
  void logWindow.loadFile(path.join(app.getAppPath(), "assets", "log-viewer.html"));
}
