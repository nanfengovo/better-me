import assert from "node:assert/strict";
import test from "node:test";
import { generateLocalCodingCandidate, resolveLocalCodingModel, verifyCodingCandidate, type CodingGenerateInput } from "../src/sandbox/coding-engine.js";

const live = () => new AbortController().signal;
test("one immutable oracle per fresh guest; JSON object order is irrelevant but nested types and array order are not", async () => {
  const cases = [
    { id: "both", input: { n: 1 }, expected: { b: [1, null], a: "guest" } },
    { id: "type", input: { n: 1 }, expected: { b: ["1", null], a: "guest" } },
    { id: "ordered", input: { n: 2 }, expected: { b: [null, 2], a: "guest" } },
  ];
  const original = structuredClone(cases);
  const checks = await verifyCodingCandidate('input => { const n=input.n; input.n=20; globalThis.runs=(globalThis.runs||0)+1; return { a: globalThis.runs===1 ? "guest" : "old", b:[n,null] }; }', cases, live());
  assert.deepEqual(checks.map(c => [c.id, c.passed]), [["both", true], ["type", false], ["ordered", false]]);
  assert.deepEqual(cases, original);
});

const model = "synthetic-coder:tiny", wireModel = model + ":local", digest = "a".repeat(64);
const job: CodingGenerateInput = { goal: "Copy the JSON input", cases: [{ id: "fixed", input: 2, expected: 2 }], targetCaseId: "fixed", previousChecks: [], model, modelDigest: digest };
const tags = (entry = {}) => Response.json({ models: [{ name: model, model, digest: "sha256:" + digest, ...entry }] });
const localShow = (extra = {}) => Response.json({ details: { format: "gguf" },
  model_info: { "general.architecture": "test", "general.parameter_count": 1024 }, ...extra });
const supported = () => Response.json({ version: "0.40.15" });
const reply = (extra = {}) => Response.json({ model: wireModel, done: true, done_reason: "stop",
  message: { role: "assistant", content: JSON.stringify({ source: "input => input" }) }, ...extra });

test("the daemon version is an explicit protocol allowlist, not a semver guess; unsupported versions see no task", async t => {
  let advertised: unknown, paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname; paths.push(p);
    if (p === "/api/version") { assert.equal(init.method, "GET"); assert.equal(init.body, undefined); return Response.json(advertised); }
    if (p === "/api/tags") return tags();
    if (p === "/api/show") return localShow();
    return reply();
  });
  for (advertised of [{ version: "0.40.14" }, { version: "0.40.16" }, { version: "0.40.15-rc.1" },
    { version: "v0.40.15" }, { version: 40.15 }, {}, null]) {
    paths = [];
    await assert.rejects(generateLocalCodingCandidate(job, live()), { message: "coding_local_transport_unavailable" });
    assert.deepEqual(paths, ["/api/version"]);
  }
});

test("replacement by an unaudited daemon during model preflight fails before the prompt-bearing request", async t => {
  let changed = false, requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/version")) return changed ? Response.json({ version: "0.40.16" }) : supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) { changed = true; return localShow(); }
    requests++; return reply();
  });
  await assert.rejects(generateLocalCodingCandidate(job, live()), { message: "coding_local_transport_unavailable" });
  assert.equal(requests, 0);
});

test("an installed alias becomes remote after metadata preflight: the local-only request is refused, never forwarded or retried bare", async t => {
  const chatModels: string[] = []; let aliasBecameRemote = false, forwarded = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname;
    if (p === "/api/version") return supported();
    if (p === "/api/tags") return tags();
    if (p === "/api/show") { aliasBecameRemote = true; return localShow(); }
    assert.equal(p, "/api/chat"); assert.equal(aliasBecameRemote, true);
    const body = JSON.parse(String(init.body)); chatModels.push(body.model);
    assert.ok(body.messages.some((m: {content: string}) => m.content.includes(job.goal)));
    // Mirror v0.40.15 ChatHandler's guard on the resolved manifest, before its upstream client.
    if (body.model === wireModel) return Response.json({ error: "not found" }, { status: 404 });
    forwarded++; return reply({ model: body.model });
  });
  await assert.rejects(generateLocalCodingCandidate(job, live()), { message: "coding_local_transport_unavailable" });
  assert.deepEqual(chatModels, [wireModel]); assert.equal(forwarded, 0);
});

