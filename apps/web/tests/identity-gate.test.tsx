import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";
import { Window, type HTMLInputElement } from "happy-dom";
import { activatePrincipal, captureIdentity, currentPrincipal, IdentityBoundaryError } from "../src/lib/identity";

const css = registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
} });
const dom = new Window({ url: "http://identity-gate-fixture.invalid" });
const React = await import("react");
const alice = { id: "11111111-1111-4111-8111-111111111111", username: "alice", displayName: "Synthetic Alice" };
const bob = { id: "22222222-2222-4222-8222-222222222222", username: "bob", displayName: "Synthetic Bob" };
let session: typeof alice | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, FormData: dom.FormData,
  React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async (input: RequestInfo | URL) => {
    const route = new URL(String(input)).pathname.split("/").at(-1);
    if (route === "providers") return Response.json({ casdoor: false });
    if (route === "register") session = alice;
    else assert.equal(route, "session", "this fixture must not send data or execute a model");
    return Response.json({ principal: session ?? null });
  },
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { act } = React;
const { IdentityGate } = await import("../src/components/IdentityGate");
const { WorkspaceBoot } = await import("../src/components/WorkspaceBoot");

test("boot finishes automatically and respects system reduced motion", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  let finished = 0;
  const complete = () => { finished++; };
  const originalMatch = dom.matchMedia.bind(dom);
  try {
    await act(async () => root.render(<WorkspaceBoot onComplete={complete} />));
    assert.equal(finished, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1850)); });
    assert.equal(finished, 1, "animation never blocks the workspace indefinitely");
    await act(async () => root.render(null));
    dom.matchMedia = ((query: string) => {
      const media = originalMatch(query);
      Object.defineProperty(media, "matches", { value: true });
      return media;
    }) as typeof dom.matchMedia;
    await act(async () => root.render(<WorkspaceBoot onComplete={complete} />));
    assert.equal(finished, 2, "reduced motion skips immediately");
  } finally {
    dom.matchMedia = originalMatch;
    await act(async () => root.unmount()); container.remove();
  }
});
after(() => {
  activatePrincipal(undefined); css.deregister(); dom.happyDOM.abort();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  }
});

test("login showcase switches scenes, pauses motion and password visibility resets when changing mode", async () => {
  session = undefined; activatePrincipal(undefined);
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === name || item.textContent === name)!;
  try {
    await act(async () => root.render(<IdentityGate><span>private</span></IdentityGate>));
    await act(async () => button("Agent 协作").click());
    assert.match(container.querySelector(".login-floating-card")!.textContent, /你决定方向，Agent 协助推进/);
    assert.equal(button("Agent 协作").getAttribute("aria-pressed"), "true");
    await act(async () => button("暂停展示动效").click());
    assert.ok(container.querySelector(".login-showcase.is-paused"));
    const password = container.querySelector<HTMLInputElement>('[name="password"]')!;
    password.value = "synthetic-password-only";
    await act(async () => button("显示密码").click());
    assert.equal(password.type, "text"); assert.equal(password.value, "synthetic-password-only");
    await act(async () => button("首次使用？创建本机账号").click());
    assert.equal(container.querySelector<HTMLInputElement>('[name="password"]')!.type, "password");
    assert.ok(container.querySelector('[name="displayName"]'));
    assert.equal(currentPrincipal(), undefined, "visual interactions do not authenticate or create an account");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("a newly registered account locks with a sign-in form, preserving its mounted draft and invalidating its old lease", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<IdentityGate><input aria-label="Synthetic mounted draft" defaultValue="ALICE-ONLY draft" /></IdentityGate>));
    const create = [...dom.document.querySelectorAll("button")].find(button => button.textContent === "首次使用？创建本机账号");
    assert.ok(create); await act(async () => create.click());
    for (const [name, value] of Object.entries({ username: "alice", password: "synthetic-only-password-2026", displayName: "Synthetic Alice" })) {
      const field = dom.document.querySelector<HTMLInputElement>(`input[name="${name}"]`); assert.ok(field); field.value = value;
    }
    await act(async () => { dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(currentPrincipal()?.id, alice.id);
    assert.ok(container.querySelector('.workspace-boot[role="dialog"]'), "boot starts only after verified authentication");
    assert.ok(container.querySelector('[aria-label="Synthetic mounted draft"]')?.parentElement?.hasAttribute("inert"));
    await act(async () => container.querySelector<HTMLButtonElement>(".workspace-boot > button")!.click());
    assert.equal(container.querySelector(".workspace-boot"), null, "skip immediately releases the workspace");
    assert.equal(container.querySelector('[aria-label="Synthetic mounted draft"]')?.parentElement?.hasAttribute("inert"), false);
    const lease = captureIdentity();
    const draft = dom.document.querySelector<HTMLInputElement>('[aria-label="Synthetic mounted draft"]'); assert.ok(draft);
    draft.value = "ALICE-ONLY unsent correction";
    session = bob;
    await act(async () => { dom.dispatchEvent(new dom.Event("focus")); });
    assert.match(dom.document.querySelector("h1")?.textContent ?? "", /重新连接你的工作空间/);
    assert.equal(dom.document.querySelector('[name="displayName"]') === null, true, "a locked registered user must be offered sign-in, not a second registration");
    assert.equal(dom.document.querySelector('button[type="submit"]')?.textContent, "登录");
    assert.ok(dom.document.querySelector('[aria-label="Synthetic mounted draft"]') === draft);
    assert.equal(draft.value, "ALICE-ONLY unsent correction");
    assert.ok(draft.parentElement?.hasAttribute("hidden"));
    assert.ok(draft.parentElement?.hasAttribute("inert"));
    assert.equal(currentPrincipal()?.id, alice.id, "the old mounted App must retain its own storage scope");
    assert.throws(lease, IdentityBoundaryError);
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
