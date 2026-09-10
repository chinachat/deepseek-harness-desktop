import { app, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "node:url";

/**
 * Renderer-side trust boundary for `ipcMain.handle` channels.
 *
 * `ipcMain.handle` is process-global: every renderer's isolated world that can
 * reach `ipcRenderer` can invoke any registered channel. `contextBridge` decides
 * what a page can *see*, but it installs unconditionally from `webPreferences`
 * — not from the URL the view ends up loading. So an allowlist enforced in the
 * preload alone stops being a boundary the moment a view navigates.
 *
 * Every handler must therefore assert its caller. Two caller classes exist:
 *
 *  - our own HTML, loaded from `file://` inside the app bundle, and
 *  - the dsh web UI, served over loopback on a dynamically chosen port (which is
 *    why the allowed origin is registered at runtime rather than hard-coded).
 *
 * `senderFrame` is `null` when the frame has already been destroyed, so it is
 * checked before any property access.
 */

/** `file://` pages shipped in the app bundle that may invoke privileged IPC. */
const FILE_PAGE_ALLOWLIST = [
  "file-explorer.html",
  "settings.html",
  "log-viewer.html",
];

/** Origin of the live dsh web view, e.g. `http://127.0.0.1:52341`. */
let webViewOrigin: string | undefined;

/**
 * Register the origin of the currently served dsh web UI. Called whenever the
 * server reports a (possibly new) URL, so a restart on another port replaces
 * the previous grant instead of widening it.
 */
export function setWebViewOrigin(url: string | undefined): void {
  if (!url) {
    webViewOrigin = undefined;
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      webViewOrigin = undefined;
      return;
    }
    webViewOrigin = parsed.origin;
  } catch {
    webViewOrigin = undefined;
  }
}

function senderAccepts(event: IpcMainInvokeEvent): URL {
  const frame = event.senderFrame;
  if (frame === null || frame === undefined) {
    throw new Error("ipc: rejected (no sender frame)");
  }
  if (frame.parent !== null) {
    throw new Error("ipc: rejected (subframe sender)");
  }
  return new URL(frame.url);
}

/** Require a top-level `file://` page loaded from this app bundle. */
export function guardFilePage(event: IpcMainInvokeEvent): void {
  const url = senderAccepts(event);
  if (url.protocol !== "file:") {
    throw new Error(`ipc: rejected (not a file page: ${url.protocol})`);
  }
  const appRoot = pathToFileURL(app.getAppPath() + "/").href;
  if (!url.href.startsWith(appRoot)) {
    throw new Error("ipc: rejected (page outside the app bundle)");
  }
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (!FILE_PAGE_ALLOWLIST.includes(name)) {
    throw new Error(`ipc: rejected (page not allowlisted: ${name})`);
  }
}

/**
 * Require the caller to be the top-level document of the served dsh web UI.
 * Used by the channels whose bridge is intentionally exposed to that page.
 */
export function guardWebView(event: IpcMainInvokeEvent): void {
  const url = senderAccepts(event);
  if (webViewOrigin === undefined) {
    throw new Error("ipc: rejected (web view origin not registered)");
  }
  if (url.origin !== webViewOrigin) {
    throw new Error(`ipc: rejected (unexpected origin: ${url.origin})`);
  }
}
