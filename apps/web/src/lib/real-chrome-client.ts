export type RealChromeStatus = {
  running: boolean;
  port: number;
  message: string;
  binaryFound: boolean;
  binaryPath?: string;
};

export async function getRealChromeStatus(signal?: AbortSignal): Promise<RealChromeStatus> {
  try {
    const res = await fetch("/api/jd/real-chrome", { signal });
    if (!res.ok) throw new Error("获取真实浏览器状态失败");
    return (await res.json()) as RealChromeStatus;
  } catch (error) {
    return {
      running: false,
      port: 9222,
      binaryFound: false,
      message: error instanceof Error ? error.message : "无法连接本地浏览器状态服务",
    };
  }
}

export async function launchRealChrome(signal?: AbortSignal): Promise<RealChromeStatus> {
  const res = await fetch("/api/jd/real-chrome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "launch" }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "启动真实浏览器失败");
  }
  return (await res.json()) as RealChromeStatus;
}

export async function restartRealChrome(signal?: AbortSignal): Promise<RealChromeStatus> {
  const res = await fetch("/api/jd/real-chrome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "restart" }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "重启真实浏览器失败");
  }
  return (await res.json()) as RealChromeStatus;
}

export async function focusRealChrome(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/jd/real-chrome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "focus" }),
      signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export async function openUrlInRealChrome(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/jd/real-chrome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open-tab", url }),
      signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export async function openUrlsInRealChrome(urls: string[], signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/jd/real-chrome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open-tabs", urls }),
      signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
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

export async function getPlatformAuthOverview(signal?: AbortSignal): Promise<PlatformAuthOverview> {
  try {
    const res = await fetch("/api/jd/real-chrome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "platform-auth" }),
      signal,
    });
    if (!res.ok) throw new Error("获取平台会话状态失败");
    return (await res.json()) as PlatformAuthOverview;
  } catch {
    return {
      running: false,
      port: 9222,
      platforms: {
        boss: { platformId: "boss", name: "BOSS直聘", status: "unknown", statusText: "未连接", loginUrl: "https://www.zhipin.com/web/user/?intent=login" },
        liepin: { platformId: "liepin", name: "猎聘", status: "unknown", statusText: "未连接", loginUrl: "https://passport.liepin.com/account/v1/toLogin" },
        "51job": { platformId: "51job", name: "前程无忧 51JOB", status: "unknown", statusText: "未连接", loginUrl: "https://login.51job.com/login.php" },
        linkedin: { platformId: "linkedin", name: "领英 (LinkedIn)", status: "unknown", statusText: "未连接", loginUrl: "https://www.linkedin.com/login" },
      },
    };
  }
}

export async function openPlatformLogin(
  platform: "boss" | "liepin" | "51job" | "linkedin" | "all",
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch("/api/jd/real-chrome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open-platform-login", platform }),
      signal,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export async function bridgePlatformCookies(
  payload: { platform?: string; cookies: any[] | string },
  signal?: AbortSignal,
): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    const res = await fetch("/api/jd/cookie-bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    return (await res.json()) as { success: boolean; count: number; error?: string };
  } catch (error) {
    return {
      success: false,
      count: 0,
      error: error instanceof Error ? error.message : "连接 Cookie 桥接服务失败",
    };
  }
}

