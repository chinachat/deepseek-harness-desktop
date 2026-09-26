import { app, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export interface AppSettings {
  launchAtLogin: boolean;
  closeToTray: boolean;
  /** GitHub 代理地址,如 `http://127.0.0.1:7890`;留空表示跟随系统代理。 */
  githubProxy: string;
}

const DEFAULTS: AppSettings = {
  launchAtLogin: false,
  closeToTray: true,
  githubProxy: "",
};

let cached: AppSettings | undefined;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Coerce a persisted/patched record into a valid `AppSettings`. */
function sanitize(raw: unknown): AppSettings {
  const source = (raw ?? {}) as Record<string, unknown>;
  const pickBool = (key: keyof AppSettings): boolean => {
    const value = source[key];
    return typeof value === "boolean" ? value : DEFAULTS[key] as boolean;
  };
  const proxy = source.githubProxy;
  return {
    launchAtLogin: pickBool("launchAtLogin"),
    closeToTray: pickBool("closeToTray"),
    githubProxy: typeof proxy === "string" ? proxy : DEFAULTS.githubProxy,
  };
}

export function getSettings(): AppSettings {
  if (cached) return cached;
  let value: AppSettings;
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    value = sanitize(JSON.parse(raw));
  } catch {
    value = { ...DEFAULTS };
  }
  cached = value;
  return value;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  // Only known keys with valid types are persisted, so a renderer cannot seed
  // settings.json with a value that behaves differently on the next launch.
  const next = sanitize({ ...getSettings(), ...(patch ?? {}) });
  cached = next;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    logger.error(`failed to save settings: ${String(error)}`);
  }
  return next;
}

export function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ["--hidden"],
  });
}

/**
 * The session electron-updater performs its requests in.
 *
 * `ElectronHttpExecutor.createRequest` builds every request with
 * `net.request({ session: session.fromPartition("electron-updater", { cache: false }) })`
 * (see `electron-updater/out/electronHttpExecutor.js`), so the proxy has to be
 * configured on *that* session. Setting it on `defaultSession` never reaches
 * update traffic, and because the request does not go through Node's `https`
 * either, writing `HTTPS_PROXY` into the environment would not help.
 *
 * The partition name is electron-updater's `NET_SESSION_NAME` constant, which it
 * does not export: re-check this against `electronHttpExecutor.js` when
 * electron-updater is upgraded.
 */
const UPDATER_SESSION_PARTITION = "electron-updater";

/**
 * Apply the GitHub proxy to the session update traffic actually uses.
 *
 * An empty setting means "follow the operating system's proxy", NOT "connect
 * directly". Before this function targeted the updater session at all, that
 * session was left alone and therefore used the system proxy; pinning `direct`
 * here would silently break updates for every user behind a system-wide proxy
 * (Clash / v2ray / corporate), which on many networks is the only way to reach
 * GitHub at all. Measured with `session.resolveProxy` on a machine whose system
 * proxy is 127.0.0.1:10808, on the `electron-updater` partition:
 *
 *   untouched        -> PROXY 127.0.0.1:10808
 *   mode: "direct"   -> DIRECT                    (do not do this by default)
 *   mode: "system"   -> PROXY 127.0.0.1:10808
 *
 * Deliberately NOT via `process.env`: that environment is inherited by the dsh
 * child process and every shell the agent spawns, so writing HTTPS_PROXY here
 * would reroute the whole agent runtime through a proxy the user configured
 * only for update downloads. The session proxy affects just this process.
 */
export function applyGithubProxy(proxy: string): void {
  const value = (proxy ?? "").trim();
  const config =
    value === ""
      ? { mode: "system" as const }
      : { proxyRules: /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}` };
  const updaterSession = session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false });
  void updaterSession
    .setProxy(config)
    .catch((error) => logger.warn(`failed to apply update proxy: ${String(error)}`));
}