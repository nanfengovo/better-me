/** Bounded transport observations only. An HTTP response never means a challenge passed. */
export const VERIFICATION_HOSTS_51JOB = Object.freeze([
  "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com",
  "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com",
  "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com",
  "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com",
  "upload.captcha-pro-open.aliyuncs.com",
  "upload.captcha-pro-open-b.aliyuncs.com",
  "device.captcha-open.aliyuncs.com",
]);
export const VERIFICATION_RESOURCE_TYPES = Object.freeze(["document", "script", "stylesheet", "xhr", "fetch", "image", "font"] as const);
export const MAX_VERIFICATION_REQUESTS = 32;
export const MAX_VERIFICATION_EVENTS = 128;
export const MAX_VERIFICATION_ELAPSED_MS = 86_400_000;
export type VerificationResourceType = typeof VERIFICATION_RESOURCE_TYPES[number];
export type VerificationNetworkSnapshot = {
  requests: Array<{ id: number; host: string; type: VerificationResourceType }>;
  events: Array<{ requestId: number; phase: "request" | "response" | "finished" | "failed"; atMs: number; status?: number }>;
  truncated: boolean;
};

/** Rebuild a safe copy of an optional server diagnostic; discard every unlisted property. */
export function readVerificationNetworkSnapshot(input: unknown): VerificationNetworkSnapshot | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { requests, events, truncated } = input as Record<string, unknown>;
  if (!Array.isArray(requests) || requests.length > MAX_VERIFICATION_REQUESTS
    || !Array.isArray(events) || events.length > MAX_VERIFICATION_EVENTS || typeof truncated !== "boolean") return;
  const safeRequests: VerificationNetworkSnapshot["requests"] = [];
  for (const [index, item] of requests.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { id, host, type } = item as Record<string, unknown>;
    if (id !== index + 1 || typeof host !== "string" || !VERIFICATION_HOSTS_51JOB.includes(host)
      || !VERIFICATION_RESOURCE_TYPES.includes(type as VerificationResourceType)) return;
    safeRequests.push({ id, host, type: type as VerificationResourceType });
  }
  const states = new Map<number, { responded: boolean; ended: boolean }>();
  const safeEvents: VerificationNetworkSnapshot["events"] = [];
  let previousMs = 0;
  for (const item of events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { requestId, phase, atMs, status } = item as Record<string, unknown>;
    if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId < 1 || requestId > safeRequests.length
      || typeof atMs !== "number" || !Number.isInteger(atMs) || atMs < previousMs || atMs > MAX_VERIFICATION_ELAPSED_MS
      || (phase !== "request" && phase !== "response" && phase !== "finished" && phase !== "failed")) return;
    if (phase === "response"
      ? typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599
      : status !== undefined) return;
    let state = states.get(requestId);
    if (phase === "request") {
      if (state) return;
      state = { responded: false, ended: false };
      states.set(requestId, state);
    } else {
      if (!state || state.ended || (phase === "response" && state.responded)) return;
      if (phase === "response") state.responded = true;
      else state.ended = true;
    }
    previousMs = atMs;
    safeEvents.push({ requestId, phase, atMs, ...(typeof status === "number" ? { status } : {}) });
  }
  if (states.size !== safeRequests.length) return;
  return { requests: safeRequests, events: safeEvents, truncated };
}
