import { contextBridge } from "electron";

/**
 * The dsh web UI needs no host bridge any more: it uploads attachments and picks
 * workspace directories natively, so this preload only reports runtime facts.
 */
contextBridge.exposeInMainWorld("dshDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
