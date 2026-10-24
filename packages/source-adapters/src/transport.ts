import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ToolError, type SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterContext, SourceTransport } from './contracts.js';

export type DnsAddress = { address: string; family: 4 | 6 };
export type DnsResolver = (hostname: string, context?: SourceAdapterContext, signal?: AbortSignal) => Promise<readonly DnsAddress[]>;
export type TransportErrorCode = 'unsafe-endpoint' | 'rate-limited' | 'http-error' | 'response-too-large' | 'invalid-response' | 'timeout' | 'cancelled';
export class SourceTransportError extends Error {
  constructor(
    public readonly code: TransportErrorCode,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) { super(`Source transport ${code}.`); this.name = 'SourceTransportError'; }
}

/** A sender receives only a validated URL and a pinned DNS answer; it must not resolve again. */
export type PinnedSendRequest = {
  url: URL;
  address: DnsAddress;
  method?: "GET" | "POST";
  body?: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
};
export type PinnedResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
};
export type PinnedSender = (request: PinnedSendRequest) => Promise<PinnedResponse>;
export type ControlledTransportOptions = {
  resolve?: DnsResolver;
  send?: PinnedSender;
  maxResponseBytes?: number;
  timeoutMs?: number;
  now?: () => number;
};

function ipv4Parts(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split('.').map(Number);
}

function ipv6Words(address: string): number[] | undefined {
  if (isIP(address) !== 6 || address.includes('%')) return undefined;
  let expanded = address.toLowerCase();
  if (expanded.includes('.')) {
    const split = expanded.lastIndexOf(':');
    const four = ipv4Parts(expanded.slice(split + 1));
    if (!four) return undefined;
    expanded = `${expanded.slice(0, split)}:${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`;
  }
  const halves = expanded.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':').map((word) => Number.parseInt(word, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map((word) => Number.parseInt(word, 16)) : [];
  const missing = 8 - left.length - right.length;
  const words = halves.length === 2 ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : left;
  return words.length === 8 ? words : undefined;
}

/** Conservative global-unicast policy: no loopback, metadata, private, transition or documentation ranges. */
export function isPublicAddress(address: string): boolean {
  const parts = ipv4Parts(address);
  if (parts) {
    const [a, b, c] = parts as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || address === '168.63.129.16'
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const words = ipv6Words(address);
  if (!words) return false;
  // Only 2000::/3 global unicast; exclude Teredo, benchmarking, ORCHID, documentation and 6to4.
  if ((words[0]! & 0xe000) !== 0x2000 || words[0] === 0x2002) return false;
  if (words[0] === 0x2001 && (words[1]! < 0x0200 || words[1] === 0x0db8)) return false;
  if (words[0] === 0x3fff && (words[1]! & 0xf000) === 0) return false;
  return true;
}

function checkedUrl(value: string, source: SourceDefinition): URL {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim() || value.includes('\\') || Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    throw new SourceTransportError('unsafe-endpoint');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceTransportError('unsafe-endpoint'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|lan|invalid|test)$/.test(host) || host.endsWith('.home.arpa')
    || !source.endpointPolicy.allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    throw new SourceTransportError('unsafe-endpoint');
  }
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new SourceTransportError('unsafe-endpoint'); }
  if (pathname.includes('\\') || Array.from(pathname).some((character) => character.charCodeAt(0) < 32) || pathname.includes('%') || !source.endpointPolicy.allowedPathPrefixes.some((prefix) =>
    pathname === prefix || (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname.startsWith(`${prefix}/`)))) {
    throw new SourceTransportError('unsafe-endpoint');
  }
  return url;
}

const nodeSender: PinnedSender = ({ url, address, method = "GET", body, headers, signal }) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
    method, headers, signal, agent: false, family: address.family,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
  }, (response) => {
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) {
      responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    resolve({ status: response.statusCode ?? 0, headers: responseHeaders, body: response, close: () => response.destroy() });
  });
  request.once('error', reject);
  request.end(body);
});

function retryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    return Number.isSafeInteger(seconds) ? Math.min(seconds, 31_536_000) : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(31_536_000, Math.ceil((date - now) / 1000))) : undefined;
}

