import fs from "node:fs/promises";
import path from "node:path";
import { nativeDefaults, type NativeId } from "../../src/native-tools/adapters.js";
import type { NativeProcessInput, NativeProcessRunner } from "../../src/native-tools/process.js";

export function nativeFrames(id: NativeId, text: string): string {
  const events = id === "codex" ? [{ type: "thread.started" }, { type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text } }, { type: "turn.completed" }]
    : id === "claude-code" ? [{ type: "system", subtype: "init", tools: [], mcp_servers: [], plugins: [] }, { type: "assistant", message: { content: [{ type: "text", text }] } }, { type: "result", subtype: "success", is_error: false, result: text }]
    : id === "gemini-cli" ? [{ type: "init" }, { type: "message", role: "user", content: "synthetic" }, { type: "message", role: "assistant", content: text, delta: true }, { type: "result", status: "success" }]
    : [{ type: "step_start" }, { type: "text", part: { text } }, { type: "step_finish", part: { reason: "stop" } }];
  return events.map(event => JSON.stringify(event)).join("\n") + "\n";
}
/** Synthetic process only. Production adapter/configuration/decoder are not mocked. */
export class FixtureNativeProcess implements NativeProcessRunner {
  isolated = true; executions: NativeProcessInput[] = []; text = '{"kind":"reply","text":"synthetic response"}';
  gate?: Promise<void>; deviceGate?: Promise<void>; deviceStarts = 0;
  claudeStarts = 0;
  async isolation() { return this.isolated; }
  async run(input: NativeProcessInput) {
    if (input.args.includes("--help")) return Object.values(nativeDefaults).flatMap(item => item.flags).join(" ");
    if (input.environment?.["BETTERME_NATIVE_API_KEY"] === "betterme-offline-preflight-only") { input.onOutput?.('{"type":"thread.started"}\n'); return ""; }
    if (input.args[0] === "auth" && input.args.includes("--claudeai")) {
      this.claudeStarts++;
      let resolveCode!: () => void;
      const submitted = new Promise<void>(resolve => { resolveCode = resolve; });
      input.onStdinReady?.(code => { if (code === "synthetic-code#synthetic-state\n") resolveCode(); });
      input.onControlOutput?.("https://claude.com/cai/oauth/authorize?response_type=code&code_challenge_method=S256&code_challenge=synthetic&state=synthetic-state&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\n");
      await Promise.race([submitted, new Promise<void>(resolve => { input.signal?.addEventListener("abort", () => resolve(), { once: true }); })]);
      if (this.deviceGate) await this.deviceGate;
      await fs.mkdir(path.join(input.directory, "claude"), { recursive: true });
      await fs.writeFile(path.join(input.directory, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-claude-native-access-token", refreshToken: "synthetic-claude-refresh-token", expiresAt: Date.now() + 3600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "pro" } }), { mode: 0o600 });
      return "";
    }
    if (input.args.includes("--device-auth")) {
      this.deviceStarts++;
      input.onControlOutput?.("https://auth.openai.com/codex/device\nABCD-EFGH\n");
      if (this.deviceGate) await this.deviceGate;
      // Simulate a misbehaving late process that deliberately ignores abort.
      await fs.mkdir(path.join(input.directory, "codex"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(input.directory, "codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-native-access-token", refresh_token: "synthetic-native-refresh-token" } }), { mode: 0o600 });
      return "";
    }
    this.executions.push(input); if (this.gate) await this.gate;
    const id: NativeId = input.args[0] === "exec" ? "codex" : input.args[0] === "run" ? "opencode" : input.args.includes("--print") ? "claude-code" : "gemini-cli";
    const result = nativeFrames(id, this.text); input.onOutput?.(result); return result;
  }
}
