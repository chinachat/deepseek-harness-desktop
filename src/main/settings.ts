import { app, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export interface AppSettings {
  launchAtLogin: boolean;
  closeToTray: boolean;
  /** GitHub 代理地址,如 `http://127.0.0.1:7890`;留空表示直连。 */
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
 * Apply the GitHub proxy to the app's default session for update traffic.
 *
 * Deliberately NOT via `process.env`: that environment is inherited by the dsh
 * child process and every shell the agent spawns, so writing HTTPS_PROXY here
 * would reroute the whole agent runtime through a proxy the user configured
 * only for update downloads. The session proxy affects just this process.
 */
export function applyGithubProxy(proxy: string): void {
  const value = (proxy ?? "").trim();
  const rules = value === "" ? undefined : (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`);
  void session.defaultSession
    .setProxy(rules === undefined ? { mode: "direct" } : { proxyRules: rules })
    .catch((error) => logger.warn(`failed to apply update proxy: ${String(error)}`));
}