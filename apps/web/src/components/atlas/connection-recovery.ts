import { AtlasClientError } from "./client-error";

/** A bad token, malformed snapshot or size budget cannot be healed by restarting the service. */
export function shouldAutoReconnectAtlas(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (error instanceof TypeError) return true;
  return error instanceof AtlasClientError && error.code === "http-error"
    && /返回 5\d\d/.test(error.message);
}
