/**
 * checkpointer.ts — Initialize the LangGraph SQLite checkpointer.
 *
 * Checkpoint file is placed outside the repo, alongside jobs.sqlite,
 * so it survives repo cleans and is not accidentally committed.
 *
 * Default path: ~/Library/Application Support/BetterMe/agent/checkpoints.sqlite
 * Override with: --checkpoint-dir <path>  or  AGENT_CHECKPOINT_DIR env var
 *
 * The SqliteSaver from @langchain/langgraph/checkpoint/sqlite stores only:
 *   - thread_id, checkpoint_id, parent_checkpoint_id
 *   - serialized graph state (which, per our state schema, contains NO
 *     resume text, NO API keys — those are excluded by design)
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function resolveCheckpointPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env["AGENT_CHECKPOINT_DIR"];
  if (fromEnv) return path.join(fromEnv, "checkpoints.sqlite");

  // macOS default (matches jobs.sqlite location convention)
  const dataHome =
    process.env["HOME"]
      ? path.join(process.env["HOME"], "Library", "Application Support", "BetterMe", "agent")
      : path.join(os.homedir(), ".local", "share", "better-me", "agent");

  return path.join(dataHome, "checkpoints.sqlite");
}

export function createCheckpointer(dbPath: string): SqliteSaver {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return SqliteSaver.fromConnString(dbPath);
}
