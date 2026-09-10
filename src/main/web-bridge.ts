import { app, dialog, ipcMain, type WebContents } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { guardWebView } from "./ipc-guard";

/**
 * In-page capabilities injected into the dsh web view (main world) that the
 * upstream `dsh web` bundle does not provide, but which a desktop shell can
 * supply cheaply without patching upstream sources:
 *
 *  1. Drive switching in the in-app workspace directory picker. The `browse`
 *     picker (`picker-browse.patch.yml`) lists only the current drive's
 *     ancestry, so on Windows an operator cannot reach `D:\` except by typing
 *     the path by hand. We enumerate drive roots in the main process, push
 *     them into the page as `window.__dshDesktopDrives`, and inject a drive
 *     selector into the picker dialog.
 *
 *  2. Current workspace root discovery. The right-hand explorer pane is a
 *     separate WebContentsView and cannot see dsh's workspace state. The main
 *     process reads the persisted workspace registry under `~/.dsh` and
 *     forwards the active root to the explorer pane, sidestepping any fragile
 *     DOM scraping.
 *
 * Everything below is defensive: any DOM/upstream change makes an injection a
 * no-op rather than throwing, so a newer dsh release at worst loses the
 * convenience feature instead of breaking startup.
 */

const MAX_PICKED_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Fallback sweep interval for the injected script. DOM mutations drive the
 * sweep; this only covers a missed or unavailable MutationObserver.
 */
const INJECT_SWEEP_INTERVAL_MS = 2000;

/** Image file extensions accepted by the dsh image attachment pipeline. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** `dialog.showOpenDialog` filters: images only. */
const IMAGE_FILTERS = [
  { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
];

export interface WebBridgeDeps {
  /** Called with the active workspace root whenever it changes. */
  onWorkspaceRoot?: (root: string | null) => void;
}

/** Sentinel installed exactly once per page load (module-scope in the page). */
const PAGE_SENTINEL = "__dshDesktopBridgeInstalled";

/**
 * `cwd` of the most recently written session record, or `null`.
 *
 * Reads only the newest candidate first and stops at the first record that
 * carries a usable `cwd`, so the common case is a single small file read.
 * Subagent sessions are stored in the same directory and may lack a `cwd`;
 * they are simply skipped rather than treated as the active workspace.
 */
function mostRecentSessionCwd(sessionsDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }

  const candidates: { file: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(sessionsDir, name);
    try {
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      /* vanished mid-scan */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const { file } of candidates.slice(0, 8)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        record?: { identity?: { cwd?: unknown } };
      };
      const cwd = parsed?.record?.identity?.cwd;
      if (typeof cwd === "string" && cwd.trim() !== "") return path.resolve(cwd);
    } catch {
      /* unreadable or partially written; try the next newest */
    }
  }
  return null;
}

/**
 * Windows drive roots, e.g. `["C:\\", "D:\\"]`. Mirrors the enumeration used by
 * the explorer IPC; kept local so the bridge has no cross-module coupling.
 */
function listWindowsDrives(): string[] {
  if (process.platform !== "win32") return [];
  const drives: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(root);
      drives.push(root);
    } catch {
      /* drive not mounted */
    }
  }
  return drives;
}

/**
 * Active workspace root, read from dsh's live session store.
 *
 * Priority:
 *  1. The most recently *written* session record's `cwd`
 *     (`storages/session_projcache/sessions/<id>.json` →
 *     `record.identity.cwd`, ranked by file mtime). dsh rewrites this file on
 *     every persisted session change, so mtime is genuine activity — unlike
 *     `lastPromptAt`, which only moves when the user submits a prompt and so
 *     goes stale as soon as a session is continued, switched, or resumed.
 *  2. Fallback: the most recently updated workspace (`workspace.json` →
 *     `tables.workspaces.<id>.path` by `updatedAt`).
 *
 * The aggregate `session_projcache.json` is deliberately NOT consulted: it is
 * written on a slower cadence and can lag the per-session files, which is what
 * made the explorer pin to a stale workspace.
 */
