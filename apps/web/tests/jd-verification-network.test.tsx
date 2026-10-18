import assert from "node:assert/strict";
import test from "node:test";
import { createVerificationNetworkRecorder } from "../server/jd-verification-network.ts";
import { readVerificationNetworkSnapshot } from "../src/lib/jd-verification-network.ts";

const host = "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com";
const endpoint = `https://${host}/secret-path/captcha?token=secret-token#secret-fragment`;

test("被动验证记录只留下主机及有限事件，不读取或泄露请求秘密", () => {
  let time = 1000;
  const recorder = createVerificationNetworkRecorder("51JOB", { now: () => time });
  const request = new Proxy({}, { get: () => { throw new Error("secret-request-body"); } });
  recorder.request(request, endpoint, "xhr");
  time = 1012.8;
  recorder.response(request, 200);
  time = 1020;
  recorder.finished(request);
  const value = recorder.snapshot();
  assert.deepEqual(value, {
    requests: [{ id: 1, host, type: "xhr" }],
    events: [{ requestId: 1, phase: "request", atMs: 0 }, { requestId: 1, phase: "response", atMs: 12, status: 200 }, { requestId: 1, phase: "finished", atMs: 20 }],
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(value), /secret|captcha\?|https:|headers|cookie|body|error/i);
});

test("相同URL的不同请求互不混淆，未知或结束请求不能伪造后续事件", () => {
  const recorder = createVerificationNetworkRecorder("51JOB", { now: () => 0 });
  const a = {}, b = {}, unknown = {};
  recorder.response(unknown, 200); recorder.finished(unknown);
  recorder.request(a, endpoint, "xhr"); recorder.request(b, endpoint, "xhr");
  recorder.request(a, endpoint, "fetch");
  recorder.response(b, 503); recorder.failed(b);
  recorder.response(a, 200); recorder.finished(a);
  recorder.response(b, 200); recorder.finished(b); recorder.failed(a); recorder.response(a, 200);
  assert.deepEqual(recorder.snapshot().events.map(({ requestId, phase, status }) => [requestId, phase, status]), [
    [1, "request", undefined], [2, "request", undefined], [2, "response", 503], [2, "failed", undefined], [1, "response", 200], [1, "finished", undefined],
  ]);
});

test("只记录51JOB七个已观察精确HTTPS443验证主机与固定类型", () => {
  const hosts = [
    "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com",
    "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com",
    host,
    "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com",
    "upload.captcha-pro-open.aliyuncs.com", "upload.captcha-pro-open-b.aliyuncs.com", "device.captcha-open.aliyuncs.com",
  ];
  const recorder = createVerificationNetworkRecorder("51JOB");
  for (const value of hosts) recorder.request({}, `https://${value}:443/private?secret=1`, "script");
  assert.deepEqual(recorder.snapshot().requests.map(item => item.host), hosts);
  const rejected = [
    `http://${host}/`, `https://${host}:444/`, `https://user:password@${host}/`, `https://user@${host}/`,
    `https://${host}.attacker.test/`, `https://prefix-${host}/`, `https://captcha-pro-open.aliyuncs.com/`,
    `https://${host}./`, "https://127.0.0.1/", "https://jobs.51job.com/", "https://g.alicdn.com/", "not a URL",
  ];
  for (const value of rejected) recorder.request({}, value, "xhr");
  for (const type of ["websocket", "other", "media", "XHR", "xhr-secret"]) recorder.request({}, endpoint, type);
  assert.equal(recorder.snapshot().requests.length, 7);
  for (const platform of ["BOSS直聘", "猎聘", "LinkedIn", "51job", undefined]) {
    const other = createVerificationNetworkRecorder(platform);
    const request = {}; other.request(request, endpoint, "xhr"); other.response(request, 200); other.failed(request);
    assert.deepEqual(other.snapshot(), { requests: [], events: [], truncated: false });
  }
});

test("非法元数据及异常时钟不影响页面，时间保持非负整数及单调", () => {
  let time: number = 100;
  const recorder = createVerificationNetworkRecorder("51JOB", { now: () => { if (time === Infinity) throw new Error("secret-clock"); return time; } });
  const toxic = new Proxy({}, { get: () => { throw new Error("secret-coercion"); } });
  for (const value of [null, undefined, "string", 1]) recorder.request(value, endpoint, "xhr");
  assert.doesNotThrow(() => { recorder.request({}, toxic, "xhr"); recorder.request({}, endpoint, toxic); recorder.response(toxic, toxic); });
  const a = {}, b = {};
  time = 110.9; recorder.request(a, endpoint, "xhr");
  for (const status of [99, 600, 200.5, NaN, Infinity, "200", toxic]) recorder.response(a, status);
  time = 90; recorder.response(a, 100);
  time = Infinity; recorder.finished(a);
  time = NaN; recorder.request(b, endpoint, "fetch");
  time = 130.4; recorder.response(b, 599); recorder.failed(b);
  assert.deepEqual(recorder.snapshot().events.map(event => event.atMs), [10, 10, 10, 10, 30, 30]);
  assert.deepEqual(recorder.snapshot().events.flatMap(event => event.status === undefined ? [] : [event.status]), [100, 599]);
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /secret/);
});

