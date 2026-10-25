import assert from "node:assert/strict";
import test from "node:test";
import { waitForAutoBrowserJob, type AutoBrowserGatePage } from "../server/jd-extractor.ts";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors.ts";

const bossMobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/fixtureToken?fromSource=2";
const bossSecurity = `https://m.zhipin.com/web/passport/zp/security.html?callbackUrl=${encodeURIComponent(bossMobile)}&appName=boss_h5&code=37`;

type Frame = { url: string; content?: boolean; gate?: JdFailureCode };

function fakePage(frames: Frame[]) {
  let clock = 0;
  let index = 0;
  const frame = () => frames[Math.min(index, frames.length - 1)]!;
  const page: AutoBrowserGatePage = {
    url: () => frame().url,
    evaluate: async <T,>() => ({ content: frame().content ?? false, gate: frame().gate }) as T,
    waitForTimeout: async (ms: number) => { clock += ms; index += 1; },
  };
  return { page, now: () => clock, polls: () => index };
}

function isFailure(code: JdFailureCode) { return (error: unknown) => error instanceof JdExtractionError && error.failure.code === code; }

test("自动化浏览器遇到 BOSS 访问验证页时保持等待，用户完成验证后读取正文", async () => {
  const frames: Frame[] = [
    ...Array.from({ length: 40 }, () => ({ url: bossSecurity })),
    { url: bossMobile, content: true },
  ];
  const fake = fakePage(frames);
  await waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, pollMs: 1_000 });
  assert.equal(fake.polls(), 40, "等待超过原先 25 秒的内容超时，直到验证页离开");
});

test("页面文字显示人机验证时同样等待，而不是提前读取验证页", async () => {
  const fake = fakePage([
    ...Array.from({ length: 30 }, () => ({ url: bossMobile, gate: "verification_required" as const })),
    { url: bossMobile, content: true },
  ]);
  await waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, pollMs: 1_000 });
  assert.equal(fake.polls(), 30);
});

test("用户未在时限内完成验证时返回 verification_required，而不是泛化的正文缺失提示", async () => {
  const fake = fakePage([{ url: bossSecurity }]);
  await assert.rejects(
    waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, pollMs: 1_000, humanTimeoutMs: 10_000 }),
    (error: unknown) => isFailure("verification_required")(error) && /安全验证/.test((error as JdExtractionError).failure.message),
  );
});

test("登录提示超时返回 login_required", async () => {
  const fake = fakePage([{ url: bossMobile, gate: "login_required" }]);
  await assert.rejects(waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, humanTimeoutMs: 5_000 }), isFailure("login_required"));
});

test("没有门禁也没有正文时按内容超时返回，交由正文提取给出原有错误", async () => {
  const fake = fakePage([{ url: bossMobile }]);
  await waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, pollMs: 1_000, contentTimeoutMs: 5_000 });
  assert.equal(fake.polls(), 5);
});

test("页面仍在跳转时重新计算内容等待，避免慢速跳转链被提前截断", async () => {
  const fake = fakePage([
    ...Array.from({ length: 4 }, () => ({ url: bossMobile })),
    ...Array.from({ length: 4 }, () => ({ url: `${bossMobile}&_security_check=1` })),
    { url: `${bossMobile}&_security_check=1`, content: true },
  ]);
  await waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, pollMs: 1_000, contentTimeoutMs: 5_000 });
  assert.equal(fake.polls(), 8);
});

test("正文已渲染时立即返回；验证 URL 上的同名选择器不算正文", async () => {
  const ready = fakePage([{ url: bossMobile, content: true }]);
  await waitForAutoBrowserJob(ready.page, "BOSS直聘", { now: ready.now });
  assert.equal(ready.polls(), 0);
  const fake = fakePage([{ url: bossSecurity, content: true }, { url: bossMobile, content: true }]);
  await waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now });
  assert.equal(fake.polls(), 1);
});

test("取消请求时停止等待", async () => {
  const controller = new AbortController();
  const fake = fakePage([{ url: bossSecurity }]);
  const original = fake.page.waitForTimeout;
  fake.page.waitForTimeout = async (ms) => { await original(ms); controller.abort(new DOMException("cancel", "AbortError")); };
  await assert.rejects(waitForAutoBrowserJob(fake.page, "BOSS直聘", { now: fake.now, signal: controller.signal }), { name: "AbortError" });
});
