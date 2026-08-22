import { ipcMain, shell } from "electron";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

function resolveBase(dir?: string): string {
  const raw = dir && dir.trim() ? dir : defaultProjectDir();
  return path.resolve(raw);
}

function defaultProjectDir(): string {
  try {
    const cwd = process.cwd();
    if (cwd && cwd.trim().length > 0) return cwd;
  } catch {
    /* fall through */
  }
  return homedir();
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
  ipcMain.handle("dsh-fs:list", async (_event, payload: ListPayload = {}) => {
    const base = resolveBase(payload.dir);
    const resolved = validSegment(payload.name) ? path.join(base, payload.name) : base;
    const dirents = await fsp.readdir(resolved, { withFileTypes: true });
    const entries: { name: string; type: string; size: number | null }[] = [];
    for (const d of dirents) {
      let type = "file";
      let size: number | null = null;
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

  ipcMain.handle("dsh-fs:read", async (_event, payload: ReadPayload = {}) => {
    const base = resolveBase(payload.dir);
    if (!validSegment(payload.name)) throw new Error("invalid path segment");
    const resolved = path.join(base, payload.name);
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

  ipcMain.handle("dsh-fs:drives", async () => {
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
   * viewer). Only usable from the explorer pane; path traversal is rejected
   * the same way as `dsh-fs:read`.
   */
  ipcMain.handle("dsh-fs:open", async (_event, payload: ReadPayload = {}) => {
    const base = resolveBase(payload.dir);
    if (!validSegment(payload.name)) throw new Error("invalid path segment");
    const resolved = path.join(base, payload.name);
    const errorMessage = await shell.openPath(resolved);
    return { ok: errorMessage === "", error: errorMessage || null };
  });
}
