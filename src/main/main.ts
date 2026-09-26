import { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView, type WebContents } from "electron";
import http from "node:http";
import path from "node:path";
import { initLogger, logger } from "./logger";
import { DshServerManager, type ServerStatus } from "./dsh-server";
import { createTray, TrayState } from "./tray";
import { openLogWindow, registerLogIpc } from "./log-window";
import { openSettingsWindow, registerSettingsIpc } from "./settings-window";
import { getWebViewOrigin, guardFilePage, setWebViewOrigin } from "./ipc-guard";
import { UpdateManager } from "./updater";
import { applyLaunchAtLogin, getSettings, saveSettings, type AppSettings } from "./settings";
import { publicUrl, redactSecrets } from "./redact";

let mainWindow: BrowserWindow | null = null;
let dshView: WebContentsView | null = null;
let serverManager: DshServerManager | undefined;
let tray: TrayState | undefined;
let isQuitting = false;
const startHidden = process.argv.includes("--hidden");
let themeSyncTimer: NodeJS.Timeout | null = null;
let lastThemeDark: boolean | undefined;

const HEALTH_TIMEOUT_MS = 30_000;

function showError(message: string): void {
  // This is the one place where text reaches the screen without going through
  // the logger, so redact here too: an error raised while talking to the dsh
  // server can quote its token-bearing URL.
  const safe = redactSecrets(message);
  logger.error(safe);
  dialog.showErrorBox("DeepSeek Harness 启动失败", safe);
  app.quit();
}

/** Origin of a URL, or `""` when it cannot be parsed. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Hostnames that mean "the machine we started the server on". */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True for the plain-HTTP loopback URLs the dsh server is allowed to use. */
function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Probe the announced URL, token included, and follow its redirect.
 *
 * The token is not optional. The browser-trust fence answers `GET /` without one
 * with 401 ("dsh web authentication required"), so probing the bare origin can
 * never see 200 and would report a healthy server as dead — which is exactly
 * how the UI used to time out after 30s while the server was fine.
 *
 * The first hop answers 303 and sets the session cookie; the cookie has to be
 * replayed on the redirect target, because the cookie is what carries the trust
 * forward. Node's plain `http.get` has no cookie jar, so it is threaded by hand.
 */
function isReady(url: string, cookie?: string, redirectsLeft = 3): Promise<boolean> {
  return new Promise((resolve) => {
    const options = cookie ? { headers: { cookie } } : {};
    const req = http.get(url, options, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      const setCookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
      if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          resolve(false);
          return;
        }
        // Only ever replay the session cookie — and the token in the URL — to
        // the loopback server we started ourselves. dsh redirects within its own
        // origin, so anything else is a server that should not be trusted with
        // the credential.
        if (!isLoopback(next)) {
          logger.warn(`refusing to follow a readiness redirect off loopback: ${next.origin}`);
          resolve(false);
          return;
        }
        resolve(isReady(next.href, setCookie ?? cookie, redirectsLeft - 1));
        return;
      }
      resolve(status === 200);
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
  // `error.message` reaches both the log and a modal dialog, so it must not
  // carry the token.
  throw new Error(`web UI did not become ready at ${publicUrl(url)}`);
}

function layout(): void {
  if (!mainWindow || !dshView) return;
  const [width, height] = mainWindow.getContentSize();
  dshView.setBounds({ x: 0, y: 0, width, height });
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

/**
 * Mirrors the theme the dsh UI applies to its own <body> onto the log and
 * settings windows so they follow the main window.
 */
async function syncTheme(): Promise<void> {
  if (!dshView) return;
  const contents = dshView.webContents;
  if (contents.isDestroyed()) return;
  try {
    const dark = (await contents.executeJavaScript(
      "document.body.hasAttribute('data-ds-dark-theme')"
    )) as boolean;
    if (dark !== lastThemeDark) {
      lastThemeDark = dark;
      for (const win of BrowserWindow.getAllWindows()) {
        if (win === mainWindow || win.isDestroyed()) continue;
        void win.webContents.executeJavaScript(`document.body.toggleAttribute('data-dark', ${dark});`);
      }
    }
  } catch {
    /* view not ready yet */
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
      // Dedicated session: the dsh UI authenticates by exchanging its token for
      // a cookie, and it must not share a cookie jar with our own pages (nor
      // inherit one left behind by a previous run).
      partition: "persist:dsh-web",
    },
  });

  // The dsh view may only ever show the local server it was started for. The
  // allowed origin is read live from `ipc-guard` rather than captured here: dsh
  // takes a fresh port on every restart, so a value captured at window creation
  // would keep rejecting the new origin — and hand the token-bearing URL to the
  // system browser through the "external link" path below.
  hardenView(dshView, (target) => target.origin === getWebViewOrigin(), "dsh view");
  recoverOnCrash(dshView, "dsh view", () => {
    // Reload the announced URL, token included, so recovery does not depend on
    // a session cookie surviving the crash.
    const current = serverManager?.getState().url ?? url;
    void dshView?.webContents.loadURL(current);
  });

  mainWindow.contentView.addChildView(dshView);
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
  });

  dshView.webContents.on("did-fail-load", (_event, code, description) => {
    logger.error(`window failed to load: ${code} ${description}`);
  });

  dshView.webContents.once("did-finish-load", () => {
    logger.info("dsh view loaded");
    void syncTheme();
  });

  themeSyncTimer = setInterval(() => {
    void syncTheme();
  }, 800);

  void dshView.webContents.loadURL(url);
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
  // Log the origin, not the announce URL: the query carries the session token
  // and this line ends up in dsh-desktop.log.
  logger.info(`server status -> ${status}${url ? ` (${publicUrl(url)})` : ""}`);
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
      // Compare origins, not the full URL: the token is minted per process, so
      // a restart always changes the query string and a string comparison would
      // reload the view on every status event.
      const current = view.webContents.getURL();
      const sameOrigin = current !== "" && originOf(current) === originOf(url);
      if (!sameOrigin) void view.webContents.loadURL(url);
    }
  }
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
