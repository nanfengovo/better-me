import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";

const hooks = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://platform-auth-hub-fixture.invalid" });
(globalThis as any).window = dom;
(globalThis as any).document = dom.document;

const React = await import("react");
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { PlatformAuthHub } = await import("../src/components/atlas/PlatformAuthHub.tsx");

test("PlatformAuthHub renders 4 platforms and triggers actions", async () => {
  const originalFetch = global.fetch;
  const calls: any[] = [];
  global.fetch = async (url: any, init: any) => {
    calls.push({ url, init });
    if (init?.body) {
      const parsed = JSON.parse(init.body);
      if (parsed.action === "platform-auth") {
        return {
          ok: true,
          json: async () => ({
            running: true,
            port: 9222,
            platforms: {
              boss: {
                platformId: "boss",
                name: "BOSS直聘",
                status: "login_required",
                statusText: "正在登录页面，等待扫码或验证码",
                loginUrl: "https://www.zhipin.com/web/user/?intent=login",
              },
              liepin: {
                platformId: "liepin",
                name: "猎聘",
                status: "ready",
                statusText: "免密检索就绪 (登录可查看更多)",
                loginUrl: "https://passport.liepin.com/account/v1/toLogin",
              },
              "51job": {
                platformId: "51job",
                name: "前程无忧 51JOB",
                status: "ready",
                statusText: "免密全量检索已就绪",
                loginUrl: "https://login.51job.com/login.php",
              },
              linkedin: {
                platformId: "linkedin",
                name: "领英 (LinkedIn)",
                status: "guest",
                statusText: "免密访客检索中",
                loginUrl: "https://www.linkedin.com/login",
              },
            },
          }),
        } as any;
      }
      if (parsed.action === "open-platform-login") {
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as any;
      }
      if (parsed.action === "focus") {
        return {
          ok: true,
          json: async () => ({ success: true }),
        } as any;
      }
    }
    return { ok: true, json: async () => ({}) } as any;
  };

  try {
    let closed = false;
    let refreshed = false;
    dom.document.body.innerHTML = "<main></main>";
    const root = createRoot(dom.document.querySelector("main")! as unknown as Element);

    await act(async () => {
      root.render(
        h(PlatformAuthHub, {
          isOpen: true,
          onClose: () => {
            closed = true;
          },
          onRefreshSearch: () => {
            refreshed = true;
          },
        }),
      );
    });

    // Wait for async fetch to finish and state update
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (dom.document.body.textContent?.includes("BOSS直聘")) break;
    }

    const text = dom.document.body.textContent || "";
    assert.ok(text.includes("全网平台统一登录与会话接管中心"));
    assert.ok(text.includes("BOSS直聘"));
    assert.ok(text.includes("待登录"));
    assert.ok(text.includes("猎聘"));
    assert.ok(text.includes("免密可用"));
    assert.ok(text.includes("前程无忧 51JOB"));
    assert.ok(text.includes("领英 (LinkedIn)"));

    // Find and click "一键打开全部平台登录页（推荐）"
    const buttons = [...dom.document.querySelectorAll("button")];
    const openAllBtn = buttons.find((b) => b.textContent?.includes("一键打开全部平台登录页"));
    assert.ok(openAllBtn, "openAllBtn exists");

    await act(async () => {
      openAllBtn.click();
    });

    const openCalls = calls.filter((c) => c.init?.body?.includes("open-platform-login"));
    assert.ok(openCalls.length > 0, "open-platform-login called");

    // Switch to Cookie Bridge tab
    const bridgeTabBtn = buttons.find((b) => b.textContent?.includes("日常浏览器 Cookie 桥接"));
    assert.ok(bridgeTabBtn, "bridgeTabBtn exists");
    await act(async () => {
      bridgeTabBtn.click();
    });

    const bridgeText = dom.document.body.textContent || "";
    assert.ok(bridgeText.includes("书签脚本一键同步"));
    assert.ok(bridgeText.includes("Cookie-Editor JSON 导入"));
    assert.ok(bridgeText.includes("同步Cookie到BetterMe"));

    // Find textarea and import button
    const textarea = dom.document.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(textarea, "textarea exists");
    textarea.value = JSON.stringify([{ name: "wt2", value: "test-wt2-token", domain: ".zhipin.com" }]);
    await act(async () => {
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });

    const importBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.includes("一键注入 Cookie"));
    assert.ok(importBtn, "importBtn exists");

    await act(async () => {
      importBtn.click();
    });

    const bridgeCalls = calls.filter((c) => c.url?.includes("/api/jd/cookie-bridge"));
    assert.ok(bridgeCalls.length > 0, "cookie-bridge API called");

    // Click "完成"
    const doneBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "完成");
    assert.ok(doneBtn, "doneBtn exists");
    await act(async () => {
      doneBtn.click();
    });
    assert.equal(closed, true);

    // Click "我已完成登录，立即全网检索岗位"
    const searchBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.includes("我已完成登录"));
    assert.ok(searchBtn, "searchBtn exists");
    await act(async () => {
      searchBtn.click();
    });
    assert.equal(refreshed, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("PlatformAuthHub normalizes trailing slash in extension origin and surfaces desktop/bridge error details", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; body?: string }> = [];
  global.fetch = async (url: any, init: any) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: String(url), body });
    if (String(url).includes("/api/jd/real-chrome")) {
      return new Response(JSON.stringify({ running: false, port: 9222, platforms: {} }), { status: 200 });
    }
    if (String(url).includes("/api/jd/bridge-grant")) {
      return new Response(JSON.stringify({ token: "a".repeat(64), expiresAt: Date.now() + 60_000 }), { status: 200 });
    }
    if (String(url).includes("/api/jd/cookie-bridge")) {
      return new Response(
        JSON.stringify({ error: "host_browser_required", message: "此操作需要宿主机可交互的招聘浏览器。" }),
        { status: 501 },
      );
    }
    return new Response("{}", { status: 200 });
  };
  try {
    dom.document.body.innerHTML = "<main></main>";
    const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
    await act(async () => {
      root.render(h(PlatformAuthHub, { isOpen: true, onClose: () => {} }));
    });
    const bridgeTab = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes("日常浏览器 Cookie 桥接"))!;
    await act(async () => { bridgeTab.click(); });
    const input = dom.document.querySelector<HTMLInputElement>('input[placeholder*="chrome-extension"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "chrome-extension://abcdefghijklmnop/ ");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const grantBtn = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes("生成并复制单次同步授权"))!;
    await act(async () => { grantBtn.click(); });
    const grantCall = calls.find(c => c.url.includes("/api/jd/bridge-grant"));
    assert.ok(grantCall?.body);
    assert.equal(JSON.parse(grantCall.body).origin, "chrome-extension://abcdefghijklmnop");

    const textarea = dom.document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, JSON.stringify([{ name: "wt2", value: "x", domain: ".zhipin.com" }]));
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const importBtn = [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes("一键注入 Cookie"))!;
    await act(async () => { importBtn.click(); });
    assert.match(dom.document.body.textContent ?? "", /宿主机可交互的招聘浏览器/);
  } finally {
    global.fetch = originalFetch;
  }
});