/** GET-only transport with per-hop endpoint/DNS checks and a pinned public address. No cookie jar. */
export function createControlledSourceTransport(options: ControlledTransportOptions = {}): SourceTransport {
  const resolve = options.resolve ?? (async (hostname: string) => {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  });
  const send = options.send ?? nodeSender;
  const now = options.now ?? Date.now;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requestWindows = new Map<string, number[]>();
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new SourceTransportError('invalid-response');
  return {
    async request({ url: initialUrl, source, context, headers: suppliedHeaders, method: requestedMethod, jsonBody }) {
      context.throwIfCancelled();
      const method = requestedMethod ?? "GET";
      if (method !== "GET" && method !== "POST") throw new SourceTransportError('unsafe-endpoint');
      if (method === "POST" && (source.adapterId !== "workday-cxs" || source.adapterVersion !== "1")) throw new SourceTransportError('unsafe-endpoint');
      if (method === "GET" && jsonBody !== undefined || method === "POST" && (typeof jsonBody !== "string" || Buffer.byteLength(jsonBody, "utf8") > 32_768)) {
        throw new SourceTransportError('unsafe-endpoint');
      }
      if (method === "POST") {
        let body: unknown;
        try { body = JSON.parse(jsonBody!); } catch { throw new SourceTransportError('invalid-response'); }
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new SourceTransportError('unsafe-endpoint');
      }
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) controller.abort();
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(timeoutMs, context.budget.timeoutMs));
      const aborted = new Promise<never>((_accept, reject) => {
        controller.signal.addEventListener('abort', () => reject(new SourceTransportError(timedOut ? 'timeout' : 'cancelled')), { once: true });
        if (controller.signal.aborted) reject(new SourceTransportError(timedOut ? 'timeout' : 'cancelled'));
      });
      // Avoid an unhandled rejection when an injected resolver/sender fails synchronously.
      void aborted.catch(() => undefined);
      let activeResponse: PinnedResponse | undefined;
      const waitForRateSlot = async (hostname: string) => {
        const key = `${source.sourceId}\u0000${hostname}`;
        while (true) {
          context.throwIfCancelled();
          const timestamp = now();
          const prior = (requestWindows.get(key) ?? []).filter((value) => timestamp - value < 60_000);
          if (prior.length < source.refreshPolicy.requestsPerMinute) {
            prior.push(timestamp);
            requestWindows.set(key, prior);
            return;
          }
          const delay = Math.max(1, 60_000 - (timestamp - prior[0]!));
          await new Promise<void>((accept, reject) => {
            const stop = () => { clearTimeout(timer); reject(new SourceTransportError(timedOut ? 'timeout' : 'cancelled')); };
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); accept(); }, delay);
            controller.signal.addEventListener('abort', stop, { once: true });
            if (controller.signal.aborted) stop();
          });
        }
      };
      try {
        const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'BetterMe-JobSources/0.1 (local personal career workstation)',
          ...(method === "POST" ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(jsonBody!, "utf8")) } : {}) };
        for (const [key, value] of Object.entries(suppliedHeaders ?? {})) {
          const name = key.toLowerCase();
          if (!['accept', 'if-none-match', 'if-modified-since'].includes(name) || typeof value !== 'string' || value.length > 1000 || Array.from(value).some((character) => [0, 10, 13].includes(character.charCodeAt(0)))) {
            throw new SourceTransportError('unsafe-endpoint');
          }
          headers[name] = value;
        }
        if (suppliedHeaders && Object.keys(suppliedHeaders).some(key => ["content-type", "content-length"].includes(key.toLowerCase()))) throw new SourceTransportError("unsafe-endpoint");
        let currentUrl = initialUrl;
        for (let redirects = 0; ; redirects++) {
          context.throwIfCancelled();
          const parsedUrl = checkedUrl(currentUrl, source);
          const addresses = await Promise.race([resolve(parsedUrl.hostname, context, controller.signal), aborted]);
          if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) {
            throw new SourceTransportError('unsafe-endpoint');
          }
          context.throwIfCancelled();
          await waitForRateSlot(parsedUrl.hostname);
          context.consumeRequests(1);
          const pendingResponse = send({ url: parsedUrl, address: addresses[0]!, ...(method === "POST" ? { method, body: jsonBody } : {}), headers, signal: controller.signal }).then((response) => {
            if (controller.signal.aborted) { response.close(); throw new SourceTransportError(timedOut ? 'timeout' : 'cancelled'); }
            return response;
          });
          activeResponse = await Promise.race([pendingResponse, aborted]);
          const response = activeResponse;
          const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (method !== "GET" || !source.endpointPolicy.allowRedirects || redirects >= source.endpointPolicy.maxRedirects || !responseHeaders.location) {
              throw new SourceTransportError('unsafe-endpoint', response.status);
            }
            currentUrl = new URL(responseHeaders.location, parsedUrl).toString();
            // Validate before the next DNS lookup and never forward credentials.
            checkedUrl(currentUrl, source);
            response.close(); activeResponse = undefined;
            continue;
          }
          if (response.status === 429) throw new SourceTransportError('rate-limited', 429, retryAfter(responseHeaders['retry-after'], now()));
          if (response.status < 200 || response.status >= 300) throw new SourceTransportError('http-error', response.status);
          if (responseHeaders['content-encoding'] && responseHeaders['content-encoding'].toLowerCase() !== 'identity') throw new SourceTransportError('invalid-response', response.status);
          const declaredLength = responseHeaders['content-length'];
          if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes)) throw new SourceTransportError('response-too-large', response.status);
          const iterator = response.body[Symbol.asyncIterator]();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) throw new SourceTransportError('invalid-response', response.status);
            context.consumeBytes(next.value.byteLength);
            total += next.value.byteLength;
            if (total > maxResponseBytes) throw new SourceTransportError('response-too-large', response.status);
            chunks.push(next.value);
            context.throwIfCancelled();
          }
          const data = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new SourceTransportError('invalid-response', response.status); }
          return { url: parsedUrl.toString(), status: response.status, headers: responseHeaders, text };
        }
      } catch (error) {
        if (error instanceof SourceTransportError || error instanceof ToolError) throw error;
        if (controller.signal.aborted) throw new SourceTransportError(timedOut ? 'timeout' : 'cancelled');
        throw new SourceTransportError('invalid-response');
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        activeResponse?.close();
      }
    },
  };
}

