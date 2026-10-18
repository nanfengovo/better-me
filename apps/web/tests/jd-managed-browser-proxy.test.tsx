import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createManagedDomesticBrowserProxyVerifier, type ManagedProxyEvidence, type ManagedProxyMachine } from "../server/jd-managed-browser-proxy.ts";

const root = "E:/owned-fixture";
const directory = path.join(root, "data/domestic-route");
const executable = path.join(directory, "mihomo-windows-amd64-compatible.exe");
const configuration = path.join(directory, "config.yaml");
const script = await readFile(new URL("../../../scripts/domestic-route.ps1", import.meta.url), "utf8");
const template = script.match(/function Write-Configuration\([\s\S]*?\$text = @"\r?\n([\s\S]*?)\r?\n"@/)?.[1];
assert.ok(template);
const config = Buffer.from(template.replaceAll("\r\n", "\n").replaceAll("$LocalPort", "17891").replaceAll("$yamlName", "WLAN").replaceAll("$dnsInterface", "WLAN") + "\n");
const configSha = "ab39c59d8efe8669239223e227225fed3481c006172ec27762f1106e9704caac";
const deviceConfigSha = "a7d2077ad17bb260f326b4a247d37d787d92959d887fe531399e7302d040ec0e";
const cdnConfigSha = "4cacb8a8a0a4d8b950c3d34fe93c99b4d7a15e667fa89688b17113c143af52c2";
const serviceConfigSha = "17049bdecd3d6f5841c3053ad0f6893a9699a486f86ff4433dd5acb5e90b5d35";
const previousConfigSha = "a7496d824b1baaed6819ea20ee81cf2cb62f600dd42fe30df13d923d175aa796";
const oldConfigSha = "8e6e058ad96c76a3099656112aa38b1ed3ffa6fb054cbdfc1499fcb977a4e1d8";
const componentRule = (host: string) => `  - AND,((DOMAIN,${host}),(DST-PORT,443)),DIRECT\n`;
const tenantVerifyHosts = [
  "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com",
  "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com",
];
const withoutTenantVerifyRules = (text: string) => tenantVerifyHosts.reduce((remaining, host) => remaining.replace(componentRule(host), ""), text);
const deviceHost = "device.captcha-open.aliyuncs.com";
const withoutDeviceRule = (text: string) => withoutTenantVerifyRules(text).replace(componentRule(deviceHost), "");
const newestCdnHosts = ["g.alicdn.com", "x.alicdn.com"];
const withoutNewestCdnRules = (text: string) => newestCdnHosts.reduce((remaining, host) => remaining.replace(componentRule(host), ""), text);
const serviceHosts = [
  "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com",
  "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com",
  "upload.captcha-pro-open.aliyuncs.com",
  "upload.captcha-pro-open-b.aliyuncs.com",
];
const withoutServiceRules = (text: string) => serviceHosts.reduce((remaining, host) => remaining.replace(componentRule(host), ""), text);
function fixture() {
  const evidence: ManagedProxyEvidence = {
    config, configModifiedAt: Date.parse("2026-10-17T09:52:37Z"), identity: "unchanged-stat-identities",
    executableSha256: "04f8d7fc2b314771e1ecbf15951d59f0e1cb7914503c88cfb6972ff6a824e314",
    state: { processId: 1234, port: 17891, interfaceName: "WLAN", interfaceIndex: 14, startedAt: "2026-10-17T09:52:45Z" },
    manifest: { createdAt: "2026-10-17T09:51:15Z", activatedAt: "2026-10-17T09:53:32Z", activeProcessId: 1234, candidateSha256: configSha, engineValidation: "passed_exit_0", activeConfigurationChanged: true },
  };
  const machine: ManagedProxyMachine = {
    process: { processId: 1234, createdAt: "2026-10-17T09:52:40Z", executable, command: `"${executable}" -d "${directory}" -f "${configuration}" ` },
    listeners: [{ processId: 1234, address: "127.0.0.1", port: 17891 }],
  };
  let reads = 0, machines = 0;
  let after: (() => void) | undefined;
  const verify = createManagedDomesticBrowserProxyVerifier({ rootDirectory: root, readEvidence: async () => { reads++; return structuredClone(evidence); }, readMachine: async (id) => { machines++; assert.equal(id, 1234); const snapshot = structuredClone(machine); after?.(); return snapshot; } });
  return { evidence, machine, verify, after: (value: () => void) => { after = value; }, get reads() { return reads; }, get machines() { return machines; } };
}

test("only the exact managed endpoint is accepted, with unchanged official executable, state, manifest and owned listener", async () => {
  const f = fixture();
  for (const proxy of [undefined, "http://127.0.0.1:7890", "http://localhost:17891", "http://127.0.0.1:17891/", "https://127.0.0.1:17891", "http://user:pass@127.0.0.1:17891", "http://127.0.0.1:17891?bypass=*"]) assert.equal(await f.verify(proxy), false);
  assert.equal(f.reads, 0);
  assert.equal(await f.verify("http://127.0.0.1:17891"), true);
  assert.equal(f.reads, 2); assert.equal(f.machines, 1);
});

test("a reused PID, wrong executable/argv, external listener or other port owner cannot attest the helper", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.machine.process!.createdAt = "2026-10-17T10:00:00Z"; },
    f => { f.machine.process!.createdAt = "2026-10-17T09:00:00Z"; },
    f => { f.machine.process!.executable = "C:/elsewhere/mihomo.exe"; },
    f => { f.machine.process!.command += " --external-controller 127.0.0.1:9999"; },
    f => { f.machine.process!.command = f.machine.process!.command.replace("config.yaml", "broader.yaml"); },
    f => { f.machine.process = undefined; },
    f => { f.machine.listeners[0].processId = 9999; },
    f => { f.machine.listeners[0].address = "0.0.0.0"; },
    f => { f.machine.listeners.push({ processId: 1234, address: "::", port: 17891 }); },
    f => { f.machine.listeners = []; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(await f.verify("http://127.0.0.1:17891"), false); }
});