function readWorkspaceRoot(): string | null {
  const home = app.getPath("home");
  // Honour DSH_HOME the same way dsh itself resolves its state directory;
  // otherwise a relocated state dir makes this probe silently useless.
  const configured = process.env.DSH_HOME?.trim();
  const dshHome = configured ? configured : path.join(home, ".dsh");
  const storages = path.join(dshHome, "storages");

  // 1. Most recently written session record.
  const root = mostRecentSessionCwd(path.join(storages, "session_projcache", "sessions"));
  if (root) return root;

  // 2. Most recently updated workspace.
  try {
    const file = path.join(storages, "workspace.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      tables?: { workspaces?: Record<string, { path?: unknown; updatedAt?: unknown }> };
    };
    const table = parsed?.tables?.workspaces ?? {};
    let bestPath: string | null = null;
    let bestUpdated = 0;
    for (const id of Object.keys(table)) {
      const entry = table[id];
      if (!entry || typeof entry.path !== "string" || entry.path === "") continue;
      const t = Date.parse(String(entry.updatedAt ?? ""));
      const ts = Number.isFinite(t) ? t : 0;
      if (bestPath === null || ts > bestUpdated) {
        bestPath = entry.path;
        bestUpdated = ts;
      }
    }
    if (bestPath) return path.resolve(bestPath);
  } catch {
    /* no persisted workspace */
  }

  return null;
}

/** Serialize for an inline <script>-style value into the target page. */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

let ipcRegistered = false;

/**
 * Register the one-shot IPC that lets the injected page open the native image
 * picker. Safe to call multiple times; registration happens once.
 */
function registerImagePickerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("dsh-desktop:pick-images", async (event) => {
    guardWebView(event);
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: IMAGE_FILTERS,
    });
    if (result.canceled) return [];
    const picked: { name: string; type: string; dataUrl: string }[] = [];
    for (const filePath of result.filePaths) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        const type = IMAGE_TYPES[ext];
        if (!type) continue;
        // The dialog's filter is a suggestion, not an enforcement point, and an
        // unbounded read is base64-expanded (+33%) and shipped over IPC twice.
        const st = await fsp.stat(filePath);
        if (!st.isFile() || st.size > MAX_PICKED_IMAGE_BYTES) continue;
        const buf = await fsp.readFile(filePath);
        picked.push({
          name: path.basename(filePath),
          type,
          dataUrl: `data:${type};base64,${buf.toString("base64")}`,
        });
      } catch {
        /* skip unreadable files */
      }
    }
    return picked;
  });
}

/**
 * Install the dsh-page bridge and return a disposer.
 *
 * Every timer and listener registered here belongs to the calling window, so
 * the caller must dispose it when that window closes; otherwise a recreated
 * window stacks another poll and another `did-finish-load` listener on top of
 * the stale ones.
 */
export function installWebBridge(dshView: WebContents, explorerView: WebContents, deps: WebBridgeDeps = {}): () => void {
  registerImagePickerIpc();

  const pushDrives = () => {
    if (dshView.isDestroyed()) return;
    const drives = listWindowsDrives();
    void dshView
      .executeJavaScript(`window.__dshDesktopDrives = ${json(drives)};`)
      .catch(() => {
        /* page not ready yet */
      });
  };

  const inject = () => {
    if (dshView.isDestroyed()) return;
    pushDrives();
    void dshView.executeJavaScript(INSTALL_SCRIPT).catch(() => {
      /* page not ready yet */
    });
  };

  dshView.on("did-finish-load", inject);
  inject();

  // Workspace-root watcher: poll the persisted registry and forward changes.
  let lastRoot: string | null | undefined;
  const probe = () => {
    const root = readWorkspaceRoot();
    if (root === lastRoot) return;
    lastRoot = root;
    deps.onWorkspaceRoot?.(root);
    if (explorerView && !explorerView.isDestroyed()) {
      explorerView.send("dsh-explorer:workspace-root", root);
    }
  };
  const probeTimer = setInterval(probe, 1000);
  probe();

  return () => {
    clearInterval(probeTimer);
    dshView.removeListener("did-finish-load", inject);
  };
}

