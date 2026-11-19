import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { configureJobBrowserProfileRoot } from "./jd-browser";
import { browserSessionManager } from "./jd-browser-session";
import { jdExtractionMiddleware } from "./jd-extractor";
import { configureDesktopChrome, stopDesktopChrome } from "./jd-real-chrome-launcher";

export function configureDesktopJdBridge(privateData: string) {
  configureJobBrowserProfileRoot(resolve(privateData, "recruitment-browser"));
  configureDesktopChrome(resolve(privateData, "recruitment-browser", "chrome", "profile"));
  const isWin = process.platform === "win32";
  browserSessionManager.configure({
    useNativeLiepin: isWin,
    useNativeBoss: isWin,
    useNative51Job: isWin,
  });
}

export function handleDesktopJdRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  return jdExtractionMiddleware(req, res, next);
}

export async function stopDesktopJdBrowser(): Promise<void> {
  const closed = await Promise.allSettled([browserSessionManager.stopBrowser("owned-only"), stopDesktopChrome()]);
  if (closed.some(result => result.status === "rejected")) throw new Error("recruitment_browser_shutdown_failed");
}
