import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
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
  proxyUrl?: URL;
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
export type SourceProxyConfig = {
  url: string;
  bypass?: string;
};
export type SourceProxyResolver = () => SourceProxyConfig | undefined | Promise<SourceProxyConfig | undefined>;
export type ControlledTransportOptions = {
  resolve?: DnsResolver;
  send?: PinnedSender;
  maxResponseBytes?: number;
  timeoutMs?: number;
  now?: () => number;
  allowFakeIp?: boolean;
  proxy?: SourceProxyConfig;
  resolveProxy?: SourceProxyResolver;
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
export function isPublicAddress(address: string, options: { allowFakeIp?: boolean } = {}): boolean {
  const parts = ipv4Parts(address);
  if (parts) {
    const [a, b, c] = parts as [number, number, number, number];
    // Allow TUN Fake-IP pool (198.18.0.0/15) only when explicitly configured or in live TUN runtime
    if (options.allowFakeIp && a === 198 && (b === 18 || b === 19)) return true;
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

const MAX_POOLED_AGENTS = 32;
const pooledAgents = new Map<string, HttpsAgent>();

function pinnedAgent(url: URL, address: DnsAddress): HttpsAgent {
  const port = url.port || '443';
  const key = `${url.hostname.toLowerCase()}\u0000${port}\u0000${address.address}\u0000${address.family}`;
  const existing = pooledAgents.get(key);
  if (existing) {
    pooledAgents.delete(key);
    pooledAgents.set(key, existing);
    return existing;
  }
  const agent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 8,
    maxFreeSockets: 4,
    servername: url.hostname,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
  });
  if (pooledAgents.size >= MAX_POOLED_AGENTS) {
    const oldest = pooledAgents.entries().next().value;
    if (oldest) {
      pooledAgents.delete(oldest[0]);
      // Drain only idle sockets on LRU eviction so active requests can still complete cleanly.
      oldest[1].maxFreeSockets = 0;
      for (const sockets of Object.values(oldest[1].freeSockets)) {
        for (const socket of sockets ?? []) socket.destroy();
      }
    }
  }
  pooledAgents.set(key, agent);
  return agent;
}

function responseHeadersFrom(raw: IncomingHttpHeaders): Record<string, string> {
  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (value !== undefined) {
    responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return responseHeaders;
}

function parseProxyEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SourceTransportError('unsafe-endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.search || (url.pathname && url.pathname !== '/')) {
    throw new SourceTransportError('unsafe-endpoint');
  }
  return url;
}

function bypassesProxy(target: URL, rules?: string): boolean {
  if (!rules?.trim()) return false;
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return rules.split(/[,;]/).some((raw) => {
    let rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    if (rule === '<local>') return !hostname.includes('.') && !hostname.includes(':');
    const withPort = rule.match(/^(\[[\da-f:]+\]|[^:]+):(\d+)$/i);
    if (withPort) { if (withPort[2] !== port) return false; rule = withPort[1]!; }
    rule = rule.replace(/^\[|\]$/g, '');
    if (rule.endsWith('*') && !rule.slice(0, -1).includes('*')) return hostname.startsWith(rule.slice(0, -1));
    rule = rule.replace(/^(?:\*+\.?|\.)/, '');
    return Boolean(rule) && (hostname === rule || (!hostname.includes(':') && hostname.endsWith(`.${rule}`)));
  });
}

function openConnectTunnel(proxy: URL, target: URL, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SourceTransportError('cancelled')); return; }
    const authority = `${target.hostname}:${target.port || '443'}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.username || proxy.password) {
      headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    }
    const requester = proxy.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: authority,
      headers,
      signal,
    });
    req.once('connect', (response, socket) => {
      if (signal.aborted) { socket.destroy(); reject(new SourceTransportError('cancelled')); return; }
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy();
        reject(new SourceTransportError('invalid-response'));
        return;
      }
      resolve(socket);
    });
    req.once('error', (error) => {
      if (signal.aborted) reject(new SourceTransportError('cancelled'));
      else reject(error);
    });
    req.end();
  });
}

async function nodeProxySender(request: {
  url: URL;
  proxyUrl: URL;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}): Promise<PinnedResponse> {
  const socket = await openConnectTunnel(request.proxyUrl, request.url, request.signal);
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: request.signal,
      agent: new HttpsAgent({ keepAlive: false }),
      servername: request.url.hostname,
      createConnection: (_opts, cb) => {
        if (cb) cb(null, socket);
        return socket;
      },
    }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: responseHeadersFrom(response.headers),
        body: response,
        close: () => { response.destroy(); socket.destroy(); },
      });
    });
    req.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
    req.end();
  });
}

const nodeSender: PinnedSender = ({ url, address, headers, signal }) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
    method: 'GET', headers, signal, agent: pinnedAgent(url, address), family: address.family,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
  }, (response) => {
    resolve({ status: response.statusCode ?? 0, headers: responseHeadersFrom(response.headers), body: response, close: () => response.destroy() });
  });
  request.once('error', reject);
  request.end();
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

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

async function readCompressedResponseBody(
  response: PinnedResponse,
  encoding: 'gzip' | 'x-gzip' | 'deflate' | 'br',
  maxResponseBytes: number,
  context: SourceAdapterContext,
  signal: AbortSignal,
  aborted: Promise<never>,
): Promise<Uint8Array> {
  const decompressor = encoding === 'br'
    ? createBrotliDecompress()
    : encoding === 'deflate'
      ? createInflate()
      : createGunzip();
  let failure: unknown;
  const fail = (error: unknown) => {
    if (failure === undefined) failure = error;
    if (!decompressor.destroyed) decompressor.destroy();
    response.close();
  };
  const onAbort = () => fail(undefined);
  signal.addEventListener('abort', onAbort, { once: true });

  const feed = (async () => {
    const iterator = response.body[Symbol.asyncIterator]();
    let wireTotal = 0;
    try {
      while (!signal.aborted && !decompressor.destroyed) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new SourceTransportError('invalid-response', response.status);
        }
        wireTotal += next.value.byteLength;
        // Enforce compressed wire-byte cap separately so non-emitting/garbage streams cannot exhaust bandwidth.
        if (wireTotal > maxResponseBytes) {
          throw new SourceTransportError('response-too-large', response.status);
        }
        if (!decompressor.write(next.value)) {
          await new Promise<void>((resolveDrain, rejectDrain) => {
            const cleanup = () => {
              decompressor.off('drain', onDrain);
              decompressor.off('close', onClose);
              decompressor.off('error', onError);
              signal.removeEventListener('abort', onClose);
            };
            const onDrain = () => { cleanup(); resolveDrain(); };
            const onError = (err: unknown) => { cleanup(); rejectDrain(err); };
            const onClose = () => { cleanup(); rejectDrain(new SourceTransportError('cancelled', response.status)); };
            decompressor.once('drain', onDrain);
            decompressor.once('close', onClose);
            decompressor.once('error', onError);
            signal.addEventListener('abort', onClose, { once: true });
          });
        }
      }
      if (!decompressor.destroyed) decompressor.end();
    } catch (error) {
      fail(error);
    }
  })();
  void feed.catch(() => undefined);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const outIterator = decompressor[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([outIterator.next(), aborted]);
      if (next.done) break;
      const chunk = next.value as Uint8Array;
      context.consumeBytes(chunk.byteLength);
      total += chunk.byteLength;
      if (total > maxResponseBytes) {
        throw new SourceTransportError('response-too-large', response.status);
      }
      chunks.push(chunk);
      context.throwIfCancelled();
    }
    await feed;
    if (failure !== undefined) throw failure;
    return concatChunks(chunks, total);
  } catch (error) {
    fail(error);
    await feed;
    if (failure !== undefined && failure !== error) throw failure;
    if (error instanceof SourceTransportError || error instanceof ToolError || signal.aborted) throw error;
    throw new SourceTransportError('invalid-response', response.status);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!decompressor.destroyed) decompressor.destroy();
  }
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
  const timeoutMs = options.timeoutMs ?? 65_000;
  const allowFakeIp = options.allowFakeIp ?? (!options.resolve && !process.env.NODE_TEST_CONTEXT);
  const requestWindows = new Map<string, number[]>();
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new SourceTransportError('invalid-response');
  return {
    async request({ url: initialUrl, source, context, headers: suppliedHeaders }) {
      context.throwIfCancelled();
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
        const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'BetterMe-JobSources/0.1 (local personal career workstation)' };
        for (const [key, value] of Object.entries(suppliedHeaders ?? {})) {
          const name = key.toLowerCase();
          if (!['accept', 'if-none-match', 'if-modified-since'].includes(name) || typeof value !== 'string' || value.length > 1000 || Array.from(value).some((character) => [0, 10, 13].includes(character.charCodeAt(0)))) {
            throw new SourceTransportError('unsafe-endpoint');
          }
          headers[name] = value;
        }
        const resolvedProxy = options.resolveProxy
          ? await Promise.race([Promise.resolve(options.resolveProxy()), aborted])
          : options.proxy;
        let currentUrl = initialUrl;
        for (let redirects = 0; ; redirects++) {
          context.throwIfCancelled();
          const parsedUrl = checkedUrl(currentUrl, source);
          const useProxy = Boolean(resolvedProxy?.url && !bypassesProxy(parsedUrl, resolvedProxy.bypass));
          let address: DnsAddress;
          let proxyUrl: URL | undefined;
          if (useProxy) {
            proxyUrl = parseProxyEndpoint(resolvedProxy!.url);
            const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
            address = { address: isIP(proxyHost) ? proxyHost : '127.0.0.1', family: isIP(proxyHost) === 6 ? 6 : 4 };
          } else {
            const addresses = await Promise.race([resolve(parsedUrl.hostname, context, controller.signal), aborted]);
            if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isPublicAddress(entry.address, { allowFakeIp }) || isIP(entry.address) !== entry.family)) {
              throw new SourceTransportError('unsafe-endpoint');
            }
            context.throwIfCancelled();
            address = addresses[0]!;
          }
          await waitForRateSlot(parsedUrl.hostname);
          context.consumeRequests(1);
          const dispatch = proxyUrl && !options.send
            ? nodeProxySender({ url: parsedUrl, proxyUrl, headers, signal: controller.signal })
            : send({ url: parsedUrl, address, ...(proxyUrl ? { proxyUrl } : {}), headers, signal: controller.signal });
          const pendingResponse = dispatch.then((response) => {
            if (controller.signal.aborted) { response.close(); throw new SourceTransportError(timedOut ? 'timeout' : 'cancelled'); }
            return response;
          });
          activeResponse = await Promise.race([pendingResponse, aborted]);
          const response = activeResponse;
          const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!source.endpointPolicy.allowRedirects || redirects >= source.endpointPolicy.maxRedirects || !responseHeaders.location) {
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
          const contentEncoding = (responseHeaders['content-encoding'] ?? '').trim().toLowerCase();
          const declaredLength = responseHeaders['content-length'];
          if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes)) throw new SourceTransportError('response-too-large', response.status);
          let data: Uint8Array;
          if (!contentEncoding || contentEncoding === 'identity') {
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
            data = concatChunks(chunks, total);
          } else if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip' || contentEncoding === 'deflate' || contentEncoding === 'br') {
            data = await readCompressedResponseBody(response, contentEncoding, maxResponseBytes, context, controller.signal, aborted);
          } else {
            throw new SourceTransportError('invalid-response', response.status);
          }
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
export function createGoogleDohResolver(options: { send?: PinnedSender; timeoutMs?: number; cacheMaxTtlMs?: number; now?: () => number } = {}): DnsResolver {
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
  const cacheMaxTtlMs = options.cacheMaxTtlMs && options.cacheMaxTtlMs > 0 ? Math.min(options.cacheMaxTtlMs, 300_000) : 0;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { addresses: readonly DnsAddress[]; expiresAt: number }>();
  const inFlight = new Map<string, { promise: Promise<readonly DnsAddress[]>; waiters: number; controller: AbortController }>();

  async function resolveUncached(hostname: string, context: SourceAdapterContext, signal: AbortSignal): Promise<{ addresses: readonly DnsAddress[]; minTtlSeconds?: number }> {
    const response = await dnsTransport.request({
      url: `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`, source: dnsSource,
      context: { ...context, signal }, headers: { accept: 'application/dns-json' },
    });
    let result: unknown;
    try { result = JSON.parse(response.text); } catch { throw new SourceTransportError('invalid-response'); }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new SourceTransportError('invalid-response');
    const data = result as { Status?: unknown; Answer?: unknown };
    if (data.Status !== 0 || !Array.isArray(data.Answer)) throw new SourceTransportError('invalid-response');
    const answers = data.Answer.filter((value): value is { type: number; data: string; TTL?: unknown } =>
      value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 1 && typeof (value as { data?: unknown }).data === 'string');
    const addresses = [...new Set(answers.map((value) => value.data))].map((address) => ({ address, family: 4 as const }));
    if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isPublicAddress(entry.address) || isIP(entry.address) !== 4)) throw new SourceTransportError('unsafe-endpoint');
    const ttls = answers.map((value) => value.TTL).filter((ttl): ttl is number => typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0);
    const minTtlSeconds = ttls.length ? Math.min(...ttls) : undefined;
    return { addresses, minTtlSeconds };
  }

  return async (hostname, context, signal) => {
    if (!context || !signal) throw new ToolError('invalid-context');
    if (typeof hostname !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(hostname) || hostname.startsWith('.') || hostname.endsWith('.') || isIP(hostname)) throw new SourceTransportError('unsafe-endpoint');
    const normalizedHost = hostname.toLowerCase();
    if (cacheMaxTtlMs <= 0) {
      return (await resolveUncached(normalizedHost, context, signal)).addresses;
    }
    const cached = cache.get(normalizedHost);
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) {
      context.throwIfCancelled();
      return cached.addresses;
    }
    if (cached) cache.delete(normalizedHost);

    let active = inFlight.get(normalizedHost);
    if (!active) {
      const sharedController = new AbortController();
      const sharedContext: SourceAdapterContext = {
        ...context,
        signal: sharedController.signal,
        throwIfCancelled: () => {
          if (sharedController.signal.aborted) throw new SourceTransportError('cancelled');
        },
      };
      const promise = resolveUncached(normalizedHost, sharedContext, sharedController.signal).then(({ addresses, minTtlSeconds }) => {
        const ttlMs = minTtlSeconds !== undefined ? Math.min(cacheMaxTtlMs, Math.floor(minTtlSeconds * 1000)) : cacheMaxTtlMs;
        if (ttlMs > 0) {
          if (cache.size >= 128) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey !== undefined) cache.delete(oldestKey);
          }
          cache.set(normalizedHost, { addresses, expiresAt: now() + ttlMs });
        }
        return addresses;
      }).finally(() => {
        inFlight.delete(normalizedHost);
      });
      void promise.catch(() => undefined);
      active = { promise, waiters: 0, controller: sharedController };
      inFlight.set(normalizedHost, active);
    }

    active.waiters++;
    let onCallerAbort: (() => void) | undefined;
    const callerAborted = new Promise<never>((_resolve, reject) => {
      onCallerAbort = () => reject(new SourceTransportError('cancelled'));
      if (signal.aborted) onCallerAbort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    });
    void callerAborted.catch(() => undefined);
    try {
      return await Promise.race([active.promise, callerAborted]);
    } finally {
      if (onCallerAbort) signal.removeEventListener('abort', onCallerAbort);
      active.waiters--;
      if (active.waiters === 0 && !active.controller.signal.aborted) {
        // Cancel upstream DoH only when all waiting callers have aborted.
        active.controller.abort();
      }
    }
  };
}
