import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { connectNativeCdp, type NativeTargetList } from "./jd-native-cdp";

export type RealChromeStatus = {
  running: boolean;
  port: number;
  message: string;
  binaryFound: boolean;
  binaryPath?: string;
};

export function findRealBrowserBinary(): string | undefined {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    return candidates.find((p) => fs.existsSync(p));
  }

  if (process.platform === "win32") {
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LocalAppData"] || "";
    const candidates = [
      path.join(progFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(progFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(progFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(progFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
    ];
    return candidates.find((p) => fs.existsSync(p));
  }

  // Linux candidates
  const linuxCandidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
  for (const bin of linuxCandidates) {
    try {
      const paths = (process.env.PATH || "").split(":");
      for (const p of paths) {
        const full = path.join(p, bin);
        if (fs.existsSync(full)) return full;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function checkCdpRunning(port = 9222): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getRealChromeStatus(port = 9222): Promise<RealChromeStatus> {
  const running = await checkCdpRunning(port);
  const binary = findRealBrowserBinary();
  return {
    running,
    port,
    binaryFound: Boolean(binary),
    binaryPath: binary,
    message: running
      ? `真实 Chrome 已就绪（正在监听调试端口 ${port}）`
      : binary
        ? `未启动独立调试浏览器，点击可一键启动接管（将开启端口 ${port}）`
        : "未在系统默认路径找到 Google Chrome 或 Edge 浏览器",
  };
}

export async function launchRealChromeCdp(port = 9222, targetUrl = "https://www.zhipin.com"): Promise<RealChromeStatus> {
  const isAlreadyRunning = await checkCdpRunning(port);
  const binary = findRealBrowserBinary();

  if (isAlreadyRunning) {
    // If already running, do NOT steal focus; keep it running in background
    return {
      running: true,
      port,
      binaryFound: Boolean(binary),
      binaryPath: binary,
      message: `真实 Chrome 已在后台就绪（调试端口 ${port}）。`,
    };
  }

  if (!binary) {
    return {
      running: false,
      port,
      binaryFound: false,
      message: "未在系统默认路径检测到 Google Chrome 或 Microsoft Edge 浏览器，请先安装 Chrome。",
    };
  }

  const profileDir = path.join(os.homedir(), ".betterme-chrome-profile");
  await fs.promises.mkdir(profileDir, { recursive: true });

  // Clean stale singleton files so Chrome does not abort or freeze on startup
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      await fs.promises.unlink(path.join(profileDir, f));
    } catch {
      // ignore if not present
    }
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--proxy-bypass-list=<-loopback>;*.zhipin.com;*.bosszhipin.com;*.51job.com;*.51jobcdn.com;*.liepin.com;*.liepin-pc.com;*.lagou.com;*.tianyancha.com;*.qcc.com;*.aiqicha.com",
    targetUrl,
  ];

  try {
    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    if (process.platform === "darwin") {
      setTimeout(() => {
        try {
          const script = 'tell application "Google Chrome" to activate';
          spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
        } catch {
          // ignore
        }
      }, 700);
    }
  } catch (error) {
    return {
      running: false,
      port,
      binaryFound: true,
      binaryPath: binary,
      message: `启动浏览器进程失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Poll up to 8 seconds for port to open
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 350));
    if (await checkCdpRunning(port)) {
      return {
        running: true,
        port,
        binaryFound: true,
        binaryPath: binary,
        message: `真实 Chrome 浏览器已成功启动（调试端口 ${port}），已建立防风控原生接管！`,
      };
    }
  }

  return {
    running: false,
    port,
    binaryFound: true,
    binaryPath: binary,
    message: "已启动浏览器窗口，正在等待端口就绪，系统正在持续连接…",
  };
}

export async function killRealChromeCdp(port = 9222): Promise<boolean> {
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      try {
        const output = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
        if (output) {
          for (const pidStr of output.split(/\s+/)) {
            const pid = Number(pidStr);
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, "SIGKILL"); } catch {}
            }
          }
        }
      } catch {
        // lsof exits with 1 if no process found
      }
    }
    const profileDir = path.join(os.homedir(), ".betterme-chrome-profile");
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        await fs.promises.unlink(path.join(profileDir, f));
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

export async function focusRealChromeWindow(port = 9222): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      // Instant macOS focus
      const script = 'tell application "Google Chrome" to activate';
      const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
      child.unref();
    }
    const cdp = await connectNativeCdp(port);
    try {
      const targets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 2500);
      const page = targets.targetInfos.find((t) => t.type === "page");
      if (page?.targetId) {
        await cdp.send("Target.activateTarget", { targetId: page.targetId }, undefined, 2000).catch(() => {});
      }
    } finally {
      cdp.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function openRealChromeTab(url: string, port = 9222): Promise<boolean> {
  try {
    const isRunning = await checkCdpRunning(port);
    if (!isRunning) {
      const res = await launchRealChromeCdp(port, url);
      return res.running;
    }
    if (process.platform === "darwin") {
      const script = 'tell application "Google Chrome" to activate';
      spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
    }
    const cdp = await connectNativeCdp(port);
    try {
      const created = await cdp.send<{ targetId?: string }>("Target.createTarget", { url }, undefined, 4000);
      if (created.targetId) {
        await cdp.send("Target.activateTarget", { targetId: created.targetId }, undefined, 2000).catch(() => {});
      }
    } finally {
      cdp.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function openRealChromeTabs(urls: string[], port = 9222): Promise<boolean> {
  try {
    if (!urls.length) return true;
    const isRunning = await checkCdpRunning(port);
    let targetUrls = urls;
    if (!isRunning) {
      await launchRealChromeCdp(port, targetUrls[0]);
      targetUrls = targetUrls.slice(1);
      // Wait a moment for CDP to be ready
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (process.platform === "darwin") {
      const script = 'tell application "Google Chrome" to activate';
      spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
    }
    if (!targetUrls.length) return true;
    const cdp = await connectNativeCdp(port);
    try {
      let lastTargetId: string | undefined;
      for (const u of targetUrls) {
        const created = await cdp.send<{ targetId?: string }>("Target.createTarget", { url: u }, undefined, 4000).catch(() => ({ targetId: undefined }));
        if (created.targetId) lastTargetId = created.targetId;
      }
      if (lastTargetId) {
        await cdp.send("Target.activateTarget", { targetId: lastTargetId }, undefined, 2000).catch(() => {});
      }
    } finally {
      cdp.close();
    }
    return true;
  } catch {
    return false;
  }
}

export type PlatformAuthItem = {
  platformId: "boss" | "liepin" | "51job" | "linkedin";
  name: string;
  status: "logged_in" | "login_required" | "ready" | "guest" | "unknown";
  statusText: string;
  loginUrl: string;
  cookieFound?: boolean;
  activeUrl?: string;
};

export type PlatformAuthOverview = {
  running: boolean;
  port: number;
  platforms: Record<"boss" | "liepin" | "51job" | "linkedin", PlatformAuthItem>;
};

export async function getPlatformAuthStatuses(port = 9222): Promise<PlatformAuthOverview> {
  const running = await checkCdpRunning(port);
  const defaultOverview: PlatformAuthOverview = {
    running,
    port,
    platforms: {
      boss: {
        platformId: "boss",
        name: "BOSS直聘",
        status: running ? "login_required" : "unknown",
        statusText: running ? "需微信扫码或短信登录" : "浏览器未运行",
        loginUrl: "https://www.zhipin.com/web/user/?intent=login",
      },
      liepin: {
        platformId: "liepin",
        name: "猎聘",
        status: running ? "ready" : "unknown",
        statusText: running ? "免密可用 / 登录更全" : "浏览器未运行",
        loginUrl: "https://passport.liepin.com/account/v1/toLogin",
      },
      "51job": {
        platformId: "51job",
        name: "前程无忧 51JOB",
        status: running ? "ready" : "unknown",
        statusText: running ? "免密检索已就绪" : "浏览器未运行",
        loginUrl: "https://login.51job.com/login.php",
      },
      linkedin: {
        platformId: "linkedin",
        name: "领英 (LinkedIn)",
        status: running ? "guest" : "unknown",
        statusText: running ? "免密访客检索中" : "浏览器未运行",
        loginUrl: "https://www.linkedin.com/login",
      },
    },
  };

  if (!running) return defaultOverview;

  try {
    const cdp = await connectNativeCdp(port);
    try {
      const targets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 3000);
      const pageTargets = (targets.targetInfos || []).filter((t) => t.type === "page" && Boolean(t.url));

      // Check BOSS
      const bossPage = pageTargets.find((t) => t.url?.includes("zhipin.com"));
      if (bossPage?.targetId) {
        defaultOverview.platforms.boss.activeUrl = bossPage.url;
        try {
          const attached = await cdp.send<{ sessionId?: string }>(
            "Target.attachToTarget",
            { targetId: bossPage.targetId, flatten: true },
            undefined,
            3000,
          );
          if (attached.sessionId) {
            const cookiesRes = await cdp.send<{ cookies?: Array<{ name: string; value: string }> }>(
              "Network.getCookies",
              { urls: ["https://www.zhipin.com"] },
              attached.sessionId,
              3000,
            );
            const cookies = cookiesRes.cookies || [];
            const hasWt2 = cookies.some((c) => c.name === "wt2" && c.value.trim().length > 10);
            if (hasWt2) {
              defaultOverview.platforms.boss.status = "logged_in";
              defaultOverview.platforms.boss.statusText = "已登录 (有效 Token)";
              defaultOverview.platforms.boss.cookieFound = true;
            } else if (bossPage.url?.includes("/web/user/") || bossPage.url?.includes("/login")) {
              defaultOverview.platforms.boss.status = "login_required";
              defaultOverview.platforms.boss.statusText = "正在登录页面，等待扫码或验证码";
            }
          }
        } catch {}
      }

      // Check Liepin
      const liepinPage = pageTargets.find((t) => t.url?.includes("liepin.com"));
      if (liepinPage?.targetId) {
        defaultOverview.platforms.liepin.activeUrl = liepinPage.url;
        try {
          const attached = await cdp.send<{ sessionId?: string }>(
            "Target.attachToTarget",
            { targetId: liepinPage.targetId, flatten: true },
            undefined,
            3000,
          );
          if (attached.sessionId) {
            const cookiesRes = await cdp.send<{ cookies?: Array<{ name: string; value: string }> }>(
              "Network.getCookies",
              { urls: ["https://www.liepin.com"] },
              attached.sessionId,
              3000,
            );
            const cookies = cookiesRes.cookies || [];
            const hasUser = cookies.some(
              (c) => (c.name === "lt_token" || c.name === "user_id") && c.value.trim().length > 3,
            );
            if (hasUser) {
              defaultOverview.platforms.liepin.status = "logged_in";
              defaultOverview.platforms.liepin.statusText = "已登录 (有效账号)";
              defaultOverview.platforms.liepin.cookieFound = true;
            } else if (liepinPage.url?.includes("passport.liepin.com")) {
              defaultOverview.platforms.liepin.status = "login_required";
              defaultOverview.platforms.liepin.statusText = "正在登录页面";
            } else {
              defaultOverview.platforms.liepin.status = "ready";
              defaultOverview.platforms.liepin.statusText = "免密检索就绪 (登录可查看更多)";
            }
          }
        } catch {}
      }

      // Check LinkedIn
      const linkedinPage = pageTargets.find((t) => t.url?.includes("linkedin.com"));
      if (linkedinPage?.targetId) {
        defaultOverview.platforms.linkedin.activeUrl = linkedinPage.url;
        try {
          const attached = await cdp.send<{ sessionId?: string }>(
            "Target.attachToTarget",
            { targetId: linkedinPage.targetId, flatten: true },
            undefined,
            3000,
          );
          if (attached.sessionId) {
            const cookiesRes = await cdp.send<{ cookies?: Array<{ name: string; value: string }> }>(
              "Network.getCookies",
              { urls: ["https://www.linkedin.com"] },
              attached.sessionId,
              3000,
            );
            const cookies = cookiesRes.cookies || [];
            const hasLiAt = cookies.some((c) => c.name === "li_at" && c.value.trim().length > 10);
            if (hasLiAt) {
              defaultOverview.platforms.linkedin.status = "logged_in";
              defaultOverview.platforms.linkedin.statusText = "已登录 (有效账号)";
              defaultOverview.platforms.linkedin.cookieFound = true;
            } else {
              defaultOverview.platforms.linkedin.status = "guest";
              defaultOverview.platforms.linkedin.statusText = "免密访客检索中";
            }
          }
        } catch {}
      }

      // 51job is always ready for live extraction
      defaultOverview.platforms["51job"].status = "ready";
      defaultOverview.platforms["51job"].statusText = "免密全量检索已就绪";
    } finally {
      cdp.close();
    }
  } catch {}

  return defaultOverview;
}

export async function openPlatformLoginTab(
  platform: "boss" | "liepin" | "51job" | "linkedin" | "all",
  port = 9222,
): Promise<boolean> {
  const loginUrls: Record<string, string> = {
    boss: "https://www.zhipin.com/web/user/?intent=login",
    liepin: "https://passport.liepin.com/account/v1/toLogin",
    "51job": "https://login.51job.com/login.php",
    linkedin: "https://www.linkedin.com/login",
  };

  if (platform === "all") {
    const urls = Object.values(loginUrls);
    return await openRealChromeTabs(urls, port);
  }

  const url = loginUrls[platform];
  if (!url) return false;
  return await openRealChromeTab(url, port);
}

export type CookieInputParam = {
  name?: string;
  key?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
  expirationDate?: number;
  url?: string;
};

export async function injectPlatformCookies(
  rawCookies: CookieInputParam[],
  options?: { defaultDomain?: string; port?: number },
): Promise<{ success: boolean; count: number; error?: string }> {
  const port = options?.port ?? 9222;
  if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
    return { success: false, count: 0, error: "未提供有效的 Cookie 列表" };
  }

  const isRunning = await checkCdpRunning(port);
  if (!isRunning) {
    return { success: false, count: 0, error: "独立 Chrome 接管窗口尚未启动（端口 9222 未开放）" };
  }

  try {
    const cdp = await connectNativeCdp(port);
    try {
      const targets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, 3000);
      let page = targets.targetInfos?.find((t) => t.type === "page");
      if (!page?.targetId) {
        const created = await cdp.send<{ targetId?: string }>("Target.createTarget", { url: "about:blank" }, undefined, 3000);
        if (created.targetId) {
          page = { targetId: created.targetId, type: "page", url: "about:blank" };
        }
      }
      if (!page?.targetId) {
        return { success: false, count: 0, error: "无法找到或创建浏览器页面目标" };
      }

      const attached = await cdp.send<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId: page.targetId, flatten: true },
        undefined,
        3000,
      );
      if (!attached.sessionId) {
        return { success: false, count: 0, error: "无法附着浏览器标签页调试会话" };
      }

      const sanitized: any[] = [];
      for (const item of rawCookies) {
        const name = String(item.name || item.key || "").trim();
        const value = typeof item.value === "string" ? item.value : item.value !== undefined ? String(item.value) : "";
        if (!name) continue;

        let domain = item.domain?.trim() || options?.defaultDomain?.trim();
        if (!domain) {
          if (name === "wt2" || name.startsWith("__zp_")) domain = ".zhipin.com";
          else if (name === "lt_token" || name === "user_id") domain = ".liepin.com";
          else if (name === "li_at") domain = ".linkedin.com";
          else domain = ".zhipin.com";
        }
        if (!domain.startsWith(".") && !domain.includes("/")) domain = `.${domain}`;

        let sameSite = item.sameSite;
        if (sameSite === "no_restriction" || sameSite === "None") sameSite = "None";
        else if (sameSite === "lax" || sameSite === "Lax") sameSite = "Lax";
        else if (sameSite === "strict" || sameSite === "Strict") sameSite = "Strict";
        else sameSite = undefined;

        let expires = typeof item.expires === "number" ? item.expires : typeof item.expirationDate === "number" ? item.expirationDate : undefined;
        if (expires && expires > 1e11) expires = Math.floor(expires / 1000);

        sanitized.push({
          name,
          value,
          domain,
          path: item.path?.trim() || "/",
          secure: Boolean(item.secure),
          httpOnly: Boolean(item.httpOnly),
          ...(sameSite ? { sameSite } : {}),
          ...(expires ? { expires } : {}),
        });
      }

      if (sanitized.length === 0) {
        return { success: false, count: 0, error: "提供的数据中未发现可识别的 Cookie 字段" };
      }

      await cdp.send("Network.enable", {}, attached.sessionId, 3000).catch(() => {});
      await cdp.send("Network.setCookies", { cookies: sanitized }, attached.sessionId, 5000);

      return { success: true, count: sanitized.length };
    } finally {
      cdp.close();
    }
  } catch (error) {
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : "CDP 写入 Cookie 失败",
    };
  }
}
