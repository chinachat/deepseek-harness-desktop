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
 * Every handler must therefore assert its caller. Today exactly one caller
 * class reaches a privileged channel: our own HTML, loaded from `file://` inside
 * the app bundle. The other class — the dsh web UI, served over loopback on a
 * dynamically chosen port — has no bridge of its own (`src/preload/preload.ts`
 * exposes runtime facts only), so {@link setWebViewOrigin} below feeds the
 * *view's navigation guard* in `main.ts` rather than an IPC allowlist. A future
 * change that gives that page a privileged channel must guard it with
 * {@link getWebViewOrigin}.
 *
 * `senderFrame` is `null` when the frame has already been destroyed, so it is
 * checked before any property access.
 */

/** `file://` pages shipped in the app bundle that may invoke privileged IPC. */
const FILE_PAGE_ALLOWLIST = [
  "settings.html",
  "log-viewer.html",
];

/** Origin of the live dsh web view, e.g. `http://127.0.0.1:52341`. */
let webViewOrigin: string | undefined;

/**
 * Register the origin of the currently served dsh web UI. Called whenever the
 * server reports a (possibly new) URL, so a restart on another port replaces
 * the previous grant instead of widening it.
 *
 * This is the single source of truth for "which origin is the live dsh UI":
 * `main.ts` reads it back through {@link getWebViewOrigin} for the view's
 * navigation guard. Keeping one copy is what stops the IPC allowlist and the
 * navigation allowlist from disagreeing after a restart lands on a new port.
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
 * Origin of the live dsh web UI, or `undefined` before the server has announced
 * itself and after it has been stopped.
 *
 * Read by the dsh view's navigation guard so the allowed origin follows a
 * restart onto a new port, instead of being frozen at window creation.
 */
export function getWebViewOrigin(): string | undefined {
  return webViewOrigin;
}
