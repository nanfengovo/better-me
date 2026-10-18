import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError, type SourceDefinition } from '@better-me/opportunities';
import type { SourceAdapterContext } from '../src/contracts.js';
import { createControlledSourceTransport, createGoogleDohResolver, isPublicAddress, SourceTransportError, type PinnedResponse, type PinnedSendRequest } from '../src/transport.js';

function source(overrides: Partial<SourceDefinition['endpointPolicy']> = {}): SourceDefinition {
  return {
    sourceId: 'synthetic-source', name: 'Synthetic source', adapterId: 'synthetic-adapter', adapterVersion: '1',
    capabilities: ['list-jobs'], runtime: ['local-service'], entityType: 'job-posting', enabled: true, status: 'active', remoteFilters: [],
    endpointPolicy: { allowedHosts: ['careers.example.com'], allowedPathPrefixes: ['/jobs'], requireHttps: true, allowRedirects: false, maxRedirects: 0, ...overrides },
    attribution: { label: 'Synthetic source', usage: 'metadata', requiresAttribution: true },
    refreshPolicy: { mode: 'manual', minIntervalSeconds: 60, maxRecords: 100, maxPages: 2, requestsPerMinute: 30 },
  };
}
function context(limits: { requests?: number; bytes?: number; signal?: AbortSignal } = {}) {
  let requests = 0, bytes = 0;
  const signal = limits.signal ?? new AbortController().signal;
  const value: SourceAdapterContext = {
    observedAt: '2026-10-18T00:00:00.000Z', requestId: 'synthetic-request', signal, actorScope: 'synthetic-user',
    budget: { requests: limits.requests ?? 10, bytes: limits.bytes ?? 100000, timeoutMs: 1000 },
    consumeRequests: (count = 1) => { requests += count; if (requests > value.budget.requests) throw new ToolError('budget-exceeded'); },
    consumeBytes: (count) => { bytes += count; if (bytes > value.budget.bytes) throw new ToolError('budget-exceeded'); },
    throwIfCancelled: () => { if (signal.aborted) throw new ToolError('cancelled'); },
  };
  return { value, requests: () => requests, bytes: () => bytes };
}
function response(status: number, chunks: string[], headers: Record<string, string> = {}) {
  let closed = false;
  const value: PinnedResponse = {
    status, headers,
    body: (async function* () { for (const chunk of chunks) yield new TextEncoder().encode(chunk); })(),
    close: () => { closed = true; },
  };
  return { value, closed: () => closed };
}
const publicDns = async () => [{ address: '1.1.1.1', family: 4 as const }];

