import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { SocialLoginCatalogSchema } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { ensureBuiltinOrConfiguredOidc } from "../src/identity/builtin-idp.js";

test("built-in zero-install OIDC broker enables WeChat, QQ, GitHub, Google and unified login without external Casdoor", async (t) => {
  const frontend = "http://localhost:5173";
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-builtin-idp-"));
  const { oidc, builtinHandle } = await ensureBuiltinOrConfiguredOidc({
    storageDir: path.join(directory, "builtin-idp"),
    primaryOrigin: frontend,
  });
  assert.ok(oidc);
  assert.ok(builtinHandle);

  const server = createAgentServer({
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: [frontend],
    authToken: "fixture",
    identityDirectory: path.join(directory, "identities"),
    checkpointer: new MemorySaver() as never,
    runtimeDefinitions: [],
    oidc,
  });

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await builtinHandle.close();
    await rm(directory, { recursive: true, force: true });
  });

  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const call = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/v1/agent/identity/${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer fixture",
        Origin: frontend,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    });

  const catalogRes = await call("providers");
  assert.equal(catalogRes.status, 200);
  const catalog = SocialLoginCatalogSchema.parse(await catalogRes.json());
  assert.equal(catalog.service, "ready");
  assert.equal(catalog.unifiedLoginAvailable, true);
  assert.deepEqual(
    catalog.channels.map((ch) => [ch.id, ch.state]),
    [
      ["wechat", "available"],
      ["qq", "available"],
      ["github", "available"],
      ["google", "available"],
    ]
  );

  for (const provider of ["wechat", "qq", "github", "google"] as const) {
    const startRes = await call("oidc/start", { intent: "login", provider });
    assert.equal(startRes.status, 200);
    const { url } = (await startRes.json()) as { url: string };
    const browserCookie = startRes.headers.getSetCookie()[0]!.split(";")[0]!;
    const authPageRes = await fetch(url, { redirect: "manual" });
    assert.equal(authPageRes.status, 200);
    const html = await authPageRes.text();
    const flowMatch = html.match(/name="flow"\s+value="([^"]+)"/);
    assert.ok(flowMatch?.[1], `expected flow input in authorize page for ${provider}`);

    const completeRes = await fetch(new URL("/authorize/complete", builtinHandle.issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        flow: flowMatch[1],
        provider,
        handle: `${provider}_user_01`,
        displayName: `${provider.toUpperCase()} User`,
      }),
      redirect: "manual",
    });
    assert.equal(completeRes.status, 303);
    const redirectLocation = new URL(completeRes.headers.get("location")!);
    const callbackRes = await fetch(`${origin}${redirectLocation.pathname}${redirectLocation.search}`, {
      headers: { Cookie: browserCookie },
      redirect: "manual",
    });
    assert.equal(callbackRes.status, 303);
    const sessionCookie = callbackRes.headers
      .getSetCookie()
      .find((item) => item.startsWith("betterme_session="))!
      .split(";")[0]!;
    const sessionRes = await call("session", undefined, { Cookie: sessionCookie });
    const sessionJson = (await sessionRes.json()) as { principal: { id: string; displayName: string } | null };
    assert.ok(sessionJson.principal?.id);
  }
});
