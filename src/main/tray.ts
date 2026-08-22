import { Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import type { ServerStatus } from "./dsh-server";
import type { AppSettings } from "./settings";

export interface TrayState {
  tray: Tray;
  updateStatus: (status: ServerStatus, url?: string) => void;
  refreshSettings: (settings: AppSettings) => void;
}

export interface TrayActions {
  onOpen: () => void;
  onLogs: () => void;
  onSettings: () => void;
  onRestart: () => void;
  onQuit: () => void;
  getSettings: () => AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => AppSettings;
}

const STATUS_LABEL: Record<ServerStatus, string> = {
  starting: "正在启动服务…",
  running: "服务运行中",
  stopped: "服务已停止",
  error: "服务异常",
};

export function createTray(actions: TrayActions): TrayState {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", "tray.png"));
  const tray = new Tray(icon);
  tray.setToolTip("DeepSeek Harness");

  const statusItem = {
    label: STATUS_LABEL.starting,
    enabled: false,
  };

  const settings = actions.getSettings();
  const loginItem = {
    label: "开机自动启动",
    type: "checkbox" as const,
    checked: settings.launchAtLogin,
    click: (item: Electron.MenuItem) => {
      actions.updateSettings({ launchAtLogin: item.checked });
    },
  };
  const closeToTrayItem = {
    label: "关闭窗口时最小化到托盘",
    type: "checkbox" as const,
    checked: settings.closeToTray,
    click: (item: Electron.MenuItem) => {
      actions.updateSettings({ closeToTray: item.checked });
    },
  };

  const buildMenu = (): Menu => {
    return Menu.buildFromTemplate([
      statusItem,
      { type: "separator" },
      { label: "显示主窗口", click: () => actions.onOpen() },
      { label: "查看日志", click: () => actions.onLogs() },
      { label: "重启服务", click: () => actions.onRestart() },
      { type: "separator" },
      {
        label: "设置…",
        click: () => actions.onSettings(),
      },
      {
        label: "偏好设置",
        submenu: [loginItem, closeToTrayItem],
      },
      { type: "separator" },
      { label: "退出", click: () => actions.onQuit() },
    ]);
  };

  tray.setContextMenu(buildMenu());

  tray.on("double-click", () => actions.onOpen());

  return {
    tray,
    updateStatus: (status: ServerStatus, url?: string) => {
      statusItem.label = url ? `${STATUS_LABEL[status]} (${url})` : STATUS_LABEL[status];
      tray.setContextMenu(buildMenu());
      tray.setToolTip(url ? `DeepSeek Harness\n${url}` : "DeepSeek Harness");
    },
    refreshSettings: (next: AppSettings) => {
      loginItem.checked = next.launchAtLogin;
      closeToTrayItem.checked = next.closeToTray;
      tray.setContextMenu(buildMenu());
    },
  };
}