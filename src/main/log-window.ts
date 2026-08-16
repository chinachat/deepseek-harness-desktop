import { BrowserWindow, ipcMain } from "electron";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

let logWindow: BrowserWindow | null = null;

const LOG_LINES = 2000;

export function registerLogIpc(): void {
  ipcMain.handle("logs:read", () => {
    const logPath = path.join(app.getPath("userData"), "logs", "dsh-desktop.log");
    try {
      if (!fs.existsSync(logPath)) return "";
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.split("\n");
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
      sandbox: false,
    },
  });
  logWindow.on("closed", () => {
    logWindow = null;
  });
  void logWindow.loadFile(path.join(app.getAppPath(), "assets", "log-viewer.html"));
}