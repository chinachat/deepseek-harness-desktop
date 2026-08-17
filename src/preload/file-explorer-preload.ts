import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dshDesktop", {
  fs: {
    list: (payload: unknown) => ipcRenderer.invoke("dsh-fs:list", payload),
    read: (payload: unknown) => ipcRenderer.invoke("dsh-fs:read", payload),
    drives: () => ipcRenderer.invoke("dsh-fs:drives"),
  },
  ui: {
    toggle: () => ipcRenderer.invoke("dsh-explorer:toggle"),
    setWidth: (px: number) => ipcRenderer.invoke("dsh-explorer:set-width", px),
    onState: (cb: (state: { collapsed: boolean; width: number }) => void) => {
      ipcRenderer.on("dsh-explorer:state", (_event, state) => cb(state));
    },
    onWorkspaceRoot: (cb: (root: string | null) => void) => {
      ipcRenderer.on("dsh-explorer:workspace-root", (_event, root) => cb(root));
    },
  },
});