test("only an exact source-qualified reply is eligible; a bare name, different model, or remote marker never triggers fallback", async t => {
  let metadata: Record<string, unknown> = {}, chatModels: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) return localShow();
    assert.equal(new URL(url).pathname, "/api/chat"); chatModels.push(JSON.parse(String(init.body)).model);
    return reply(metadata);
  });
  for (metadata of [{ model }, { model: "other:tiny:local" }, { model: "" }, { remote_model: "cloud" },
    { remote_host: "https://example.invalid" }, { remote_model: "" }, { remote_host: null }]) {
    chatModels = []; await assert.rejects(generateLocalCodingCandidate(job, live()), { message: "coding_invalid_model_output" });
    assert.deepEqual(chatModels, [wireModel]);
  }
});

test("generates once on the exact locally installed tag, checking its digest on both sides of the request", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).origin, "http://127.0.0.1:11434"); paths.push(new URL(url).pathname);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) { assert.deepEqual(JSON.parse(String(init.body)), { model, verbose: false }); return localShow(); }
    assert.equal(new URL(url).pathname, "/api/chat");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, wireModel); assert.equal(body.stream, false); assert.ok(body.options.num_predict > 0 && body.options.num_predict <= 4096);
    assert.ok(body.messages.some((x: { content: string }) => x.content.includes(job.targetCaseId)));
    return reply();
  });
  assert.equal(await resolveLocalCodingModel(model, live()), digest);
  assert.equal(await generateLocalCodingCandidate(job, live()), "input => input");
  assert.deepEqual(paths, ["/api/version", "/api/tags", "/api/show", "/api/version", "/api/tags", "/api/show", "/api/version", "/api/chat", "/api/version", "/api/tags", "/api/show"]);
});

test("JSON coercions, async values, exceptions and expressions posing as functions cannot accidentally pass", async () => {
  const examples: Array<[string, unknown]> = [
    ["input => undefined", null], ["input => ({x:undefined})", {}], ["input => [undefined]", [null]],
    ["input => Array(1)", [null]], ["input => NaN", null], ["input => new Date(0)", "1970-01-01T00:00:00.000Z"],
    ["input => ({toJSON(){return 1}})", 1], ["input => ({get x(){return 1}})", { x: 1 }],
    ["input => Promise.resolve(null)", {}], ["async input => input", null],
    ["function* iterator(x) { yield x }", {}], ["input => input, () => 7", 7],
    ["(() => () => 7)()", 7], ['input => {throw new Error("private candidate error")}', null],
    [`input => { JSON.stringify = () => '"forged"'; return undefined }`, "forged"],
    ['input => {const a={}; a.self=a; return a}', {}],
  ];
  for (const [source, expected] of examples) {
    const [check] = await verifyCodingCandidate(source, [{ id: "probe", input: null, expected }], live());
    assert.equal(check?.passed, false, source);
    assert.match(check?.error ?? "", /^(?:invalid_source|non_json_result|execution_failed|sandbox_limit)$/);
    assert.ok(!JSON.stringify(check).includes("private candidate"));
  }
  const [normal] = await verifyCodingCandidate("function identity(input) { return input; };", [{ id: "literal", input: { ["__proto__"]: false }, expected: { ["__proto__"]: false } }], live());
  assert.equal(normal?.passed, true);
});

