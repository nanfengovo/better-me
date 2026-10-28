/** Opt-in UI fixture. Never forwards a request to a real local Agent service. */
export function installCompanionFixture() {
  const original = window.fetch.bind(window);
  const calls: Array<{ path: string; method: string }> = [];
  const runtimes = [
    { id: "claude-code", name: "Claude Code" }, { id: "opencode", name: "OpenCode" },
    { id: "gemini-cli", name: "Gemini CLI" }, { id: "codex", name: "Codex" },
  ].map(runtime => ({ ...runtime, status: "available", version: "Synthetic UI fixture", capabilities: ["text"] }));
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin === "http://127.0.0.1:5179") {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      calls.push({ path: url.pathname, method });
      if (url.pathname === "/api/v1/agent/runtimes" && method === "GET") return Response.json({ runtimes });
      return Response.json({ error: "isolated-artwork-fixture-disables-cli-and-ai" }, { status: 403 });
    }
    return original(input,init);
  };
  Object.assign(window,{__companionFixture:{calls,description:"Synthetic runtimes; all Agent writes fail closed; no real service connection."}});
}