test("broader domains, ports, bypasses and rule changes fail even if the editable manifest claims them", async () => {
  for (const changed of [
    config.toString().replace("MATCH,REJECT", "MATCH,DIRECT"),
    config.toString().replace("rules:\n", "rules:\n  - DOMAIN-SUFFIX,example.com,DIRECT\n"),
    config.toString().replace("DST-PORT,443", "DST-PORT,80"),
    config.toString() + "skip-proxy:\n  - '*'\n",
    config.toString().replace("external-controller: ''", "external-controller: '127.0.0.1:9090'"),
  ]) {
    const f = fixture(); f.evidence.config = Buffer.from(changed);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = createHash("sha256").update(changed).digest("hex");
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.evidence.executableSha256 = "0".repeat(64); },
    (f: ReturnType<typeof fixture>) => { (f.evidence.manifest as Record<string, unknown>).activeProcessId = 9999; },
    (f: ReturnType<typeof fixture>) => { (f.evidence.manifest as Record<string, unknown>).engineValidation = "unknown"; },
    (f: ReturnType<typeof fixture>) => { (f.evidence.state as Record<string, unknown>).interfaceName = "different"; },
    (f: ReturnType<typeof fixture>) => { f.evidence.configModifiedAt = Date.parse("2026-10-17T10:00:00Z"); },
  ]) { const f = fixture(); mutate(f); assert.equal(await f.verify("http://127.0.0.1:17891"), false); }
});