test("case oracles are snapshotted before the first await; unsupported case inputs never run code or echo data", async () => {
  const cases = [{ id: "x", input: { x: 1 }, expected: { x: 1 } }];
  const check = verifyCodingCandidate("input=>input", cases, live());
  cases[0]!.expected.x = 100;
  assert.equal((await check)[0]?.passed, true);
  for (const invalid of [undefined, Infinity, new Date(), { nested: Symbol() },
    Object.defineProperty({}, "hidden", { get() { throw new Error("private getter"); } }), "x".repeat(34 * 1024)]) {
    await assert.rejects(verifyCodingCandidate("input=>input", [{ id: "x", input: invalid, expected: null }], live()), { message: "coding_invalid_cases" });
  }
  await assert.rejects(verifyCodingCandidate("input=>input", [cases[0]!,cases[0]!], live()), { message: "coding_invalid_cases" });
  await assert.rejects(verifyCodingCandidate("input=>input", Array(1), live()), { message: "coding_invalid_cases" });
  const accessor = { id: "x", get input() { throw new Error("private case getter"); }, expected: null };
  await assert.rejects(verifyCodingCandidate("input=>input", [accessor], live()), { message: "coding_invalid_cases" });
  await assert.rejects(verifyCodingCandidate("input=>input", cases, AbortSignal.abort(new Error("secret reason"))), { message: "coding_cancelled" });
});

test("retry context includes the selected case and bounded prior code, never caller extra fields, arbitrary check text or credentials", async t => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) return localShow();
    const messages = JSON.parse(String(options.body)).messages;
    assert.equal(messages.length, 2);
    const data = JSON.parse(messages[1].content);
    assert.equal(data.targetCaseId, "fixed");
    assert.deepEqual(data.previousChecks, [{ id: "fixed", passed: false }]);
    assert.equal(data.previousSource.truncated, true);
    const [head, tail] = data.previousSource.parts;
    assert.ok(head.length + tail.length <= 8192 && head.startsWith("head") && tail.endsWith("tail"));
    assert.ok(!JSON.stringify(messages).includes("DO_NOT_FORWARD"));
    return reply();
  });
  const input = { ...job, cases: [{ ...job.cases[0]!, workspaceData: "DO_NOT_FORWARD" }], apiKey: "DO_NOT_FORWARD",
    previousSource: "head" + "s".repeat(19_000) + "tail", previousChecks: [{ id: "fixed", passed: false, error: "DO_NOT_FORWARD" }] };
  assert.equal(await generateLocalCodingCandidate(input, live()), "input => input");
});

test("cloud labels, disguised remote aliases, missing tags and ambiguous manifests are denied without generation", async t => {
  let calls = 0, response: () => Response = () => tags({ remote_host: "https://not-local.invalid" });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++; if (url.endsWith("/api/version")) return supported();
    assert.equal(url, "http://127.0.0.1:11434/api/tags"); return response();
  });
  for (const bad of ["coder:cloud", "team/cloud-fast", "https://evil.invalid", "../coder", model + ":local"]) {
    await assert.rejects(resolveLocalCodingModel(bad, live()), { message: "coding_model_not_local" });
  }
  assert.equal(calls, 0);
  for (const make of [() => tags({ remote_model: "remote" }), () => tags({ remote_host: "http://127.0.0.1" }),
    () => Response.json({ models: [] }), () => tags({ model: "wrong" }),
    () => Response.json({ models: [{ name: model, digest }, { name: model, digest }] })]) {
    response = make;
    await assert.rejects(generateLocalCodingCandidate(job, live()), { message: "coding_model_not_local" });
  }
  response = () => tags({ digest: "not-a-digest" });
  await assert.rejects(resolveLocalCodingModel(model, live()), { message: "coding_model_metadata_invalid" });
});

test("a plain-looking tag is not sufficient: remote show manifests and absent local weight evidence never receive the task", async t => {
  let show:()=>Response = () => localShow(); const paths:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:string,init:RequestInit)=>{
    const p=new URL(url).pathname; paths.push(p);
    if(p==="/api/version") return supported();
    if(p==="/api/tags") return tags();
    assert.equal(p,"/api/show");assert.deepEqual(JSON.parse(String(init.body)),{model,verbose:false});return show();
  });
  for(const val of [{remote_model:"cloud-backed"},{remote_host:"https://example.invalid"},{model_info:{}},{details:{format:"unknown"}}]){
    show=()=>localShow(val);await assert.rejects(generateLocalCodingCandidate(job,live()),{message:"coding_model_not_local"});
  }
  assert.ok(!paths.includes("/api/chat"));
});

