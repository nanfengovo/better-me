import { VERIFICATION_HOSTS_51JOB, VERIFICATION_RESOURCE_TYPES, MAX_VERIFICATION_REQUESTS, MAX_VERIFICATION_EVENTS, MAX_VERIFICATION_ELAPSED_MS, type VerificationResourceType, type VerificationNetworkSnapshot } from "../src/lib/jd-verification-network";

const HOSTS = new Set<string>(VERIFICATION_HOSTS_51JOB);
const TYPES = new Set<string>(VERIFICATION_RESOURCE_TYPES);
type RequestState = { id: number; response: boolean; ended: boolean };
const identity = (value: unknown): value is object => typeof value === "object" && value !== null;

/** Passive metadata only: callers retain network objects; this module never reads them. */
export function createVerificationNetworkRecorder(platform: unknown, options: { now?: () => number } = {}) {
  let closed = false;
  let tracked = new WeakMap<object, RequestState>();
  const requests: VerificationNetworkSnapshot["requests"] = [];
  const events: VerificationNetworkSnapshot["events"] = [];
  let truncated = false;
  let origin: number | undefined;
  let lastMs = 0;
  const now = options.now ?? (() => performance.now());
  const timestamp = () => {
    try {
      const value = now();
      if (typeof value === "number" && Number.isFinite(value)) {
        origin ??= value;
        const elapsed = Math.floor(value - origin);
        if (Number.isFinite(elapsed)) lastMs = Math.max(lastMs, Math.min(MAX_VERIFICATION_ELAPSED_MS, elapsed));
      }
    } catch { /* A diagnostic clock cannot interrupt its page. */ }
    return lastMs;
  };
  if (platform === "51JOB") timestamp();
  const append = (state: RequestState, phase: VerificationNetworkSnapshot["events"][number]["phase"], status?: number) => {
    if (events.length >= MAX_VERIFICATION_EVENTS) { truncated = true; return; }
    events.push({ requestId: state.id, phase, atMs: timestamp(), ...(status !== undefined ? { status } : {}) });
  };
  const known = (request: unknown) => !closed && platform === "51JOB" && identity(request) ? tracked.get(request) : undefined;
  return {
    request(request: unknown, input: unknown, type: unknown): void {
      if (closed || platform !== "51JOB" || !identity(request) || tracked.has(request) || typeof input !== "string" || typeof type !== "string" || !TYPES.has(type)) return;
      let url: URL;
      try { url = new URL(input); } catch { return; }
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !HOSTS.has(url.hostname)) return;
      if (requests.length >= MAX_VERIFICATION_REQUESTS || events.length >= MAX_VERIFICATION_EVENTS) { truncated = true; return; }
      const state: RequestState = { id: requests.length + 1, response: false, ended: false };
      tracked.set(request, state);
      requests.push({ id: state.id, host: url.hostname, type: type as VerificationResourceType });
      append(state, "request");
    },
    response(request: unknown, status: unknown): void {
      const state = known(request);
      if (!state || state.ended || state.response || typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return;
      state.response = true;
      append(state, "response", status);
    },
    finished(request: unknown): void {
      const state = known(request);
      if (!state || state.ended) return;
      state.ended = true;
      append(state, "finished");
    },
    failed(request: unknown): void {
      const state = known(request);
      if (!state || state.ended) return;
      state.ended = true;
      append(state, "failed");
    },
    snapshot(): VerificationNetworkSnapshot {
      return { requests: requests.map(item => ({ ...item })), events: events.map(item => ({ ...item })), truncated };
    },
    close(): void {
      closed = true;
      tracked = new WeakMap();
      requests.length = 0;
      events.length = 0;
      truncated = false;
      origin = undefined;
      lastMs = 0;
    },
  };
}
