import { contextBridge, ipcRenderer } from "electron";

export interface SettingsState {
  launchAtLogin: boolean;
  closeToTray: boolean;
  githubProxy: string;
}

export interface UpdateStatePayload {
  phase: string;
  version?: string;
  percent?: number;
  bytesPerSecond?: number;
  message?: string;
}

contextBridge.exposeInMainWorld("dshSettings", {
  get: (): Promise<SettingsState> => ipcRenderer.invoke("settings:get"),
  set: (patch: Partial<SettingsState>): Promise<SettingsState> => ipcRenderer.invoke("settings:set", patch),
  updateState: (): Promise<UpdateStatePayload> => ipcRenderer.invoke("updater:state"),
  version: (): Promise<string> => ipcRenderer.invoke("updater:version"),
  checkUpdate: (): Promise<UpdateStatePayload> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke("updater:install"),
  onUpdateState: (cb: (state: UpdateStatePayload) => void): void => {
    ipcRenderer.on("updater:state-event", (_event, state) => cb(state));
  },
});
