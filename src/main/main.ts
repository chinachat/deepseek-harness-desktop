import { app, BrowserWindow, dialog, ipcMain, Menu, WebContentsView } from "electron";
import http from "node:http";
import path from "node:path";
import { initLogger, logger } from "./logger";
import { DshServerManager, type ServerStatus } from "./dsh-server";
import { createTray, TrayState } from "./tray";
import { openLogWindow, registerLogIpc } from "./log-window";
import { openSettingsWindow, registerSettingsIpc } from "./settings-window";
import { registerFileExplorerIpc } from "./file-explorer";
import { installWebBridge } from "./web-bridge";
import { UpdateManager } from "./updater";
import { applyLaunchAtLogin, getSettings, saveSettings, type AppSettings } from "./settings";

const EXPLORER_WIDTH = 360;
const COLLAPSED_WIDTH = 28;
const MIN_EXPLORER_WIDTH = 220;
const MAX_EXPLORER_WIDTH = 700;

let mainWindow: BrowserWindow | null = null;
let dshView: WebContentsView | null = null;
let explorerView: WebContentsView | null = null;
let serverManager: DshServerManager | undefined;
let tray: TrayState | undefined;
let isQuitting = false;
const startHidden = process.argv.includes("--hidden");
let lastThemeDark: boolean | undefined;
let themeSyncTimer: NodeJS.Timeout | null = null;
let explorerWidth = EXPLORER_WIDTH;
let explorerCollapsed = false;

const HEALTH_TIMEOUT_MS = 30_000;

function showError(message: string): void {
  logger.error(message);
  dialog.showErrorBox("DeepSeek Harness 启动失败", message);
  app.quit();
}

function isReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReady(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`web UI did not become ready at ${url}`);
}

function layout(): void {
  if (!mainWindow || !dshView || !explorerView) return;
  const [width, height] = mainWindow.getContentSize();
  let explorerW = explorerCollapsed ? COLLAPSED_WIDTH : explorerWidth;
  explorerW = Math.min(explorerW, Math.max(0, width - 200));
  const mainW = Math.max(0, width - explorerW);
  dshView.setBounds({ x: 0, y: 0, width: mainW, height });
  explorerView.setBounds({ x: mainW, y: 0, width: explorerW, height });
  pushExplorerState();
}

function pushExplorerState(): void {
  if (!explorerView) return;
  explorerView.webContents.send("dsh-explorer:state", {
    collapsed: explorerCollapsed,
    width: explorerCollapsed ? COLLAPSED_WIDTH : explorerWidth,
  });
}

async function syncTheme(): Promise<void> {
  if (!dshView || !explorerView) return;
  try {
    const dark = await dshView.webContents.executeJavaScript(
      "document.body.hasAttribute('data-ds-dark-theme')"
    );
    if (dark !== lastThemeDark) {
      lastThemeDark = dark as boolean;
      await explorerView.webContents.executeJavaScript(
        `document.body.toggleAttribute('data-ds-dark-theme', ${dark as boolean});`
      );
    }
  } catch {
    /* views not ready yet */
  }
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "DeepSeek Harness",
    backgroundColor: "#0f1115",
    icon: path.join(__dirname, "..", "..", "assets", "icon.png"),
    show: false,
  });

  dshView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  explorerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "file-explorer-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.contentView.addChildView(dshView);
  mainWindow.contentView.addChildView(explorerView);
  layout();

  mainWindow.on("resize", layout);

  if (startHidden) {
    dshView.webContents.once("did-finish-load", () => {
      mainWindow?.hide();
    });
  } else {
    dshView.webContents.once("did-finish-load", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
  }

  mainWindow.on("close", (event) => {
    if (getSettings().closeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    if (themeSyncTimer) {
      clearInterval(themeSyncTimer);
      themeSyncTimer = null;
    }
    lastThemeDark = undefined;
    mainWindow = null;
    dshView = null;
    explorerView = null;
  });

  dshView.webContents.on("did-fail-load", (_event, code, description) => {
    logger.error(`window failed to load: ${code} ${description}`);
  });

  dshView.webContents.once("did-finish-load", () => {
    logger.info(`dsh view loaded: ${dshView?.webContents.getURL()}`);
    void syncTheme();
  });

  installWebBridge(dshView.webContents, explorerView.webContents, {
    onWorkspaceRoot: (root) => {
      logger.info(`workspace root -> ${root ?? "(none)"}`);
    },
  });

  explorerView.webContents.once("did-finish-load", () => {
    logger.info(`explorer view loaded: ${explorerView?.webContents.getURL()}`);
    pushExplorerState();
    void syncTheme();
  });

  themeSyncTimer = setInterval(() => {
    void syncTheme();
  }, 800);

  void dshView.webContents.loadURL(url);
  void explorerView.webContents.loadFile(path.join(app.getAppPath(), "assets", "file-explorer.html"));
}

function focusMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const url = serverManager?.getState().url;
  if (url) createWindow(url);
}

function onServerStatus(status: ServerStatus, url?: string): void {
  logger.info(`server status -> ${status}${url ? ` (${url})` : ""}`);
  if (tray) tray.updateStatus(status, url);

  if (status === "running" && url) {
    if (!mainWindow) {
      void waitForReady(url)
        .then(() => createWindow(url))
        .catch((error) => showError(String(error)));
    } else if (dshView) {
      const current = dshView.webContents.getURL();
      if (!current.startsWith(url)) void dshView.webContents.loadURL(url);
    }
  }
}

function registerExplorerUiIpc(): void {
  ipcMain.handle("dsh-explorer:toggle", () => {
    explorerCollapsed = !explorerCollapsed;
    layout();
    return {
      collapsed: explorerCollapsed,
      width: explorerCollapsed ? COLLAPSED_WIDTH : explorerWidth,
    };
  });

  ipcMain.handle("dsh-explorer:set-width", (_event, px: number) => {
    if (typeof px === "number" && Number.isFinite(px)) {
      explorerWidth = Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, Math.round(px)));
      if (explorerCollapsed) explorerCollapsed = false;
    }
    layout();
    return { collapsed: explorerCollapsed, width: explorerWidth };
  });
}

async function bootstrap(): Promise<void> {
  serverManager = new DshServerManager();
  serverManager.on("status", onServerStatus);
  serverManager.on("output", (stream, text) => {
    logger[stream === "stdout" ? "info" : "warn"](`[dsh:${stream}] ${text.trimEnd()}`);
  });
  tray = createTray({
    onOpen: focusMainWindow,
    onLogs: () => openLogWindow(),
    onSettings: () => openSettingsWindow(),
    onRestart: () => serverManager?.restart(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
    getSettings,
    updateSettings: (patch: Partial<AppSettings>) => {
      const next = saveSettings(patch);
      applyLaunchAtLogin(next.launchAtLogin);
      if (tray) tray.refreshSettings(next);
      return next;
    },
  });

  const settings = getSettings();
  applyLaunchAtLogin(settings.launchAtLogin);
  if (tray) tray.refreshSettings(settings);

  // Init the update manager so the GitHub proxy applies before any check.
  UpdateManager.get().init(settings.githubProxy);

  try {
    await serverManager.start();
  } catch (error) {
    showError(String(error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    initLogger();
    Menu.setApplicationMenu(null);
    registerLogIpc();
    registerSettingsIpc();
    registerFileExplorerIpc();
    registerExplorerUiIpc();
    logger.info("app starting");
    void bootstrap();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) focusMainWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    serverManager?.stop();
  });
}
