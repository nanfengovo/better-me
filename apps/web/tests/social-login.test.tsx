import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window, type HTMLInputElement, type HTMLButtonElement, type Event as HappyEvent, type CustomEvent as HappyCustomEvent } from "happy-dom";
import { SOCIAL_PROVIDERS, type SocialLoginCatalog } from "@better-me/agent-contracts";
import { activatePrincipal, invalidateIdentity } from "../src/lib/identity";

const dom = new Window({ url: "http://social-login-fixture.invalid" });
const React = await import("react"), { act } = React;
const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Synthetic Alice" };
const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Synthetic Bob" };
const ready = (): SocialLoginCatalog => ({ casdoor: true, service: "ready", authorizeOrigin: "https://identity.example", unifiedLoginAvailable: true,
  message: "已有资料请先登录原账号，再关联登录方式。", channels: SOCIAL_PROVIDERS.map(({ id, label }) => ({ id, label, state: "available", canSignUp: true, message: "已配置" })) });
let catalog = ready(), methods = { localPassword: true, unifiedLinked: false };
let starts: Record<string, unknown>[] = [], navigations: string[] = [], redirect = "https://identity.example/authorize";
let waitStart: Promise<void> | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, FormData: dom.FormData,
  React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.split("/").at(-1);
    if (route === "providers") return Response.json(catalog);
    if (route === "account") return Response.json(methods);
    assert.equal(route, "start", "this test must never access a resume, job, model or unrelated route");
    starts.push(JSON.parse(String(init?.body))); await waitStart;
    return Response.json({ url: redirect });
  },
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.defineProperty(dom.location, "assign", { configurable: true, value: (url: string) => { navigations.push(url); } });
const { createRoot } = await import("react-dom/client");
const { CasdoorAccess } = await import("../src/components/CasdoorAccess");
after(() => {
  activatePrincipal(undefined); dom.happyDOM.abort();
  for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
});
async function mount(link = false) {
  starts = []; navigations = []; redirect = "https://identity.example/authorize"; waitStart = undefined;
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<React.StrictMode><CasdoorAccess link={link} /></React.StrictMode>));
  return { container, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("all configured direct platform buttons send only an allow-listed channel and preserve pending writes before navigation", async () => {
  for (const { id } of SOCIAL_PROVIDERS) {
    catalog = ready(); activatePrincipal(undefined);
    const page = await mount();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const listener = (event: HappyEvent) => { (event as HappyCustomEvent).detail.push(pending); };
    dom.addEventListener("betterme:before-sign-out", listener);
    try {
      assert.equal(page.container.querySelectorAll(".social-login-button").length, SOCIAL_PROVIDERS.length);
      await act(async () => page.container.querySelector<HTMLButtonElement>(`button[value="${id}"]`)!.click());
      assert.equal(starts.length, 0, "navigation waits for accepted writes");
      await act(async () => finish());
      assert.deepEqual(starts, [{ intent: "login", provider: id }]);
      assert.deepEqual(navigations, [redirect]);
      assert.equal(dom.localStorage.length, 0, "the login view stores no passwords or provider tokens");
    } finally { finish(); dom.removeEventListener("betterme:before-sign-out", listener); await page.close(); }
  }
});

test("an existing four-channel host response stays compatible and does not invent international buttons", async () => {
  activatePrincipal(undefined); catalog = ready();
  catalog.channels = catalog.channels.filter(channel => SOCIAL_PROVIDERS.find(provider => provider.id === channel.id)?.primary);
  const page = await mount();
  try {
    assert.equal(page.container.querySelectorAll(".social-login-button").length, 4);
    assert.equal(page.container.querySelector('button[value="microsoft"]'), null);
    assert.equal(page.container.querySelector('button[value="gitlab"]'), null);
    assert.equal(page.container.querySelector('button[value="discord"]'), null);
  } finally { await page.close(); }
});

test("a malformed duplicate-channel catalog fails closed before offering a login", async () => {
  activatePrincipal(undefined); catalog = ready(); catalog.channels[1] = catalog.channels[0]!;
  const page = await mount();
  try {
    assert.equal(page.container.querySelectorAll(".social-login-button").length, 0);
    assert.match(page.container.textContent ?? "", /暂时无法读取登录方式/);
    assert.equal(starts.length, 0);
  } finally { await page.close(); }
});

test("offline login hides unusable platform buttons, keeps local guidance and can recover", async () => {
  activatePrincipal(undefined); catalog = { ...ready(), service: "offline", unifiedLoginAvailable: false,
    channels: ready().channels.map(channel => ({ ...channel, state: "unavailable", message: "服务离线" })) };
  const page = await mount();
  try {
    const buttons = [...page.container.querySelectorAll<HTMLButtonElement>(".social-login-button")];
    assert.equal(buttons.length, 0); assert.match(page.container.textContent ?? "", /本机账号/);
    assert.equal(starts.length, 0);
    catalog = ready(); await act(async () => page.container.querySelector<HTMLButtonElement>(".social-login-refresh")!.click());
    assert.ok([...page.container.querySelectorAll<HTMLButtonElement>(".social-login-button")].every(button => !button.disabled));
  } finally { await page.close(); }
});

test("ordinary users only see enabled channels and never instructions to install Casdoor", async () => {
  activatePrincipal(undefined); catalog = ready();
  catalog.channels = catalog.channels.map(channel => channel.id === "github" ? channel : { ...channel, state: "not_configured" });
  const page = await mount();
  try {
    assert.equal(page.container.querySelectorAll(".social-login-button").length, 1);
    assert.equal(page.container.querySelector('button[value="wechat"]'), null);
    assert.doesNotMatch(page.container.textContent ?? "", /待开通|安装 Casdoor|ClientSecret/);
  } finally { await page.close(); }
});

test("binding requires a native-valid local password and identifies the actual submitted provider; password is cleared", async () => {
  activatePrincipal(alice); catalog = ready(); methods = { localPassword: true, unifiedLinked: false };
  const page = await mount(true);
  try {
    const button = page.container.querySelector<HTMLButtonElement>('button[value="github"]')!;
    await act(async () => button.click()); assert.equal(starts.length, 0, "the browser's required field cannot be skipped");
    const password = page.container.querySelector<HTMLInputElement>('input[name="localPassword"]')!; password.value = "synthetic-local-password";
    await act(async () => button.click());
    assert.deepEqual(starts, [{ intent: "link", provider: "github", password: "synthetic-local-password" }]);
    assert.equal(password.value, ""); assert.deepEqual(navigations, [redirect]);
  } finally { await page.close(); }
});

test("external-only accounts use management reauthentication, never an impossible local password form", async () => {
  activatePrincipal(alice); catalog = ready(); methods = { localPassword: false, unifiedLinked: true };
  const page = await mount(true);
  try {
    assert.equal(page.container.querySelector('input[type="password"]'), null);
    const button = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.includes("管理已绑定"))!;
    await act(async () => button.click()); assert.deepEqual(starts, [{ intent: "manage" }]);
  } finally { await page.close(); }
});

