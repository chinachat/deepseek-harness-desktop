import { app } from "electron";
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

export function getSettings(): AppSettings {
  if (cached) return cached;
  let value: AppSettings;
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    value = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    value = { ...DEFAULTS };
  }
  cached = value;
  return value;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
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
 * Apply the GitHub proxy to the current process environment so that
 * electron-updater (which uses Node's `https` via `proxy-from-env`) routes its
 * requests through it. Call before checking for updates.
 */
export function applyGithubProxy(proxy: string): void {
  const value = (proxy ?? "").trim();
  if (value === "") {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
  } else {
    // Normalize to a URL: accept `host:port` and `http://host:port` forms.
    const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
    process.env.HTTPS_PROXY = normalized;
    process.env.HTTP_PROXY = normalized;
    process.env.https_proxy = normalized;
    process.env.http_proxy = normalized;
  }
}