/**
 * Main-world script. Adds a drive selector to the workspace directory picker
 * dialog. Drive selection commits `X:\` through the picker's own path editor:
 * open the editor, set the value with the native setter + input event (so
 * React's controlled input observes it), and dispatch Enter.
 */
const INSTALL_SCRIPT = `
(() => {
  if (window["${PAGE_SENTINEL}"]) return;
  window["${PAGE_SENTINEL}"] = true;

  const DRIVE_DROPDOWN_ID = "__dshDesktopDriveSelect";

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function commitPath(input, root) {
    setNativeValue(input, root);
    // React's Enter handler reads pathDraft from the re-rendered closure, so
    // let the state update settle before dispatching the Enter keydown.
    window.setTimeout(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }, 0);
  }

  function navigateToPath(root) {
    // Open the path editor if it is not already open; React renders the
    // <input> asynchronously, so poll briefly for it.
    let input = document.querySelector(".ZuhsRW_pathInput");
    if (input) {
      commitPath(input, root);
      return;
    }
    const zone = document.querySelector(".ZuhsRW_crumbEditZone");
    if (zone) zone.click();
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      input = document.querySelector(".ZuhsRW_pathInput");
      if (input) {
        clearInterval(timer);
        commitPath(input, root);
      } else if (attempts > 20) {
        clearInterval(timer);
      }
    }, 50);
  }

  function ensureDriveDropdown() {
    if (document.getElementById(DRIVE_DROPDOWN_ID)) return true;
    return decorateDriveDropdown();
  }

  function decorateDriveDropdown() {
    const dialog = document.querySelector(".ZuhsRW_dialog");
    if (!dialog) return false;
    const header = dialog.querySelector(".ZuhsRW_header");
    if (!header) return false;

    const sel = document.createElement("select");
    sel.id = DRIVE_DROPDOWN_ID;
    sel.title = "切换盘符";
    Object.assign(sel.style, {
      background: "var(--dsw-alias-bg-layer-2, #12151a)",
      color: "var(--dsw-alias-label-primary, #e6e8ec)",
      border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16))",
      borderRadius: "6px",
      padding: "4px 6px",
      fontSize: "12px",
      maxWidth: "80px",
      outline: "none",
      cursor: "pointer",
    });
    const render = (drives) => {
      sel.textContent = "";
      for (const d of drives || []) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d.replace(/[\\\\/]+$/, "");
        sel.appendChild(opt);
      }
    };
    render(window.__dshDesktopDrives);
    sel.addEventListener("change", () => {
      if (sel.value) navigateToPath(sel.value);
    });
    // React owns .ZuhsRW_header and removes the children it knows about. A node
    // React never created either leaks on the next reconciliation or makes its
    // removeChild throw NotFoundError, which can blank the surrounding UI.
    // Tag the node so "still attached" is verifiable, and never append twice.
    sel.setAttribute("data-dsh-desktop", "drive-select");
    const stale = header.querySelector('[data-dsh-desktop="drive-select"]');
    if (stale && stale !== sel) stale.remove();
    if (!header.contains(sel)) header.appendChild(sel);
    return true;
  }

  // ---- image picker button ------------------------------------------
  // dsh web ingests images only via drag-drop/paste (document-level handlers).
  // We synthesize that path: the button asks the host for files, rebuilds real
  // File objects, and dispatches a drop event with a real DataTransfer, so the
  // existing attachment pipeline runs unchanged.
  const PICK_BTN_ID = "__dshDesktopPickImage";

  function base64ToBytes(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function dispatchDrop(files) {
    if (!files.length) return;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }

  async function onPickImage() {
    const picker = window.dshDesktop && window.dshDesktop.pickImages;
    if (typeof picker !== "function") return;
    let results;
    try {
      results = await picker();
    } catch {
      return;
    }
    const files = (results || []).map((r) => {
      try {
        const bytes = base64ToBytes(r.dataUrl);
        return new File([bytes], r.name, { type: r.type });
      } catch {
        return null;
      }
    }).filter((f) => f !== null);
    dispatchDrop(files);
  }

  function ensurePickButton() {
    if (document.getElementById(PICK_BTN_ID)) return true;
    // The composer input is the attachment home. Anchor to the composer box:
    // dsh ≤0.1.1 used a <textarea>; dsh ≥0.1.2-rc.1 switched to a
    // contenteditable ([role="textbox"][contenteditable]). Handle both.
    const input = document.querySelector('textarea')
      || document.querySelector('[role="textbox"][contenteditable], [contenteditable="true"][role="textbox"], div[contenteditable="true"]');
    if (!input) return false;
    const anchor = input.closest("[data-input-scroll]") || input.closest("form") || input.parentElement;
    if (!anchor || !anchor.parentElement) return false;

    const btn = document.createElement("button");
    btn.id = PICK_BTN_ID;
    btn.type = "button";
    btn.title = "选择图片";
    btn.textContent = "🖼 选择图片";
    Object.assign(btn.style, {
      background: "var(--dsw-alias-interactive-bg-hover-solid, #1c2029)",
      color: "var(--dsw-alias-label-primary, #e6e8ec)",
      border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16))",
      borderRadius: "6px",
      padding: "4px 10px",
      fontSize: "12px",
      cursor: "pointer",
      margin: "0 8px",
      lineHeight: "1.4",
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPickImage();
    });
    // Same React-owned container as the drive selector: never append twice and
    // never leave an untracked node behind for reconciliation to trip over.
    btn.setAttribute("data-dsh-desktop", "pick-image");
    const wrap = anchor.parentElement;
    const stale = wrap.querySelector('[data-dsh-desktop="pick-image"]');
    if (stale && stale !== btn) stale.remove();
    if (!wrap.contains(btn)) wrap.appendChild(btn);
    return true;
  }

  // Sweep on DOM change (React re-renders are what remove our nodes) with a
  // slow fallback tick, instead of polling at the old 500ms.
  let sweepQueued = false;
  function scheduleSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      try {
        ensureDriveDropdown();
      } catch (_) { /* upstream DOM changed; the next sweep retries */ }
      try {
        ensurePickButton();
      } catch (_) { /* upstream DOM changed; the next sweep retries */ }
    }, 50);
  }

  // Only react to mutations that are actually relevant. The dsh page streams
  // text while a model responds, so a blanket subtree observer would schedule a
  // sweep for every token. React adding a node only matters when a node we own
  // is gone; removals matter when we own the removed node.
  function relevant(mutations) {
    for (const m of mutations) {
      const added = m.addedNodes;
      for (let i = 0; i < added.length; i++) {
        if (added[i] && added[i].nodeType === 1 && gone(added[i])) return true;
      }
      const removed = m.removedNodes;
      for (let i = 0; i < removed.length; i++) {
        const node = removed[i];
        if (!node || node.nodeType !== 1) continue;
        if (node.id === PICK_BTN_ID || node.id === DRIVE_DROPDOWN_ID) return true;
        if (node.querySelector && node.querySelector('[data-dsh-desktop]')) return true;
      }
    }
    return false;
  }
  function gone(node) {
    if (node.closest && node.closest('[data-dsh-desktop]')) return false;
    return true;
  }

  // React 的 DOM 变动是我们需要重挂节点的主因，因此由 MutationObserver 驱动，
  // 外加一个低频兜底扫描，取代原先 500ms 的固定轮询。
  try {
    new MutationObserver((mutations) => {
      if (relevant(mutations)) scheduleSweep();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (_) { /* the fallback interval below still covers it */ }
  setInterval(scheduleSweep, ${INJECT_SWEEP_INTERVAL_MS});
})();
`;