test("each observed 51JOB component rule remains an exact host on 443 and cannot be broadened or removed", async () => {
  assert.equal(createHash("sha256").update(config).digest("hex"), configSha);
  for (const host of ["img.alicdn.com", "o.alicdn.com", ...newestCdnHosts]) {
    const rule = componentRule(host);
    assert.equal(config.toString().split(rule).length, 2, `${host}: one reviewed rule`);
    for (const replacement of [
      rule.replace(`DOMAIN,${host}`, "DOMAIN-SUFFIX,alicdn.com"),
      rule.replace(`DOMAIN,${host}`, `DOMAIN-SUFFIX,${host}`),
      rule.replace(host, "unobserved.alicdn.com"),
      rule.replace("DST-PORT,443", "DST-PORT,80"),
      rule.replace("DST-PORT,443", "DST-PORT,8443"),
      `  - DOMAIN,${host},DIRECT\n`,
      "",
    ]) {
      const changed = config.toString().replace(rule, replacement);
      assert.notEqual(changed, config.toString());
      for (const claimedSha of [configSha, createHash("sha256").update(changed).digest("hex")]) {
        const f = fixture();
        f.evidence.config = Buffer.from(changed);
        (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
        assert.equal(await f.verify("http://127.0.0.1:17891"), false, `${host}: ${replacement.trim() || "removed"}`);
        assert.equal(f.machines, 0);
      }
    }
  }
});

test("the historical configuration cannot attest the new helper even with a matching or forged manifest", async () => {
  const oldConfig = withoutServiceRules(withoutNewestCdnRules(withoutDeviceRule(config.toString()))).replace(componentRule("img.alicdn.com"), "").replace(componentRule("o.alicdn.com"), "");
  assert.equal(createHash("sha256").update(oldConfig).digest("hex"), oldConfigSha);
  for (const claimedSha of [oldConfigSha, configSha]) {
    const f = fixture();
    f.evidence.config = Buffer.from(oldConfig);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  const f = fixture();
  (f.evidence.manifest as Record<string, unknown>).candidateSha256 = oldConfigSha;
  assert.equal(await f.verify("http://127.0.0.1:17891"), false);
  assert.equal(f.machines, 0);
});

test("each observed 51JOB verification service rule rejects parent domains, siblings, extra ports and removal", async () => {
  assert.equal(config.length, 2253);
  assert.equal(createHash("sha256").update(config).digest("hex"), configSha);
  for (const host of [...serviceHosts, ...tenantVerifyHosts]) {
    const rule = componentRule(host);
    const parent = host.slice(host.indexOf(".") + 1);
    assert.equal(config.toString().split(rule).length, 2, `${host}: one reviewed rule`);
    for (const replacement of [
      rule.replace(`DOMAIN,${host}`, "DOMAIN-SUFFIX,aliyuncs.com"),
      rule.replace(`DOMAIN,${host}`, `DOMAIN-SUFFIX,${parent}`),
      rule.replace(`DOMAIN,${host}`, `DOMAIN-SUFFIX,${host}`),
      rule.replace(host, `unobserved.${parent}`),
      rule.replace("DST-PORT,443", "DST-PORT,80"),
      rule.replace("DST-PORT,443", "DST-PORT,8443"),
      `  - DOMAIN,${host},DIRECT\n`,
      "",
    ]) {
      const changed = config.toString().replace(rule, replacement);
      assert.notEqual(changed, config.toString());
      for (const claimedSha of [configSha, createHash("sha256").update(changed).digest("hex")]) {
        const f = fixture();
        f.evidence.config = Buffer.from(changed);
        (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
        assert.equal(await f.verify("http://127.0.0.1:17891"), false, `${host}: ${replacement.trim() || "removed"}`);
        assert.equal(f.machines, 0);
      }
    }
  }
});

test("the checkpoint54 configuration cannot attest the new verification service pin with a matching or forged manifest", async () => {
  const previousConfig = withoutServiceRules(withoutNewestCdnRules(withoutDeviceRule(config.toString())));
  assert.equal(Buffer.byteLength(previousConfig), 1479);
  assert.equal(createHash("sha256").update(previousConfig).digest("hex"), previousConfigSha);
  for (const claimedSha of [previousConfigSha, configSha]) {
    const f = fixture();
    f.evidence.config = Buffer.from(previousConfig);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  const f = fixture();
  (f.evidence.manifest as Record<string, unknown>).candidateSha256 = previousConfigSha;
  assert.equal(await f.verify("http://127.0.0.1:17891"), false);
  assert.equal(f.machines, 0);
});

test("the checkpoint56 configuration cannot attest the newest CDN pin with a matching or forged manifest", async () => {
  const serviceConfig = withoutNewestCdnRules(withoutDeviceRule(config.toString()));
  assert.equal(Buffer.byteLength(serviceConfig), 1847);
  assert.equal(createHash("sha256").update(serviceConfig).digest("hex"), serviceConfigSha);
  for (const claimedSha of [serviceConfigSha, configSha]) {
    const f = fixture();
    f.evidence.config = Buffer.from(serviceConfig);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  const f = fixture();
  (f.evidence.manifest as Record<string, unknown>).candidateSha256 = serviceConfigSha;
  assert.equal(await f.verify("http://127.0.0.1:17891"), false);
  assert.equal(f.machines, 0);
});

test("the observed device verification rule rejects parent, child and sibling hosts, credentials, ports and removal", async () => {
  assert.equal(config.length, 2253);
  assert.equal(createHash("sha256").update(config).digest("hex"), configSha);
  const rule = componentRule(deviceHost);
  assert.equal(config.toString().split(rule).length, 2);
  for (const replacement of [
    rule.replace(`DOMAIN,${deviceHost}`, "DOMAIN-SUFFIX,captcha-open.aliyuncs.com"),
    rule.replace(deviceHost, "captcha-open.aliyuncs.com"),
    rule.replace(`DOMAIN,${deviceHost}`, `DOMAIN-SUFFIX,${deviceHost}`),
    rule.replace(deviceHost, `extra.${deviceHost}`),
    rule.replace(deviceHost, "unobserved.captcha-open.aliyuncs.com"),
    rule.replace(deviceHost, `user:secret@${deviceHost}`),
    rule.replace("DST-PORT,443", "DST-PORT,80"),
    rule.replace("DST-PORT,443", "DST-PORT,8443"),
    `  - DOMAIN,${deviceHost},DIRECT\n`,
    "",
  ]) {
    const changed = config.toString().replace(rule, replacement);
    assert.notEqual(changed, config.toString());
    for (const claimedSha of [configSha, createHash("sha256").update(changed).digest("hex")]) {
      const f = fixture();
      f.evidence.config = Buffer.from(changed);
      (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
      assert.equal(await f.verify("http://127.0.0.1:17891"), false, replacement.trim() || "removed");
      assert.equal(f.machines, 0);
    }
  }
});

test("the checkpoint57 configuration cannot attest the device pin with a matching or forged manifest", async () => {
  const cdnConfig = withoutDeviceRule(config.toString());
  assert.equal(Buffer.byteLength(cdnConfig), 1955);
  assert.equal(createHash("sha256").update(cdnConfig).digest("hex"), cdnConfigSha);
  for (const claimedSha of [cdnConfigSha, configSha]) {
    const f = fixture();
    f.evidence.config = Buffer.from(cdnConfig);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  const f = fixture();
  (f.evidence.manifest as Record<string, unknown>).candidateSha256 = cdnConfigSha;
  assert.equal(await f.verify("http://127.0.0.1:17891"), false);
  assert.equal(f.machines, 0);
});

test("the checkpoint58 device config cannot attest the tenant verification pin even with a matching or forged manifest", async () => {
  const deviceConfig = withoutTenantVerifyRules(config.toString());
  assert.equal(Buffer.byteLength(deviceConfig), 2029);
  assert.equal(createHash("sha256").update(deviceConfig).digest("hex"), deviceConfigSha);
  for (const claimedSha of [deviceConfigSha, configSha]) {
    const f = fixture(); f.evidence.config = Buffer.from(deviceConfig);
    (f.evidence.manifest as Record<string, unknown>).candidateSha256 = claimedSha;
    assert.equal(await f.verify("http://127.0.0.1:17891"), false);
    assert.equal(f.machines, 0);
  }
  const f = fixture();
  (f.evidence.manifest as Record<string, unknown>).candidateSha256 = deviceConfigSha;
  assert.equal(await f.verify("http://127.0.0.1:17891"), false); assert.equal(f.machines, 0);
});

test("a config or process record changed during the machine check fails and read errors never escape as sensitive details", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.evidence.identity = "changed"; },
    (f: ReturnType<typeof fixture>) => { f.evidence.config = Buffer.from("MATCH,DIRECT"); },
    (f: ReturnType<typeof fixture>) => { (f.evidence.state as Record<string, unknown>).startedAt = "2026-10-17T10:00:00Z"; },
  ]) { const f = fixture(); f.after(() => mutate(f)); assert.equal(await f.verify("http://127.0.0.1:17891"), false); }
  const failed = createManagedDomesticBrowserProxyVerifier({ readEvidence: async () => { throw new Error("PRIVATE_CONFIGURATION_DETAIL"); } });
  assert.equal(await failed("http://127.0.0.1:17891"), false);
});
