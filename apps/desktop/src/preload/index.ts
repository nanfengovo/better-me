import { contextBridge, ipcRenderer } from "electron";

export interface DesktopApi {
  isElectron: true;
  platform: string;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
  getAgentHostInfo: () => Promise<{ endpoint: string; token: string; port: number }>;
  toggleStarPrompterHud: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onThemeChange: (callback: (theme: "dark" | "light") => void) => () => void;
}

const desktopApi: DesktopApi = {
  isElectron: true,
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  getAgentHostInfo: () => ipcRenderer.invoke("desktop:get-agent-info"),
  toggleStarPrompterHud: () => ipcRenderer.invoke("desktop:toggle-hud"),
  openExternal: (url: string) => ipcRenderer.invoke("desktop:open-external", url),
  onThemeChange: (callback: (theme: "dark" | "light") => void) => {
    const listener = (_: any, theme: "dark" | "light") => callback(theme);
    ipcRenderer.on("desktop:theme-changed", listener);
    return () => ipcRenderer.removeListener("desktop:theme-changed", listener);
  },
};

// Expose via contextBridge safely
contextBridge.exposeInMainWorld("desktopApi", desktopApi);
contextBridge.exposeInMainWorld("__BETTER_ME_DESKTOP__", true);
