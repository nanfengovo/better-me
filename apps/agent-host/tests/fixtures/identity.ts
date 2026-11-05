import assert from "node:assert/strict";
/** Real registration/session authentication, isolated fixture data only; no auth bypass. */
export async function registerTestIdentity(origin: string, token: string, username = "fixture-user", site?: string) {
  const response = await fetch(`${origin}/api/v1/agent/identity/register`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(site ? { Origin: site } : {}) },
    body: JSON.stringify({ username, password: "synthetic-only-password-2026", displayName: username }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
  return { principal: payload.principal as { id: string; username: string; displayName: string }, cookie,
    headers: { Cookie: cookie, "X-BetterMe-Owner": payload.principal.id as string } };
}