test("pin drift before transfer sends nothing; late model changes, other models and truncated answers cannot produce a candidate", async t => {
  let phase = "", reads = 0, posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) {
      reads++; return tags({ digest: phase === "before" || phase === "after" && reads === 2 ? "b".repeat(64) : digest });
    }
    if (url.endsWith("/api/show")) return localShow();
    posts++;
    if (phase === "truncated" || phase === "wrong") return Response.json({ model: phase === "wrong" ? "backup" : wireModel, done: true,
      done_reason: phase === "truncated" ? "length" : "stop", message: { role: "assistant", content: '{"source":"input=>input"}' } });
    if (phase === "script") return Response.json({ model: wireModel, done: true, done_reason: "stop",
      message: { role: "assistant", content: JSON.stringify({ source: "input=>input, (()=>()=>0)()" }) } });
    return reply();
  });
  for (phase of ["before", "after", "truncated", "wrong", "script"]) {
    reads = posts = 0;
    await assert.rejects(generateLocalCodingCandidate(job, live()), { message: phase === "before" || phase === "after" ? "coding_model_changed" : "coding_invalid_model_output" });
    assert.equal(posts, phase === "before" ? 0 : 1);
  }
});

test("HTTP limits apply to actual streaming bytes; redirects and private provider failures give fixed codes", async t => {
  let response: () => Response;
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/api/version") ? supported() : response());
  for (const [make, error] of [
    [() => new Response("private", { status: 302, headers: { location: "https://not-local.invalid" } }), "coding_local_transport_unavailable"],
    [() => { throw new Error("private network failure"); }, "coding_local_transport_unavailable"],
    [() => new Response("{}", { headers: { "content-length": String(1024 * 1024) } }), "coding_local_response_limit"],
    [() => new Response(new Uint8Array(513 * 1024)), "coding_local_response_limit"],
    [() => new Response("private malformed body"), "coding_local_transport_unavailable"],
  ] as const) {
    response = make;
    await assert.rejects(resolveLocalCodingModel(model, live()), { message: error });
  }
});

test("aborting a pending HTTP body cancels the reader and never exposes the caller's abort reason", async t => {
  const abort = new AbortController(), started = Promise.withResolvers<void>(); let cancelled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/api/version") ? supported() : new Response(new ReadableStream({
    pull() { started.resolve(); }, cancel() { cancelled = true; },
  })));
  const result = resolveLocalCodingModel(model, abort.signal);
  await started.promise; abort.abort(new Error("private interruption"));
  await assert.rejects(result, { message: "coding_cancelled" });
  assert.equal(cancelled, true);
});

const patchReply = (payload: unknown) => Response.json({ model: wireModel, done: true, done_reason: "stop",
  message: { role: "assistant", content: JSON.stringify(payload) } });
test("one model response replaces only a unique old fragment from its captured base, then every original case is verified", async t => {
  let generations = 0;
  const request = { ...job, goal: "increment even inputs only", previousSource: "x => x % 2 ? x : x + 0; ",
    targetCaseId: "even", cases: [{ id: "odd", input: 1, expected: 1 }, { id: "even", input: 2, expected: 3 }],
    previousChecks: [{ id: "odd", passed: true }, { id: "even", passed: false, error: "output_mismatch" }] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) return localShow();
    generations++;
    request.previousSource = "x => -99"; // mutable caller cannot change the in-flight base
    return patchReply({ kind: "replace", oldText: "x + 0", newText: "x + 1" });
  });
  const candidate = await generateLocalCodingCandidate(request, live());
  assert.equal(generations, 1);
  assert.equal(candidate, "x => x % 2 ? x : x + 1; ");
  assert.deepEqual(await verifyCodingCandidate(candidate, request.cases, live()), [{ id: "odd", passed: true }, { id: "even", passed: true }]);
});