test("a locked login page can recover via social login but a later identity generation blocks old navigation", async () => {
  activatePrincipal(alice); invalidateIdentity(); catalog = ready();
  const page = await mount();
  try {
    await act(async () => page.container.querySelector<HTMLButtonElement>('button[value="google"]')!.click());
    assert.deepEqual(starts, [{ intent: "login", provider: "google" }]); assert.equal(navigations.length, 1);
  } finally { await page.close(); }
  activatePrincipal(undefined); const late = await mount(); let finish!: () => void;
  waitStart = new Promise<void>(resolve => { finish = resolve; });
  try {
    await act(async () => late.container.querySelector<HTMLButtonElement>('button[value="qq"]')!.click());
    activatePrincipal(bob); await act(async () => finish());
    assert.equal(navigations.length, 0); assert.match(late.container.textContent ?? "", /身份已失效/);
  } finally { finish(); await late.close(); }
});

test("an authorization URL outside the catalog's fixed origin never navigates", async () => {
  activatePrincipal(undefined); catalog = ready(); const page = await mount(); redirect = "https://attacker.invalid/steal";
  try {
    await act(async () => page.container.querySelector<HTMLButtonElement>('button[value="wechat"]')!.click());
    assert.equal(navigations.length, 0); assert.match(page.container.textContent ?? "", /登录地址未通过核对/);
  } finally { await page.close(); }
});