test("诊断饱和时只截断记录，既有请求仍可完成且不超过固定容量", () => {
  const recorder = createVerificationNetworkRecorder("51JOB");
  const requests = Array.from({ length: 32 }, () => ({}));
  for (const request of requests) recorder.request(request, endpoint, "xhr");
  assert.equal(recorder.snapshot().truncated, false);
  const dropped = {};
  for (let i = 0; i < 500; i++) recorder.request(i ? {} : dropped, endpoint, "fetch");
  recorder.response(dropped, 200); recorder.finished(dropped);
  for (const request of requests) { recorder.response(request, 200); recorder.finished(request); }
  const value = recorder.snapshot();
  assert.equal(value.requests.length, 32);
  assert.equal(value.events.length, 96);
  assert.equal(value.truncated, true);
  assert.deepEqual(value.requests.map(item => item.id), Array.from({ length: 32 }, (_, i) => i + 1));
});

test("快照深拷贝，关闭清空且任何迟到事件或重入请求都不能复活", () => {
  const recorder = createVerificationNetworkRecorder("51JOB");
  const request = {};
  recorder.request(request, endpoint, "xhr");
  const first = recorder.snapshot();
  first.requests[0]!.host = "secret-attacker.test";
  first.events[0]!.requestId = 99;
  first.events.push({ requestId: 2, phase: "failed", atMs: 999 });
  first.truncated = true;
  const fresh = recorder.snapshot();
  assert.equal(fresh.requests[0]!.host, host);
  assert.equal(fresh.events.length, 1);
  assert.equal(fresh.events[0]!.requestId, 1);
  assert.equal(fresh.truncated, false);
  recorder.close(); recorder.close();
  recorder.response(request, 200); recorder.failed(request); recorder.finished(request);
  recorder.request({}, endpoint, "xhr");
  assert.deepEqual(recorder.snapshot(), { requests: [], events: [], truncated: false });
});

test("相对时间达到24小时上限后保持有限且不能回退", () => {
  let time = 0;
  const recorder = createVerificationNetworkRecorder("51JOB", { now: () => time });
  const request = {};
  recorder.request(request, endpoint, "xhr");
  time = 1e12; recorder.response(request, 200);
  time = 1; recorder.finished(request);
  assert.deepEqual(recorder.snapshot().events.map(event => event.atMs), [0, 86_400_000, 86_400_000]);
});

test("交错及无响应失败的真实生命周期仍通过客户端严格契约", () => {
  let time = 0;
  const recorder = createVerificationNetworkRecorder("51JOB", { now: () => time++ });
  const requests = Array.from({ length: 33 }, () => ({}));
  for (const request of requests) recorder.request(request, endpoint, "fetch");
  recorder.failed(requests[0]);
  recorder.response(requests[2], 200); recorder.finished(requests[2]);
  recorder.response(requests[1], 503); recorder.failed(requests[1]);
  const value = recorder.snapshot();
  assert.equal(value.truncated, true);
  assert.deepEqual(readVerificationNetworkSnapshot(value), value);
  recorder.close();
  assert.deepEqual(readVerificationNetworkSnapshot(recorder.snapshot()), { requests: [], events: [], truncated: false });
});