test("invalid edit replies never prompt again, choose an occurrence, invent hidden code, or silently fall back to the old candidate", async t => {
  const edit = (oldText: string, newText = "1") => ({ kind: "replace", oldText, newText });
  const veryLong = "x => /* " + "h".repeat(6400) + "OMITTED_UNIQUE" + "m".repeat(3000) + " */ x + 0";
  const atHead = veryLong.slice(6135, 6152); // crosses the end of the first visible span
  const edge = "x => /*" + "h".repeat(6128) + "VISIBLE__HIDDEN" + "m".repeat(3000) + "*/ x";
  const hiddenDuplicate = "x => /* TARGET " + "h".repeat(6800) + "TARGET" + "m".repeat(3000) + "*/ x";
  const small = "x => x + 0", oldMarker = "\n/* …previous candidate truncated… */\n";
  const rows: [string | undefined, string][] = [
    [undefined, JSON.stringify(edit("x"))], [small, JSON.stringify(edit(""))], [small, JSON.stringify(edit("absent"))],
    [small, JSON.stringify(edit("x"))], ["x => 'aaa'", JSON.stringify(edit("aa"))],
    [small, JSON.stringify({ ...edit("x + 0"), source: "x=>42" })],
    [small, JSON.stringify({ ...edit("x + 0"), expected: 1 })],
    [small, '{"kind":"replace","oldText":"absent","oldText":"x + 0","newText":"1"}'],
    [small, '{"kind":"replace","oldText":"x + 0","newText":"1","__proto__":"forged"}'],
    [small, JSON.stringify({ kind: "replace", oldText: 0, newText: "1" })],
    [small, JSON.stringify(edit("x + 0", "x".repeat(32 * 1024 + 1)))],
    [small + " ".repeat(32 * 1024 - small.length), JSON.stringify(edit("0", "1000"))],
    [veryLong, JSON.stringify(edit("OMITTED_UNIQUE"))], [veryLong, JSON.stringify(edit(atHead))],
    [edge, JSON.stringify(edit("VISIBLE__HIDDEN"))], [hiddenDuplicate, JSON.stringify(edit("TARGET"))],
    [veryLong, JSON.stringify(edit(oldMarker))], [small, JSON.stringify(edit("x + 0", "x; globalThis.outside = 5"))],
  ];
  let content = "", generations = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) return localShow();
    generations++; return Response.json({ model: wireModel, done: true, done_reason: "stop", message: { role: "assistant", content } });
  });
  for (const [previousSource, raw] of rows) {
    content = raw; await assert.rejects(generateLocalCodingCandidate({ ...job, previousSource }, live()), { message: "coding_invalid_model_output" });
  }
  assert.equal(generations, rows.length);
});

test("a unique shown tail edit preserves the whole omitted middle and literal replacement characters; a repair may still return a full function", async t => {
  const base = 'x => /*' + 'f'.repeat(7000) + 'HIDDEN-ORIGINAL' + 'g'.repeat(3100) + '*/ "original";';
  let output: unknown = { kind: "replace", oldText: '"original"', newText: '"$&"' };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/version")) return supported();
    if (url.endsWith("/api/tags")) return tags();
    if (url.endsWith("/api/show")) return localShow();
    const body = JSON.parse(String(init.body)), view = JSON.parse(body.messages[1].content).previousSource;
    assert.equal(view.truncated, true); assert.equal(view.parts.length, 2);
    assert.ok(!view.parts.join("").includes("HIDDEN-ORIGINAL") && view.parts[1].includes('"original"'));
    assert.ok(Array.isArray(body.format.oneOf));
    return patchReply(output);
  });
  const source = await generateLocalCodingCandidate({ ...job, previousSource: base }, live());
  assert.equal(source, base.slice(0, -11) + '"$&";');
  assert.deepEqual(await verifyCodingCandidate(source, [{ id: "literal", input: null, expected: "$&" }], live()), [{ id: "literal", passed: true }]);
  output = { source: "x => x" };
  assert.equal(await generateLocalCodingCandidate({ ...job, previousSource: base }, live()), "x => x");
});