test('global-only address policy excludes private/metadata, mapped IPv6 and transition/documentation networks', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.100.100.200', '168.63.129.16', '192.168.1.1', '172.16.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '192.0.2.3', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('every DNS answer must be public; sender receives one pinned approved address', async () => {
  const ctx = context();
  let sent: PinnedSendRequest | undefined;
  const answer = response(200, ['{"hello":', '"世界"}']);
  const transport = createControlledSourceTransport({ resolve: publicDns, send: async (request) => { sent = request; return answer.value; } });
  const result = await transport.request({ source: source(), context: ctx.value, url: 'https://careers.example.com/jobs/list' });
  assert.equal(result.text, '{"hello":"世界"}');
  assert.equal(sent!.address.address, '1.1.1.1');
  assert.equal(sent!.url.hostname, 'careers.example.com');
  assert.equal(ctx.requests(), 1);
  assert.equal(ctx.bytes(), new TextEncoder().encode(result.text).byteLength);
  assert.equal(answer.closed(), true);
  let calls = 0;
  const mixed = createControlledSourceTransport({ resolve: async () => [...await publicDns(), { address: '10.0.0.1', family: 4 }], send: async () => { calls++; return response(200, ['']).value; } });
  await assert.rejects(mixed.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'unsafe-endpoint');
  assert.equal(calls, 0);
});

test('credential, local/IP, encoded traversal and path-prefix bypass URLs never reach DNS or send', async () => {
  let dnsCalls = 0;
  const transport = createControlledSourceTransport({ resolve: async () => { dnsCalls++; return publicDns(); }, send: async () => response(200, ['']).value });
  for (const url of [
    'http://careers.example.com/jobs', 'https://user:password@careers.example.com/jobs', 'https://localhost/jobs',
    'https://127.0.0.1/jobs', 'https://careers.example.com:444/jobs', 'https://careers.example.com/jobs-secret',
    'https://careers.example.com/jobs/%2e%2e/admin', 'https://careers.example.com/jobs/%252e%252e/admin',
    'https://careers.example.com/jobs#private', 'https://careers.example.com/jobs/%5cadmin',
  ]) await assert.rejects(transport.request({ source: source(), context: context().value, url }), (error: unknown) => error instanceof SourceTransportError && error.code === 'unsafe-endpoint');
  assert.equal(dnsCalls, 0);
});

test('redirects are disabled by default and every explicitly allowed redirect revalidates DNS and policy', async () => {
  const first = response(302, [], { location: '/jobs/next' });
  const transport = createControlledSourceTransport({ resolve: publicDns, send: async () => first.value });
  await assert.rejects(transport.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }));
  assert.equal(first.closed(), true);
  let calls = 0, dnsCalls = 0;
  const allowed = createControlledSourceTransport({
    resolve: async () => { dnsCalls++; return publicDns(); },
    send: async () => { calls++; return calls === 1 ? response(302, [], { location: '/jobs/next' }).value : response(200, ['ok']).value; },
  });
  const ctx = context();
  const output = await allowed.request({ source: source({ allowRedirects: true, maxRedirects: 1 }), context: ctx.value, url: 'https://careers.example.com/jobs' });
  assert.equal(output.url, 'https://careers.example.com/jobs/next');
  assert.equal(calls, 2); assert.equal(dnsCalls, 2); assert.equal(ctx.requests(), 2);
  const escaped = createControlledSourceTransport({ resolve: publicDns, send: async () => response(302, [], { location: 'https://169.254.169.254/latest/meta-data/' }).value });
  await assert.rejects(escaped.request({ source: source({ allowRedirects: true, maxRedirects: 1 }), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'unsafe-endpoint');
});

test('stream budgets stop oversized bodies and account UTF-8 bytes without trusting content-length', async () => {
  const answer = response(200, ['1234', '5678']);
  const limited = createControlledSourceTransport({ resolve: publicDns, send: async () => answer.value, maxResponseBytes: 6 });
  await assert.rejects(limited.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'response-too-large');
  assert.equal(answer.closed(), true);
  const byteBudget = createControlledSourceTransport({ resolve: publicDns, send: async () => response(200, ['中文']).value });
  await assert.rejects(byteBudget.request({ source: source(), context: context({ bytes: 5 }).value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof ToolError && error.code === 'budget-exceeded');
  let sent = 0;
  const zeroRequests = createControlledSourceTransport({ resolve: publicDns, send: async () => { sent++; return response(200, ['']).value; } });
  await assert.rejects(zeroRequests.request({ source: source(), context: context({ requests: 0 }).value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof ToolError && error.code === 'budget-exceeded');
  assert.equal(sent, 0);
});

test('429 exposes bounded Retry-After metadata without auto-retrying or leaking response bodies', async () => {
  const transport = createControlledSourceTransport({ resolve: publicDns, send: async () => response(429, ['secret body'], { 'retry-after': '120' }).value });
  await assert.rejects(transport.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => {
    assert.ok(error instanceof SourceTransportError);
    assert.equal(error.code, 'rate-limited'); assert.equal(error.retryAfterSeconds, 120); assert.equal(error.status, 429);
    assert.equal(error.message.includes('secret'), false); return true;
  });
});

test('abort and deadline interrupt stalled DNS and stalled response streams', async () => {
  const stalledDns = createControlledSourceTransport({ resolve: () => new Promise(() => undefined), send: async () => response(200, ['']).value, timeoutMs: 15 });
  await assert.rejects(stalledDns.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'timeout');
  const controller = new AbortController();
  const neverBody: PinnedResponse = { status: 200, headers: {}, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }, close: () => undefined };
  const stalledBody = createControlledSourceTransport({ resolve: publicDns, send: async () => neverBody });
  const pending = stalledBody.request({ source: source(), context: context({ signal: controller.signal }).value, url: 'https://careers.example.com/jobs' });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof SourceTransportError && error.code === 'cancelled');
});

test('arbitrary auth/cookie headers are rejected and invalid UTF-8 is never silently repaired', async () => {
  const transport = createControlledSourceTransport({ resolve: publicDns, send: async () => response(200, ['ok']).value });
  await assert.rejects(transport.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs', headers: { authorization: 'Bearer private-key' } }));
  const malformed = createControlledSourceTransport({ resolve: publicDns, send: async () => ({ status: 200, headers: {}, body: (async function* () { yield new Uint8Array([0xc0, 0xaf]); })(), close: () => undefined }) });
  await assert.rejects(malformed.request({ source: source(), context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'invalid-response');
});

test('source/host sliding-window rate budget includes redirects and waiting remains cancellable', async () => {
  const limitedSource = source({ allowRedirects: true, maxRedirects: 1 });
  limitedSource.refreshPolicy.requestsPerMinute = 1;
  let calls = 0;
  const transport = createControlledSourceTransport({ resolve: publicDns, timeoutMs: 20, send: async () => { calls++; return response(302, [], { location: '/jobs/next' }).value; } });
  await assert.rejects(transport.request({ source: limitedSource, context: context().value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof SourceTransportError && error.code === 'timeout');
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = transport.request({ source: limitedSource, context: context({ signal: controller.signal }).value, url: 'https://careers.example.com/jobs' });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error: unknown) => error instanceof SourceTransportError && error.code === 'cancelled');
  assert.equal(calls, 1);
});

test('explicit Google DoH pins its TLS bootstrap and charges DNS plus source requests to one budget', async () => {
  let bootstrap: PinnedSendRequest | undefined;
  const resolve = createGoogleDohResolver({ send: async (input) => {
    bootstrap = input;
    return response(200, [JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] })]).value;
  } });
  const transport = createControlledSourceTransport({ resolve, send: async () => response(200, ['source body']).value });
  const ctx = context();
  const result = await transport.request({ source: source(), context: ctx.value, url: 'https://careers.example.com/jobs' });
  assert.equal(result.text, 'source body'); assert.equal(ctx.requests(), 2);
  assert.equal(bootstrap!.address.address, '8.8.8.8'); assert.equal(bootstrap!.url.hostname, 'dns.google');
  assert.equal(bootstrap!.url.searchParams.get('name'), 'careers.example.com');
  assert.equal(bootstrap!.url.search.includes('/jobs'), false);
  assert.ok(ctx.bytes() > 'source body'.length);
  await assert.rejects(transport.request({ source: source(), context: context({ requests: 1 }).value, url: 'https://careers.example.com/jobs' }), (error: unknown) => error instanceof ToolError && error.code === 'budget-exceeded');
});

test('DoH cannot bless private DNS answers, redirect its fixed provider or run without trusted accounting', async () => {
  const privateResolver = createGoogleDohResolver({ send: async () => response(200, ['{"Status":0,"Answer":[{"type":1,"data":"10.0.0.1"}]}']).value });
  const ctx = context();
  await assert.rejects(privateResolver('careers.example.com', ctx.value, ctx.value.signal), (error: unknown) => error instanceof SourceTransportError && error.code === 'unsafe-endpoint');
  const redirected = createGoogleDohResolver({ send: async () => response(302, [], { location: 'https://other.example.com/resolve' }).value });
  await assert.rejects(redirected('careers.example.com', context().value, new AbortController().signal));
  await assert.rejects(privateResolver('careers.example.com'), (error: unknown) => error instanceof ToolError && error.code === 'invalid-context');
});
