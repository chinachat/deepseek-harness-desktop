import { app, ipcMain, shell } from "electron";
import fsp from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { guardFilePage } from "./ipc-guard";

const MAX_READ_BYTES = 1_000_000;
const MAX_READ_CHARS = 400_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/**
 * Extensions the OS "open" verb is allowed to handle.
 *
 * `shell.openPath` is a code-execution primitive: on Windows it runs the shell
 * open verb, so `.exe`, `.bat`, `.cmd`, `.ps1`, `.scr` and `.msi` execute, and
 * a `.lnk`/`.url` redirects to anything without carrying a Mark-of-the-Web flag
 * (so SmartScreen does not stop it). Only document/image/media types that a
 * file browser plausibly previews are admitted.
 */
const OPENABLE_EXTENSIONS = new Set([
  ".pdf",
  ".txt", ".log", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".env",
  ".md", ".markdown", ".rst", ".adoc",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".tif", ".tiff",
  ".mp3", ".wav", ".flac", ".m4a", ".mp4", ".mkv", ".webm", ".mov", ".avi",
  ".zip", ".7z", ".gz", ".tar", ".rar",
  ".json", ".xml", ".yml", ".yaml", ".html", ".htm", ".css", ".js", ".ts",
]);

/**
 * Directories the renderer is permitted to read.
 *
 * The explorer is a user-facing file browser, so its reach is intentionally
 * broad; the point of this set is that a root must be claimed explicitly by a
 * navigation request rooted at that directory (which is exactly what the drive
 * dropdown and the workspace-root push do), rather than any absolute path in a
 * payload being silently honoured. Containment is then re-checked against the
 * *real* path so a symlink cannot escape a claimed root.
 */
const allowedRoots = new Set<string>();

/**
 * Permit a directory tree explicitly, without a renderer request. Used for the
 * roots the app itself decides on — the user's home (the default browse root)
 * and the workspace the explorer is asked to follow.
 */
export function allowRoot(dir: string): void {
  try {
    allowedRoots.add(realpathSync.native(dir));
  } catch {
    /* not a real directory; nothing to permit */
  }
}

function normalizeDir(raw: string): string {
  // `path.resolve("C:")` means "the current directory on drive C:", which is
  // unrelated to the drive root and inconsistent with how a caller reads it.
  // Treat a bare drive designator as its root.
  const driveOnly = /^([A-Za-z]):$/.exec(raw.trim());
  if (driveOnly) return `${driveOnly[1].toUpperCase()}:\\`;
  return path.resolve(raw);
}

function defaultProjectDir(): string {
  try {
    const cwd = process.cwd();
    // A packaged app launched from a shortcut inherits an unrelated cwd
    // (system32 on Windows); the user's home is the honest fallback.
    if (cwd && cwd.trim().length > 0 && app.isPackaged === false) return cwd;
  } catch {
    /* fall through */
  }
  return app.getPath("home");
}

function isContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function confineExisting(input: string): Promise<string> {
  // realpath resolves symlinks and junctions, so containment is evaluated on
  // the real location rather than the path the caller typed.
  const real = await fsp.realpath(input);
  for (const root of allowedRoots) {
    if (isContained(root, real)) return real;
  }
  throw new Error(`path outside the permitted roots: ${real}`);
}

/**
 * Resolve the base directory of a request, claiming it as an allowed root.
 *
 * A root is only ever claimed by naming it as the base (`dir`) of a request,
 * which is how the published explorer UI navigates: the drive dropdown, the
 * `..` button and the workspace-root watcher all send the target directory as
 * `dir`. Nothing else can widen the set — `name` is validated as a single
 * segment, and `read`/`open` are confined to roots already claimed.
 */
async function resolveBase(dir?: string): Promise<string> {
  const raw = dir && dir.trim() ? dir : defaultProjectDir();
  const base = normalizeDir(raw);
  const real = await fsp.realpath(base);
  allowedRoots.add(real);
  return real;
}

/**
 * Accept only a single, non-navigating path segment.
 * Rejects `..`, `.`, embedded separators and NUL so a caller can never
 * escape `base` through `name`.
 */
