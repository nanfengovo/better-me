/* eslint-disable @typescript-eslint/no-require-imports -- Native Electron smoke entrypoint. */
/**
 * Opt-in Electron restart acceptance for the isolated growth-loop UI lab.
 *
 * Start growth-loop-live.config.ts on 5316, build the desktop preload, then run:
 *   node apps/desktop/tests/growth-loop-smoke.cjs apps/desktop/dist
 *
 * This never launches BetterMe.app, a real account/profile, a provider, or career data.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const origin = "http://127.0.0.1:5316";
const entry = origin + "/tests/ui-lab/growth-loop-live.html?user=synthetic-growth-electron";
const token = "synthetic_growth_only_" + "x".repeat(43);
const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

if (!process.versions.electron) {
  assert.ok(process.argv[2], "explicit desktop dist is required");
  const dist = fs.realpathSync(process.argv[2]);
  const preload = path.join(dist, "preload/index.cjs");
  assert.ok(fs.statSync(preload).isFile(), "built preload is required");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-electron-growth-")));
  const env = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"])
    if (process.env[key]) env[key] = process.env[key];
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  for (const stage of ["run", "restore"]) {
    const child = require("node:child_process").spawnSync(require("electron"), [
      "--user-data-dir=" + path.join(directory, "userData"),
      "--crash-dumps-dir=" + path.join(directory, "crashDumps"),
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-breakpad",
      "--use-mock-keychain", "--password-store=basic", __filename,
      "--directory=" + directory, "--preload=" + preload, "--stage=" + stage,
    ], { env, cwd: directory, stdio: "inherit", timeout: 90000 });
    if (child.error) throw child.error;
    if (child.status !== 0) { process.exitCode = child.status ?? 1; break; }
  }
  console.log("BETTERME_GROWTH_ELECTRON_EVIDENCE " + directory);
} else {
  const { app, BrowserWindow, session, ipcMain } = require("electron");
  const directory = argument("--directory"), preload = argument("--preload"), stage = argument("--stage");
  assert.ok(directory && preload && ["run", "restore"].includes(stage));
  assert.ok(path.basename(directory).startsWith("betterme-electron-growth-") && fs.realpathSync(directory) === directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"), path.join(directory, "userData"));
  app.setName("betterme-growth-loop-smoke");
  app.disableHardwareAcceleration();
  for (const key of ["userData", "sessionData", "crashDumps", "logs"]) {
    const location = path.join(directory, key); fs.mkdirSync(location, { recursive: true }); app.setPath(key, location);
  }
  if (process.platform === "darwin") app.setActivationPolicy("accessory");

  const forbidden = [];
  const blockedUrls = [];
  let blockedRequests = 0;
  for (const method of ["spawn", "spawnSync", "exec", "execFile", "execFileSync", "fork"])
    require("node:child_process")[method] = () => { forbidden.push("child-process"); throw Error("outside isolated fixture"); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const qa = async () => {
    const response = await fetch(origin + "/__growth-loop-qa/state");
    assert.equal(response.status, 200); const data = await response.json();
    assert.ok(path.basename(data.directory).startsWith("betterme-growth-browser-"));
    assert.equal(data.externalModelCalls, 0);
    assert.ok(data.paths.every(value => /^\w+ \/api\/v1\/agent\/(?:identity\/|growth\/|tasks$)/.test(value)));
    return data;
  };

  async function run() {
    if (stage === "restore") {
      const restart = await fetch(origin + "/__growth-loop-qa/restart-host", { method: "POST" });
      const restartBody = await restart.text(); assert.equal(restart.status, 200, restartBody);
      const restarted = JSON.parse(restartBody); assert.ok(restarted.restarts >= 1);
    }
    const before = await qa();
    const existingPosts = before.paths.filter(value => value.startsWith("POST "));
    const s = session.defaultSession;
    s.setPermissionCheckHandler(() => false);
    s.setPermissionRequestHandler((_window, _permission, callback) => callback(false));
    s.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = url.origin === origin || ["about:", "data:", "blob:"].includes(url.protocol);
      if (!allowed) { blockedRequests++; blockedUrls.push(details.url); }
      callback({ cancel: !allowed });
    });
    ipcMain.handle("desktop:get-agent-info", () => ({ endpoint: origin, port: 5316, token }));
    ipcMain.handle("desktop:open-external", () => { forbidden.push("external-navigation"); throw Error("outside isolated fixture"); });
    const window = new BrowserWindow({ show: false, width: 1440, height: 1100,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const evaluate = async source => {
      try { return await window.webContents.executeJavaScript(source, true); }
      catch (error) { throw Error("renderer evaluation failed for " + source + ": " + String(error)); }
    };
    const until = async source => {
      for (let attempt = 0; attempt < 600; attempt++) { if (await evaluate(source)) return; await pause(25); }
      throw Error("growth UI condition failed: " + source + "\n" + await evaluate("document.body.innerText"));
    };
    const click = async testId => {
      const selector = JSON.stringify(`[data-testid="${testId}"]`);
      await until(`Boolean(document.querySelector(${selector})&&!document.querySelector(${selector}).disabled)`);
      await evaluate(`document.querySelector(${selector}).click()`);
    };
    const fill = async (name, value) => {
      const selector = JSON.stringify(`[name="${name}"]`);
      await until(`Boolean(document.querySelector(${selector}))`);
      await evaluate(`(()=>{const e=document.querySelector(${selector});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const publicState = () => evaluate(`(async()=>{
      const authorization='Bearer '+window.__BETTER_ME_RUNTIME__.agentToken;
      const session=await(await fetch('/api/v1/agent/identity/session',{headers:{Authorization:authorization}})).json();
      const headers={Authorization:authorization,'X-BetterMe-Owner':session.principal.id};
      const list=await(await fetch('/api/v1/agent/growth/journeys',{headers})).json();
      const journey=list.journeys[0]?await(await fetch('/api/v1/agent/growth/journeys/'+list.journeys[0].id,{headers})).json():null;
      const tasks=await(await fetch('/api/v1/agent/tasks',{headers})).json();
      return {ownerId:session.principal.id,list:list.journeys,journey:journey?.journey,tasks:tasks.tasks};
    })()`);

    await window.loadURL(entry);
    await until("Boolean(document.querySelector('[aria-label=\"\u4e2a\u4eba\u6210\u957f\u95ed\u73af\"]'))");
    assert.equal(await evaluate("window.__BETTER_ME_DESKTOP__"), true);
    assert.equal(await evaluate("typeof window.desktopApi.getAgentHostInfo"), "function", "the installed preload API is present");

    if (stage === "run") {
      await until("Boolean(document.querySelector('[data-testid=\"growth-create\"]'))");
      assert.equal((await publicState()).list.length, 0);
      await fill("growth-goal", "Electron 重启后继续合成成长项目");
      await click("growth-create"); await until("Boolean(document.querySelector('[data-testid=\"growth-source\"]'))");
      await click("growth-source"); await until("Boolean(document.querySelector('[data-testid=\"growth-example\"]'))");
      await click("growth-example"); await click("growth-submit");
      await until("Boolean(document.querySelector('[data-testid=\"growth-step\"]'))");
      await click("growth-step"); await until("document.body.textContent.includes('lookup \u8c03\u7528 1 \u6b21')");
      const state = await publicState();
      assert.equal(state.list.length, 1); assert.equal(state.journey.stage, "checkpoint_saved");
      assert.equal(state.journey.task.practice.phase, "lookup_saved");
      assert.equal(state.journey.task.practice.checkpoint.lookupCalls, 1);
      assert.deepEqual(state.tasks, [], "synthetic growth tasks stay outside the career task directory");
      const after = await qa(); const posts = after.paths.filter(value => value.startsWith("POST "));
      assert.equal(posts.length, existingPosts.length + 5, "register, create and three explicit commands only");
      const checkpoint = { hostDirectory: after.directory, ownerId: state.ownerId, journeyId: state.journey.id,
        lookupCalls: 1, postPaths: posts, journey: state.journey };
      fs.writeFileSync(path.join(directory, "checkpoint.json"), JSON.stringify(checkpoint, null, 2) + "\n");
      fs.writeFileSync(path.join(directory, "electron-checkpoint.png"), (await window.capturePage()).toPNG());
    } else {
      const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, "checkpoint.json"), "utf8"));
      assert.equal(before.directory, checkpoint.hostDirectory);
      await until("document.body.textContent.includes('\u5df2\u6062\u590d\u8bb0\u5f55\uff0c\u672a\u91cd\u65b0\u6267\u884c')");
      await until("document.body.textContent.includes('lookup \u8c03\u7528 1 \u6b21')");
      let state = await publicState(); let after = await qa();
      assert.equal(state.ownerId, checkpoint.ownerId); assert.equal(state.journey.id, checkpoint.journeyId);
      assert.equal(state.journey.stage, "checkpoint_saved"); assert.equal(state.journey.task.practice.checkpoint.lookupCalls, 1);
      assert.deepEqual(state.tasks, []);
      assert.deepEqual(after.paths.filter(value => value.startsWith("POST ")), checkpoint.postPaths,
        "process and Host restart perform GET-only restoration");
      fs.writeFileSync(path.join(directory, "electron-restored.png"), (await window.capturePage()).toPNG());

      await click("growth-step"); await until("document.body.textContent.includes('\u56fa\u5b9a\u9a8c\u6536 4/4')");
      await click("growth-accept"); await until("document.body.textContent.includes('\u5408\u6210\u9879\u76ee\u5df2\u9a8c\u6536')&&document.body.textContent.includes('\u5f85\u9694\u65f6\u590d\u6d4b')");
      state = await publicState(); after = await qa();
      assert.equal(state.journey.stage, "completed"); assert.equal(state.journey.task.practice.phase, "verified");
      assert.equal(state.journey.task.practice.checkpoint.lookupCalls, 1);
      assert.equal(state.journey.task.practice.verification.passed, 4); assert.equal(state.journey.task.practice.verification.total, 4);
      assert.equal(state.journey.task.practice.verification.checks.every(check => check.passed), true);
      assert.equal(state.journey.project.scope, "synthetic_practice"); assert.equal(state.journey.project.mastery, "pending_retest");
      assert.deepEqual(state.tasks, []); assert.equal(after.externalModelCalls, 0);
      fs.writeFileSync(path.join(directory, "electron-completed.png"), (await window.capturePage()).toPNG());
      fs.writeFileSync(path.join(directory, "completed.json"), JSON.stringify({ ownerId: state.ownerId, journey: state.journey,
        postPaths: after.paths.filter(value => value.startsWith("POST ")), hostRestarts: after.restarts }, null, 2) + "\n");
    }

    await window.webContents.session.flushStorageData(); await s.cookies.flushStore();
    assert.deepEqual(forbidden, []);
    assert.ok(blockedUrls.every(value => !value.startsWith(origin)), "only non-fixture requests may be blocked");
    const after = await qa();
    const summary = { stage, evidenceDirectory: directory, sourceReact: true, fullElectronRestart: true,
      hostRestarts: after.restarts, installedPreloadHash: hash(fs.readFileSync(preload)), profileIsolated: true,
      lookupCalls: 1, externalModelCalls: after.externalModelCalls, blockedRequests, blockedUrls };
    fs.writeFileSync(path.join(directory, stage + "-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log("BETTERME_GROWTH_ELECTRON " + JSON.stringify(summary));
    window.destroy();
  }

  const fail = error => { console.error("BETTERME_GROWTH_ELECTRON_FAILED", error); app.exit(1); };
  const timer = setTimeout(() => fail(Error("growth Electron smoke timeout")), 85000);
  app.whenReady().then(run).then(() => { clearTimeout(timer); app.exit(0); }, fail);
}
