/// <reference types="vite/client" />

export interface DesktopBridgeApi {
  isElectron: true;
  platform: string;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
  getAgentHostInfo?: () => Promise<{ endpoint: string; token: string; port: number }>;
  toggleStarPrompterHud?: () => Promise<void>;
  openExternal?: (url: string) => Promise<void>;
  exportPdf?: (suggestedFilename?: string) => Promise<{ ok: boolean; cancelled?: boolean; filePath?: string; error?: string }>;
  armInventoryMicrophone?: () => Promise<boolean>;
  disarmInventoryMicrophone?: () => void;
  onThemeChange?: (callback: (theme: "dark" | "light") => void) => () => void;
}

declare global {
  interface Window {
    desktopApi?: DesktopBridgeApi;
    __BETTER_ME_DESKTOP__?: boolean;
  }
}

declare module "mammoth" {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}