/**
 * Explicit optional resolver for Fake-IP environments. Fixed Google endpoint, fixed public TLS
 * bootstrap and the same budget/stream/timeout checks as source requests; no arbitrary DoH URL.
 * Both DNS HTTP traffic and the eventual source request count toward the caller's total budget.
 */
export function createGoogleDohResolver(options: { send?: PinnedSender; timeoutMs?: number } = {}): DnsResolver {
  const dnsSource: SourceDefinition = {
    sourceId: 'betterme-dns-google', name: 'Google Public DNS HTTPS resolver', adapterId: 'internal-dns', adapterVersion: '1',
    capabilities: [], runtime: ['local-service', 'server'], entityType: 'company-directory', enabled: true, status: 'active', remoteFilters: [],
    endpointPolicy: { allowedHosts: ['dns.google'], allowedPathPrefixes: ['/resolve'], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: 'Google Public DNS', homepageUrl: 'https://developers.google.com/speed/public-dns', usage: 'metadata', requiresAttribution: false, notes: 'Explicit DNS provider choice; sends requested source hostnames to Google, never full source URLs, user addresses or credentials.' },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 0, maxRecords: 1, maxPages: 1, requestsPerMinute: 1200 },
  };
  const dnsTransport = createControlledSourceTransport({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    ...(options.send ? { send: options.send } : {}),
    timeoutMs: options.timeoutMs ?? 5000,
    maxResponseBytes: 64 * 1024,
  });
  return async (hostname, context, signal) => {
    if (!context || !signal) throw new ToolError('invalid-context');
    if (typeof hostname !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(hostname) || hostname.startsWith('.') || hostname.endsWith('.') || isIP(hostname)) throw new SourceTransportError('unsafe-endpoint');
    const response = await dnsTransport.request({
      url: `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`, source: dnsSource,
      context: { ...context, signal }, headers: { accept: 'application/dns-json' },
    });
    let result: unknown;
    try { result = JSON.parse(response.text); } catch { throw new SourceTransportError('invalid-response'); }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new SourceTransportError('invalid-response');
    const data = result as { Status?: unknown; Answer?: unknown };
    if (data.Status !== 0 || !Array.isArray(data.Answer)) throw new SourceTransportError('invalid-response');
    const answers = data.Answer.filter((value): value is { type: number; data: string } =>
      value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 1 && typeof (value as { data?: unknown }).data === 'string');
    const addresses = [...new Set(answers.map((value) => value.data))].map((address) => ({ address, family: 4 as const }));
    if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isPublicAddress(entry.address) || isIP(entry.address) !== 4)) throw new SourceTransportError('unsafe-endpoint');
    return addresses;
  };
}
