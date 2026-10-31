/** Historical audit entrypoint. The original 7 failures are now formal CI regressions.
 * Run: node node_modules/tsx/dist/cli.mjs --test docs/research/fixtures/agent-permission-probe.ts
 */
import "../../../apps/agent-host/tests/agent-safety-regressions.test.ts";
