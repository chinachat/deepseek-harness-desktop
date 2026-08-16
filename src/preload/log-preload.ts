import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dshLogs", {
  read: (): Promise<string> => ipcRenderer.invoke("logs:read"),
});