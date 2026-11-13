/* eslint-disable @typescript-eslint/no-require-imports -- Electron entrypoints execute as native CommonJS. */
/** Opt-in Electron end-to-end/restart acceptance against the isolated real HTTP lab.
 * Start free-chat-live.config.ts with tsx on 5296, then:
 * node apps/desktop/tests/mock-interview-smoke.cjs '/explicit/app/dist'
 * Uses the supplied production preload, real React/clients and a temporary authenticated
 * Host with scripted answers. Does not launch BetterMe.app or its main/profile/services.
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const origin = "http://127.0.0.1:5296", entry = origin + "/tests/ui-lab/free-chat-live.html?pane=interview";
const argument = name => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1);
const hash = value => createHash("sha256").update(value).digest("hex");
const ordinaryDraft = "Electron 顾问独立未发送草稿：只参与测试，不认领上线。";
const answerOne = "合成作答一：我编写设备告警接口输入校验与回归测试，没有证据确认生产指标。\n"
  + "逐项核对异常入参和回执，未验证的范围明确留空。🙂\n".repeat(96) + "完整作答尾标：END-ONE-🙂-原文保留";
const answerTwo = "合成作答二：重复请求需要按实际回执核对；我没有核实异常重试和生产恢复，不能把设计方案当成已经上线。\n完整作答尾标：END-TWO-🙂";
const taskWrites = state => state.paths.filter(value => value.startsWith("POST /api/v1/agent/tasks"));

if (!process.versions.electron) {
  assert.ok(process.argv[2], "supply the explicit compiled app/dist; do not launch the user app");
  const dist = fs.realpathSync(process.argv[2]), preload = path.join(dist, "preload/index.cjs");
  assert.ok(fs.statSync(preload).isFile());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-electron-interview-")));
  const env = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"])
    if (process.env[key]) env[key] = process.env[key];
  for (const stage of ["seed", "answer", "verify"]) {
    const child = require("node:child_process").spawnSync(require("electron"), [
      "--user-data-dir=" + path.join(dir, "userData"), "--crash-dumps-dir=" + path.join(dir, "crashDumps"),
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-breakpad",
      "--use-mock-keychain", "--password-store=basic", __filename,
      "--fixture-dir=" + dir, "--fixture-preload=" + preload, "--stage=" + stage,
    ], { env, cwd: dir, stdio: "inherit", timeout: 45000 });
    if (child.error) throw child.error;
    if (child.status !== 0) { process.exitCode = child.status ?? 1; break; }
  }
} else {
  const { app, BrowserWindow, session, ipcMain } = require("electron");
  const dir = argument("--fixture-dir"), preload = argument("--fixture-preload"), stage = argument("--stage");
  assert.ok(dir && preload && ["seed", "answer", "verify"].includes(stage));
  assert.ok(path.basename(dir).startsWith("betterme-electron-interview-") && fs.realpathSync(dir) === dir);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"), path.join(dir, "userData"));
  const checkpointFile = path.join(dir, "checkpoint.json"), receiptFile = path.join(dir, "complete-record.json");
  app.setName("betterme-interview-smoke"); app.disableHardwareAcceleration();
  for (const key of ["userData", "sessionData", "crashDumps", "logs"]) {
    const location = path.join(dir, key); fs.mkdirSync(location, { recursive: true }); app.setPath(key, location);
  }
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const forbidden = []; let blockedRequests = 0;
  for (const operation of ["spawn", "spawnSync", "exec", "execFile", "execFileSync", "fork"])
    require("node:child_process")[operation] = () => { forbidden.push("unexpected-child"); throw Error("outside fixture"); };
  async function state() {
    const response = await fetch(origin + "/__free-chat-qa/state", { signal: AbortSignal.timeout(4000), redirect: "error" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(path.basename(data.directory).startsWith("betterme-free-chat-browser-") && Array.isArray(data.paths));
    assert.ok(data.phases.every(phase => phase === "mock_interview"), "no unrelated model phase may run");
    assert.ok(!data.paths.some(route => /POST .*\/(?:chat\/respond|routing\/respond|jd-match\/start|understanding\/start)/.test(route)));
    return data;
  }
  const readCheckpoint = () => JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
  async function run() {
    const before = await state();
    if (stage === "seed") { assert.equal(before.modelCalls, 0); assert.equal(taskWrites(before).length, 0); }
    else {
      const previous = readCheckpoint();
      assert.equal(before.directory, previous.directory);
      assert.equal(before.modelCalls, stage === "answer" ? 1 : 4);
      assert.deepEqual(taskWrites(before), previous.writes);
    }
    const s = session.defaultSession;
    s.setPermissionCheckHandler(() => false); s.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    s.webRequest.onBeforeRequest((details, cb) => {
      const target = new URL(details.url), allowed = target.origin === origin || ["about:", "data:", "blob:"].includes(target.protocol);
      if (!allowed) blockedRequests++; cb({ cancel: !allowed });
    });
    ipcMain.handle("desktop:get-agent-info", () => ({ endpoint: origin, port: 5296, token: "synthetic_free_chat_only_" + "q".repeat(43) }));
    ipcMain.handle("desktop:open-external", () => { forbidden.push("external-navigation"); throw Error("outside fixture"); });
    ipcMain.handle("desktop:toggle-hud", () => { forbidden.push("unexpected-hud"); throw Error("outside fixture"); });
    const w = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    w.webContents.setWindowOpenHandler(() => { forbidden.push("unexpected-window"); return { action: "deny" }; });
    w.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== origin) { forbidden.push("external-navigation"); event.preventDefault(); } });
    const evaluate = source => w.webContents.executeJavaScript(source);
    async function waitFor(source, label = source) {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (await evaluate(source)) return;
        await sleep(70);
      }
      const observed = await evaluate('({alerts:[...document.querySelectorAll("[role=alert]")].map(node=>node.textContent),statuses:[...document.querySelectorAll(".mock-interview [role=status]")].map(node=>node.textContent)})');
      throw Error("interview UI did not reach: " + label + "; observed=" + JSON.stringify(observed));
    }
    const visibleButton = label => `[...document.querySelectorAll("button")].find(button=>button.getClientRects().length && button.textContent.trim()===${JSON.stringify(label)})`;
    async function click(label) {
      const source = visibleButton(label);
      await waitFor(`Boolean(${source} && !${source}.disabled)`, label);
      await evaluate(`${source}.click()`);
    }
    async function fill(selector, content) {
      await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,${JSON.stringify(content)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), content);
    }
    const assertCalls = async count => { const current = await state(); assert.equal(current.modelCalls, count); assert.equal(current.adapterBuilds, 1); return current; };
    async function saveStorage() { s.flushStorageData(); await s.cookies.flushStore(); }
    await w.loadURL(entry + (stage === "seed" ? "" : "#advisor"));
    await waitFor('window.desktopApi?.isElectron===true && !!document.querySelector(".agent-workspace, .mock-interview, .agent-chat-textarea")', "React and production preload");
    assert.equal(await evaluate('(async()=> (await window.desktopApi.getAgentHostInfo()).port)()'), 5296);
    if (stage === "seed") {
      await waitFor('[...document.querySelectorAll("button")].some(button=>button.textContent.trim().startsWith("面试攻防防御"))');
      await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.trim().startsWith("面试攻防防御")).click()');
      await click("与 Copilot 模拟对练这道题 →");
      await waitFor('!!document.querySelector(".mock-interview")');
      assert.equal((await state()).modelCalls, 0); assert.equal(taskWrites(await state()).length, 0);
      await click("返回顾问"); await waitFor('!document.querySelector(".mock-interview")');
      await fill(".agent-chat-textarea", ordinaryDraft);
      await click("回到对练会话");
      await waitFor('!!document.querySelector(".mock-interview input[type=checkbox]") && !document.querySelector(".mock-interview input[type=checkbox]").disabled');
      assert.equal(await evaluate('document.querySelector(".mock-interview input[type=checkbox]").checked'), false);
      await evaluate('document.querySelector(".mock-interview input[type=checkbox]").click()');
      await click("授权并开始对练");
      await waitFor('document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("awaiting_answer")');
      await fill(".mock-interview textarea", answerOne);
      assert.ok(await evaluate(`${visibleButton("结束演练并生成回执")}.disabled`), "finish must not discard a draft");
      const data = await assertCalls(1);
      const ids = await evaluate('(()=>{const text=[...document.querySelectorAll(".mock-interview details")].find(node=>node.querySelector("summary")?.textContent==="任务关系与完整证据").textContent;return {id:text.match(/任务 (ct_[a-f0-9]+)/)[1],parent:text.match(/JD父任务 (ct_[a-f0-9]+)/)[1],root:text.match(/共享根 (ct_[a-f0-9]+)/)[1]};})()');
      assert.equal(ids.parent, ids.root);
      fs.writeFileSync(checkpointFile, JSON.stringify({ ...ids, directory: data.directory, writes: taskWrites(data), draftHash: hash(answerOne) }, null, 2));
      await saveStorage(); console.log("BETTERME_ELECTRON_INTERVIEW_STAGE " + JSON.stringify({ stage, modelCalls: data.modelCalls, taskWrites: taskWrites(data).length, draftHash: hash(answerOne) }));
    } else if (stage === "answer") {
      await waitFor('document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("awaiting_answer")');
      assert.equal(await evaluate('document.querySelector(".mock-interview textarea").value'), answerOne);
      assert.equal(await evaluate('document.querySelector(".mock-interview input[type=checkbox]").checked'), false);
      assert.ok(await evaluate(`${visibleButton("提交回答并追问")}.disabled`));
      const restored = await assertCalls(1); assert.deepEqual(taskWrites(restored), before.paths.filter(value => value.startsWith("POST /api/v1/agent/tasks")));
      await click("返回顾问"); await waitFor('!document.querySelector(".mock-interview")');
      assert.equal(await evaluate('document.querySelector(".agent-chat-textarea").value'), ordinaryDraft);
      await click("回到对练会话");
      await waitFor('!!document.querySelector(".mock-interview input[type=checkbox]") && !document.querySelector(".mock-interview input[type=checkbox]").disabled');
      await evaluate('document.querySelector(".mock-interview input[type=checkbox]").click()');
      await click("提交回答并追问");
      await waitFor('document.querySelectorAll(".mock-interview-thread article[data-role=user]").length===1 && document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("awaiting_answer")');
      await assertCalls(2);
      assert.equal(await evaluate('document.querySelector(".mock-interview textarea").value'), "");
      await fill(".mock-interview textarea", answerTwo); await click("提交回答并追问");
      await waitFor('document.querySelectorAll(".mock-interview-thread article[data-role=user]").length===2 && document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("awaiting_answer")');
      await assertCalls(3); await click("结束演练并生成回执");
      await waitFor('!!document.querySelector("[aria-label=面试攻防评估回执]") && document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("completed")');
      const data = await assertCalls(4), previous = readCheckpoint();
      const download = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("complete record download timed out")), 8000);
        s.once("will-download", (_event, item) => {
          assert.ok(item.getURL().startsWith("blob:" + origin)); assert.equal(item.getFilename(), "BetterMe-面试攻防评估记录.json");
          item.setSavePath(receiptFile);
          item.once("done", (_event, status) => { clearTimeout(timeout); if (status === "completed") resolve(); else reject(Error("download: " + status)); });
        });
      });
      await click("下载完整记录"); await download;
      const record = JSON.parse(fs.readFileSync(receiptFile, "utf8")), task = record.task;
      assert.equal(task.id, previous.id); assert.equal(task.parentTaskId, previous.parent); assert.equal(task.rootTaskId, previous.root);
      assert.equal(task.rootLedger.usage.modelCalls, 4); assert.equal(task.status, "completed");
      assert.deepEqual(task.conversation.messages.filter(message => message.role === "user").map(message => message.content), [answerOne, answerTwo]);
      assert.deepEqual(task.interview.receipt.answers.map(answer => answer.quote), [answerOne, answerTwo]);
      assert.equal(record.selection.matching.rawJd, "岗位要求\n了解 C# 与 .NET 接口测试。\n能核对测试环境行为。");
      assert.equal(record.draft, ""); assert.ok(!record.pending);
      const evidenceText = JSON.stringify(task.evidence); assert.ok(evidenceText.includes("END-ONE-🙂-原文保留") && evidenceText.includes("END-TWO-🙂"));
      await evaluate('[...document.querySelectorAll(".mock-interview details")].find(node=>node.querySelector("summary")?.textContent==="任务关系与完整证据").open=true');
      assert.ok(await evaluate('document.querySelector(".mock-interview-scroll").textContent.includes("END-ONE-🙂-原文保留")'));
      const receiptText = await evaluate('document.querySelector("[aria-label=面试攻防评估回执]").textContent');
      assert.ok(receiptText.includes("END-ONE-🙂-原文保留") && receiptText.includes("END-TWO-🙂"));
      fs.writeFileSync(checkpointFile, JSON.stringify({ ...previous, writes: taskWrites(data), receiptHash: hash(receiptText), completeRecordHash: hash(fs.readFileSync(receiptFile)) }, null, 2));
      await saveStorage(); console.log("BETTERME_ELECTRON_INTERVIEW_STAGE " + JSON.stringify({ stage, modelCalls: 4, adapterBuilds: 1, answers: 2, completeRecordHash: hash(fs.readFileSync(receiptFile)) }));
    } else {
      await waitFor('!!document.querySelector("[aria-label=面试攻防评估回执]") && document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("completed")');
      const previous = readCheckpoint();
      assert.equal(hash(await evaluate('document.querySelector("[aria-label=面试攻防评估回执]").textContent')), previous.receiptHash);
      assert.equal(await evaluate('document.querySelectorAll(".mock-interview-thread article[data-role=user]").length'), 2);
      assert.equal(await evaluate('document.querySelectorAll(".mock-interview input[type=checkbox]").length'), 0);
      const afterRestart = await assertCalls(4); assert.deepEqual(taskWrites(afterRestart), previous.writes);
      w.webContents.reload();
      await waitFor('!!document.querySelector("[aria-label=面试攻防评估回执]") && document.querySelector(".mock-interview-scroll > [role=status]")?.textContent.includes("completed")');
      const afterReload = await assertCalls(4); assert.deepEqual(taskWrites(afterReload), previous.writes);
      assert.equal(hash(await evaluate('document.querySelector("[aria-label=面试攻防评估回执]").textContent')), previous.receiptHash);
      await evaluate('document.querySelector("[aria-label=面试攻防评估回执]").scrollIntoView({block:"start"})');
      await w.capturePage(undefined, { stayHidden: true, stayAwake: true }); await sleep(150);
      const screenshot = path.join(dir, "electron-interview-receipt.png"); fs.writeFileSync(screenshot, (await w.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      await click("返回顾问"); await waitFor('!document.querySelector(".mock-interview")');
      assert.equal(await evaluate('document.querySelector(".agent-chat-textarea").value'), ordinaryDraft);
      assert.deepEqual(forbidden, []);
      const evidence = { electron: process.versions.electron, sourceReactAndProductionClients: true, productionPreload: true,
        preloadHash: hash(fs.readFileSync(preload)), fullProcessRestarts: 2, answers: 2, manualFinish: true,
        modelCalls: 4, adapterBuilds: 1, tasksCreated: 2, sameRoot: true, noInferenceOrWritesOnRestore: true,
        independentOrdinaryDraft: true, draftCharacters: answerOne.length, draftHash: previous.draftHash,
        receiptHash: previous.receiptHash, completeRecordHash: previous.completeRecordHash,
        profileIsolated: fs.realpathSync(app.getPath("userData")) === path.join(dir, "userData"),
        actualServiceOrModelCalls: 0, blockedRequests, screenshot, completeRecord: receiptFile, summary: path.join(dir, "summary.json") };
      assert.ok(evidence.profileIsolated); fs.writeFileSync(evidence.summary, JSON.stringify(evidence, null, 2));
      console.log("BETTERME_ELECTRON_INTERVIEW " + JSON.stringify(evidence));
    }
    assert.deepEqual(forbidden, []);
    await saveStorage(); w.destroy();
  }
  const fail = error => { console.error("BETTERME_ELECTRON_INTERVIEW_FAILED", error?.stack ?? String(error)); app.exit(1); };
  const timer = setTimeout(() => fail(Error("stage timeout")), 40000);
  app.whenReady().then(run).then(() => { clearTimeout(timer); app.exit(0); }, fail);
}
