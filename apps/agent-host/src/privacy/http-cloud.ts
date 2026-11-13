import { CloudRuntimeBindingSchema, PrivacyError } from "./types.js";
import type { CloudPrivacyAdapter, CloudRuntimeBinding } from "./types.js";
import { privacyDigest } from "./content-guard.js";

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Shared byte-bounded JSON reader. Never exposes the HTTP error body. */
export async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new PrivacyError("privacy_http_failed"); }
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) { await response.body.cancel(); throw new PrivacyError("privacy_http_output_limit"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new PrivacyError("privacy_cancelled");
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new PrivacyError("privacy_http_output_limit");
      chunks.push(result.value);
    }
    if (signal.aborted) throw new PrivacyError("privacy_cancelled");
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new PrivacyError("privacy_http_invalid_json"); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Generic already-configured JSON reasoner endpoint, not an OpenAI adapter.
 * Host supplies any existing scoped credentials without giving them to models.
 * HTTP is available only for an explicitly enabled loopback test fixture. */
export function createJsonHttpCloudAdapter(options: {
  endpoint: string;
  recipientId: string;
  runtimeVersion?: string;
  model: string;
  maxResponseBytes?: number;
  allowLoopbackHttpFixture?: boolean;
  authorization?: () => Promise<string | undefined>;
}): CloudPrivacyAdapter {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { throw new PrivacyError("invalid_cloud_endpoint"); }
  const fixture = options.allowLoopbackHttpFixture === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !fixture) || (isLoopbackHost(url.hostname) && !fixture)) throw new PrivacyError("invalid_cloud_endpoint");
  const maxBytes = options.maxResponseBytes ?? 64_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000) throw new PrivacyError("invalid_cloud_response_limit");
  let binding: CloudRuntimeBinding;
  try {
    binding = CloudRuntimeBindingSchema.parse({ id: options.recipientId, version: options.runtimeVersion ?? "json-http-v1", location: "cloud", recipientOrigin: url.origin, endpointFingerprint: privacyDigest({ endpoint: url.href, protocol: "betterme.disclosure.v1", maxResponseBytes: maxBytes }), model: options.model });
  } catch { throw new PrivacyError("invalid_cloud_binding"); }
  return {
    binding: async () => structuredClone(binding),
    async dispatch(input, signal) {
      if (signal.aborted) throw new PrivacyError("privacy_cancelled");
      if (input.protocol !== "betterme.disclosure.v1" || input.model !== binding.model) throw new PrivacyError("cloud_envelope_binding_mismatch");
      try {
        const authorization = await options.authorization?.();
        if (signal.aborted) throw new PrivacyError("privacy_cancelled");
        const response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify(input), signal });
        return await readBoundedJson(response, maxBytes, signal);
      } catch (error) {
        if (error instanceof PrivacyError) throw error;
        throw new PrivacyError(signal.aborted ? "privacy_cancelled" : "cloud_transport_failed");
      }
    },
  };
}
