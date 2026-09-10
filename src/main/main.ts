import { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView, type WebContents } from "electron";
import http from "node:http";
import path from "node:path";
import { initLogger, logger } from "./logger";
import { DshServerManager, type ServerStatus } from "./dsh-server";
import { createTray, TrayState } from "./tray";
import { openLogWindow, registerLogIpc } from "./log-window";
import { openSettingsWindow, registerSettingsIpc } from "./settings-window";
import { registerFileExplorerIpc, allowRoot } from "./file-explorer";
import { installWebBridge } from "./web-bridge";
import { guardFilePage, setWebViewOrigin } from "./ipc-guard";
import { UpdateManager } from "./updater";
import { applyLaunchAtLogin, getSettings, saveSettings, type AppSettings } from "./settings";

const EXPLORER_WIDTH = 360;
const COLLAPSED_WIDTH = 28;
const MIN_EXPLORER_WIDTH = 220;
const MAX_EXPLORER_WIDTH = 700;
/** Minimum width the dsh view keeps; the explorer never grows past this. */
const MIN_DSH_VIEW_WIDTH = 200;

let mainWindow: BrowserWindow | null = null;
let dshView: WebContentsView | null = null;
let explorerView: WebContentsView | null = null;
let serverManager: DshServerManager | undefined;
let tray: TrayState | undefined;
let isQuitting = false;
const startHidden = process.argv.includes("--hidden");
let lastThemeDark: boolean | undefined;
let themeSyncTimer: NodeJS.Timeout | null = null;
/** Disposer for the dsh-page bridge; every window owns exactly one. */
let disposeWebBridge: (() => void) | null = null;
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

/**
 * Keep the effective explorer width in one place so a drag reports the same
 * number the layout actually applied.
 */
function effectiveExplorerWidth(): number {
  if (!mainWindow || !dshView || !explorerView) return explorerWidth;
  const [width] = mainWindow.getContentSize();
  const requested = explorerCollapsed ? COLLAPSED_WIDTH : explorerWidth;
  return Math.min(requested, Math.max(0, width - MIN_DSH_VIEW_WIDTH));
}

function layout(): void {
  if (!mainWindow || !dshView || !explorerView) return;
  const [width, height] = mainWindow.getContentSize();
  const explorerW = effectiveExplorerWidth();
  const mainW = Math.max(0, width - explorerW);
  dshView.setBounds({ x: 0, y: 0, width: mainW, height });
  explorerView.setBounds({ x: mainW, y: 0, width: explorerW, height });
  pushExplorerState();
}

function pushExplorerState(): void {
  if (!explorerView || explorerView.webContents.isDestroyed()) return;
  explorerView.webContents.send("dsh-explorer:state", {
    collapsed: explorerCollapsed,
    width: effectiveExplorerWidth(),
  });
}

/**
 * Confine a view to the origins it is meant to display.
 *
 * `contextBridge` installs from `webPreferences`, not from the loaded URL, so a
 * view that navigates off-origin would carry its whole preload surface to the
 * new page. External links are handed to the OS browser instead.
 */
function hardenView(view: WebContentsView, allowed: (url: URL) => boolean, label: string): void {
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) {
      void shell.openExternal(url).catch((error) => logger.warn(`openExternal failed: ${String(error)}`));
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, target) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      event.preventDefault();
      return;
    }
    if (allowed(parsed)) return;
    logger.info(`${label}: blocked navigation to ${parsed.origin}`);
    event.preventDefault();
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void shell.openExternal(target).catch((error) => logger.warn(`openExternal failed: ${String(error)}`));
    }
  });
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

/** Reload a view whose renderer died, instead of leaving a blank pane. */
function recoverOnCrash(view: WebContentsView, label: string, reload: () => void): void {
  view.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`${label} renderer gone: ${details.reason} (exitCode=${details.exitCode})`);
    if (isQuitting) return;
    setTimeout(() => {
      if (isQuitting || view.webContents.isDestroyed()) return;
      reload();
    }, 1000);
  });
  view.webContents.on("unresponsive", () => {
    logger.warn(`${label} renderer unresponsive`);
  });
}

