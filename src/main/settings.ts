import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export interface AppSettings {
  launchAtLogin: boolean;
  closeToTray: boolean;
}

const DEFAULTS: AppSettings = {
  launchAtLogin: false,
  closeToTray: true,
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