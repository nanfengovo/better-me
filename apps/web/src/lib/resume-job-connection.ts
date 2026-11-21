import { readAtlasConnectionSession, type AtlasConnectionIdentity } from "../components/atlas/connection-session";
import { readAtlasDevAutoConnectSuppressed, requestDevJobIndex } from "../components/atlas/dev-index-bootstrap";
import { readRuntimeConnection } from "./runtime-connection";

/** Resolve just the job service session, without loading the map or exporting the index. */
export async function resolveResumeJobConnection(signal: AbortSignal, reconnect = false): Promise<AtlasConnectionIdentity | undefined> {
  signal.throwIfAborted();
  const session = readAtlasConnectionSession();
  if (!reconnect && readAtlasDevAutoConnectSuppressed()) return;
  if (session?.dataMode === "live") return session;
  if ((!reconnect && session) || !(import.meta.env?.DEV || readRuntimeConnection())) return;
  const response = await requestDevJobIndex(signal);
  signal.throwIfAborted();
  if (!response?.ok) throw new Error(response?.error || "岗位服务暂未就绪。");
  return response;
}