async function syncTheme(): Promise<void> {
  if (!dshView || !explorerView) return;
  const dshContents = dshView.webContents;
  const explorerContents = explorerView.webContents;
  if (dshContents.isDestroyed() || explorerContents.isDestroyed()) return;
  try {
    const dark = await dshContents.executeJavaScript(
      "document.body.hasAttribute('data-ds-dark-theme')"
    );
    if (dark !== lastThemeDark) {
      lastThemeDark = dark as boolean;
      await explorerContents.executeJavaScript(
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
    icon: path.join(app.getAppPath(), "assets", "icon.png"),
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

  const explorerUrl = path.join(app.getAppPath(), "assets", "file-explorer.html");
  const dshOrigin = new URL(url).origin;

  // The dsh view may only ever show the local server it was started for.
  hardenView(dshView, (target) => target.origin === dshOrigin, "dsh view");
  // Our own pages may only navigate between bundled file: pages.
  hardenView(
    explorerView,
    (target) => target.protocol === "file:" && target.pathname.endsWith(".html"),
    "explorer view"
  );

  recoverOnCrash(dshView, "dsh view", () => {
    if (serverManager) void dshView?.webContents.loadURL(url);
  });
  recoverOnCrash(explorerView, "explorer view", () => {
    void explorerView?.webContents.loadFile(explorerUrl);
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
    disposeWebBridge?.();
    disposeWebBridge = null;
    lastThemeDark = undefined;
    mainWindow = null;
    dshView = null;
    explorerView = null;
  });

  dshView.webContents.on("did-fail-load", (_event, code, description) => {
    logger.error(`window failed to load: ${code} ${description}`);
  });

  dshView.webContents.once("did-finish-load", () => {
    logger.info("dsh view loaded");
    void syncTheme();
  });

  disposeWebBridge = installWebBridge(dshView.webContents, explorerView.webContents, {
    onWorkspaceRoot: (root) => {
      // Claim the followed root up front: the explorer navigates there by
      // itself, and containment must not reject the app's own choice.
      if (root) allowRoot(root);
      logger.info(`workspace root -> ${root ?? "(none)"}`);
    },
  });

  explorerView.webContents.once("did-finish-load", () => {
    logger.info("explorer view loaded");
    pushExplorerState();
    void syncTheme();
  });

  themeSyncTimer = setInterval(() => {
    void syncTheme();
  }, 800);

  void dshView.webContents.loadURL(url);
  void explorerView.webContents.loadFile(explorerUrl);
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
  // Keep the IPC allowlist in step with the port the server actually chose.
  setWebViewOrigin(url);
  if (tray) tray.updateStatus(status, url);

  if (status === "running" && url) {
    if (!mainWindow) {
      void waitForReady(url)
        .then(() => createWindow(url))
        .catch((error) => showError(String(error)));
      return;
    }
    // Capture the view: the window's `closed` handler nulls the module binding,
    // so a stale reference here would crash the main process.
    const view = dshView;
    if (view && !view.webContents.isDestroyed()) {
      const current = view.webContents.getURL();
      if (current === "" || !current.startsWith(url)) void view.webContents.loadURL(url);
    }
  }
}

function registerExplorerUiIpc(): void {
  ipcMain.handle("dsh-explorer:toggle", (event) => {
    guardFilePage(event);
    explorerCollapsed = !explorerCollapsed;
    layout();
    return {
      collapsed: explorerCollapsed,
      width: effectiveExplorerWidth(),
    };
  });

  ipcMain.handle("dsh-explorer:set-width", (event, px: number) => {
    guardFilePage(event);
    if (typeof px === "number" && Number.isFinite(px)) {
      explorerWidth = Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, Math.round(px)));
      if (explorerCollapsed) explorerCollapsed = false;
    }
    layout();
    // Report the width that was actually applied, not the requested one, so the
    // renderer's drag baseline cannot drift from the real layout.
    return { collapsed: explorerCollapsed, width: effectiveExplorerWidth() };
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
    // The explorer's default browse root is the user's home; permit it before
    // any renderer can ask, so the first listing never races the allowlist.
    allowRoot(app.getPath("home"));
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
    disposeWebBridge?.();
    disposeWebBridge = null;
    serverManager?.stop();
  });
}
