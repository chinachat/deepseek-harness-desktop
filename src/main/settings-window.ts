import { BrowserWindow, ipcMain } from "electron";
import { app } from "electron";
import path from "node:path";
import { applyGithubProxy, getSettings, saveSettings, type AppSettings } from "./settings";
import { guardFilePage } from "./ipc-guard";
import { UpdateManager, type UpdateState } from "./updater";

let settingsWindow: BrowserWindow | null = null;

/**
 * Register the settings-window IPC handlers. Call once at startup. The window
 * talks to the main process through `settings-preload.js`.
 */
export function registerSettingsIpc(): void {
  ipcMain.handle("settings:get", (event): AppSettings => {
    guardFilePage(event);
    return getSettings();
  });

  ipcMain.handle("settings:set", (event, patch: Partial<AppSettings>): AppSettings => {
    guardFilePage(event);
    const next = saveSettings(patch ?? {});
    if (typeof patch?.githubProxy === "string") {
      applyGithubProxy(next.githubProxy);
      UpdateManager.get().init(next.githubProxy);
    }
    return next;
  });

  ipcMain.handle("updater:state", (event) => {
    guardFilePage(event);
    return UpdateManager.get().getState();
  });

  ipcMain.handle("updater:version", (event) => {
    guardFilePage(event);
    return UpdateManager.get().currentVersion();
  });

  ipcMain.handle("updater:check", async (event) => {
    guardFilePage(event);
    const settings = getSettings();
    await UpdateManager.get().check(settings.githubProxy);
    return UpdateManager.get().getState();
  });

  ipcMain.handle("updater:install", (event) => {
    guardFilePage(event);
    UpdateManager.get().quitAndInstall();
    return true;
  });
}

/**
 * Open (or focus) the settings window.
 */
export function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    title: "DeepSeek Harness 设置",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Left off deliberately: the preload is compiled to CommonJS and has not
      // been verified under a sandboxed preload environment, and a silent
      // bridge failure here would break the settings window outright.
      sandbox: false,
    },
  });
  const manager = UpdateManager.get();
  const onState = (state: UpdateState) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("updater:state-event", state);
    }
  };
  manager.on("state", onState);
  settingsWindow.on("closed", () => {
    manager.off("state", onState);
    settingsWindow = null;
  });

  void settingsWindow.loadFile(path.join(app.getAppPath(), "assets", "settings.html"));
}
