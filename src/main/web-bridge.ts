import { app, dialog, ipcMain, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";

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

const DRIVE_PROBE_INTERVAL_MS = 500;

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
 * Active workspace root from the persisted dsh session registry.
 *
 * Priority:
 *  1. The most recently active session's `cwd` (session_projcache.json →
 *     tables.sessions.<id>.identity.cwd, ranked by
 *     sessionListMetadata.lastPromptAt) — this tracks the conversation the
 *     user is currently working in.
 *  2. Fallback: the most recently updated workspace (workspace.json →
 *     tables.workspaces.<id>.path by updatedAt).
 */
function readWorkspaceRoot(): string | null {
  const home = app.getPath("home");

  // 1. Most recently active session's cwd.
  try {
    const file = path.join(home, ".dsh", "storages", "session_projcache.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      tables?: {
        sessions?: Record<
          string,
          {
            identity?: { cwd?: unknown };
            rows?: {
              sessionListMetadata?: { val?: { lastPromptAt?: unknown } };
            };
          }
        >;
      };
    };
    const sessions = parsed?.tables?.sessions ?? {};
    let bestCwd: string | null = null;
    let bestActive = -1;
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      const cwd = s?.identity?.cwd;
      if (typeof cwd !== "string" || cwd === "") continue;
      const t = Date.parse(String(s?.rows?.sessionListMetadata?.val?.lastPromptAt ?? ""));
      const ts = Number.isFinite(t) ? t : 0;
      if (bestCwd === null || ts > bestActive) {
        bestCwd = cwd;
        bestActive = ts;
      }
    }
    if (bestCwd) return path.resolve(bestCwd);
  } catch {
    /* fall through to workspace registry */
  }

  // 2. Most recently updated workspace.
  try {
    const file = path.join(home, ".dsh", "storages", "workspace.json");
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
  ipcMain.handle("dsh-desktop:pick-images", async () => {
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
        const buf = fs.readFileSync(filePath);
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

export function installWebBridge(dshView: WebContents, explorerView: WebContents, deps: WebBridgeDeps = {}): void {
  registerImagePickerIpc();

  const pushDrives = () => {
    const drives = listWindowsDrives();
    void dshView
      .executeJavaScript(`window.__dshDesktopDrives = ${json(drives)};`)
      .catch(() => {
        /* page not ready yet */
      });
  };

  const inject = () => {
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
  setInterval(probe, 1000);
  probe();
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
    const dialog = document.querySelector(".ZuhsRW_dialog");
    if (!dialog) return false;
    if (document.getElementById(DRIVE_DROPDOWN_ID)) return true;
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
    header.appendChild(sel);
    return true;
  }

  setInterval(ensureDriveDropdown, ${DRIVE_PROBE_INTERVAL_MS});

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
    anchor.parentElement.appendChild(btn);
    return true;
  }

  setInterval(ensurePickButton, ${DRIVE_PROBE_INTERVAL_MS});
})();
`;