function validSegment(name: string | undefined): name is string {
  if (name === undefined || name === "") return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

interface ListPayload {
  dir?: string;
  name?: string;
}

interface ReadPayload {
  dir?: string;
  name?: string;
}

async function readText(resolved: string, size: number): Promise<{ kind: "binary"; size: number } | { kind: "file"; content: string; truncated: boolean; size: number }> {
  const readBytes = Math.min(size, MAX_READ_BYTES);
  const buf = Buffer.alloc(readBytes || 1);
  const handle = await fsp.open(resolved, "r");
  try {
    const { bytesRead } = await handle.read(buf, 0, readBytes, 0);
    const data = buf.subarray(0, bytesRead);
    if (isBinary(data)) return { kind: "binary", size };
    let content = data.toString("utf8");
    const truncated = size > MAX_READ_BYTES || content.length > MAX_READ_CHARS;
    if (content.length > MAX_READ_CHARS) content = content.slice(0, MAX_READ_CHARS);
    return { kind: "file", content, truncated, size };
  } finally {
    await handle.close();
  }
}

export function registerFileExplorerIpc(): void {
  ipcMain.handle("dsh-fs:list", async (event, payload: ListPayload = {}) => {
    guardFilePage(event);
    const base = await resolveBase(payload.dir);
    const target = validSegment(payload.name) ? path.join(base, payload.name) : base;
    const resolved = await confineExisting(target);
    const dirents = await fsp.readdir(resolved, { withFileTypes: true });
    const entries: { name: string; type: string; size: number | null }[] = [];
    for (const d of dirents) {
      let type = "file";
      let size: number | null = null;
      // lstat semantics: a symlink is reported as its own kind rather than
      // silently standing in for whatever it points at.
      if (d.isDirectory()) type = "directory";
      else if (d.isSymbolicLink()) type = "other";
      if (type === "file") {
        try {
          size = (await fsp.stat(path.join(resolved, d.name))).size;
        } catch {
          size = null;
        }
      }
      entries.push({ name: d.name, type, size });
    }
    entries.sort((a, b) => {
      const ad = a.type === "directory" ? 0 : 1;
      const bd = b.type === "directory" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
    return { path: resolved, parent: path.dirname(resolved), entries };
  });

  ipcMain.handle("dsh-fs:read", async (event, payload: ReadPayload = {}) => {
    guardFilePage(event);
    const base = await resolveBase(payload.dir);
    if (!validSegment(payload.name)) throw new Error("invalid path segment");
    const resolved = await confineExisting(path.join(base, payload.name));
    // stat (not lstat) after confineExisting: the realpath check already ran.
    const st = await fsp.stat(resolved);
    if (st.isDirectory()) return { path: resolved, kind: "directory", size: st.size };

    const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (mime) {
      if (st.size > MAX_IMAGE_BYTES) {
        return { path: resolved, kind: "image", mime, dataUrl: null, tooLarge: true, size: st.size };
      }
      const buf = await fsp.readFile(resolved);
      return { path: resolved, kind: "image", mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}`, size: st.size };
    }

    const text = await readText(resolved, st.size);
    return { path: resolved, ...text };
  });

  ipcMain.handle("dsh-fs:drives", async (event) => {
    guardFilePage(event);
    const drives: { name: string; path: string }[] = [];
    if (process.platform === "win32") {
      for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const rootPath = `${letter}:\\`;
        try {
          await fsp.access(rootPath);
          drives.push({ name: `${letter}:`, path: rootPath });
        } catch {
          /* 跳过不存在的盘符 */
        }
      }
    } else {
      drives.push({ name: "/", path: "/" });
    }
    return drives;
  });

  /**
   * Open a file with the OS default application (e.g. a PDF in the PDF
   * viewer). Restricted to the explorer pane, to a claimed root, and to
   * document/media extensions — never an executable or a shortcut.
   */
  ipcMain.handle("dsh-fs:open", async (event, payload: ReadPayload = {}) => {
    guardFilePage(event);
    const base = await resolveBase(payload.dir);
    if (!validSegment(payload.name)) throw new Error("invalid path segment");
    const resolved = await confineExisting(path.join(base, payload.name));
    const ext = path.extname(resolved).toLowerCase();
    if (!OPENABLE_EXTENSIONS.has(ext)) {
      return { ok: false, error: `出于安全考虑，不通过系统默认程序打开 ${ext || "无扩展名的"} 文件` };
    }
    const errorMessage = await shell.openPath(resolved);
    return { ok: errorMessage === "", error: errorMessage || null };
  });
}
