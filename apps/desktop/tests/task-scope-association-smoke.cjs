/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in isolated Electron acceptance. */
/** Fresh chatgpt-task-live fixture on 5299 only. Explicit synthetic task/model,
 * installed preload, production React/client/HTTP; never real user state. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5299",entry=origin+"/tests/ui-lab/chatgpt-task-live.html?pane=legacy",hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-scope-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:60000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-scope-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-scope-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const target=path.join(directory,key);fs.mkdirSync(target,{recursive:true});app.setPath(key,target);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside fixture");};
  const qa=async()=>{const data=await(await fetch(origin+"/__account-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-account-browser-"));assert.equal(data.fallbackCalls,0);return data;};
  async function run(){
    assert.equal((await qa()).modelCalls,stage==="run"?0:3);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5299,token:"synthetic_account_tasks_"+"q".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}}),evaluate=code=>w.webContents.executeJavaScript(code,true),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async code=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}fs.writeFileSync(path.join(directory,"failure-page.txt"),await evaluate("document.body.innerText"));throw Error("scope condition failed: "+code);};
    const click=async label=>{const match=`b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const openLedger=async()=>{await until("Boolean(document.querySelector('.agent-task-ledger'))");await evaluate("document.querySelector('.agent-task-ledger').open=true;document.querySelector('.agent-legacy-scope').open=true;");};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return(await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks;})()`);
    const checkpointFile=path.join(directory,"checkpoint.json");await w.loadURL(entry);
    await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.runtimeReady==='true'&&document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.ready==='true'");
    if(stage==="run"){
      await click("创建隔离旧任务（合成模型）");await until("document.querySelector('.agent-task-ledger')&&document.body.innerText.includes('隔离旧任务已创建')");
      const before=await records();assert.equal(before.length,1);assert.equal(before[0].rootScopeKey,undefined);assert.equal(before[0].rootLedger.usage.modelCalls,1);
      const taskDirectory=path.join((await qa()).directory,"identity","owners",before[0].ownerId,"career-tasks-v1"),journalFile=path.join(taskDirectory,before[0].id+".json");
      assert.ok(fs.statSync(journalFile).isFile());const journal=fs.readFileSync(journalFile),originalHash=hash(journal);
      await openLedger();assert.equal((await qa()).modelCalls,1);await click("读取可关联旧根账（不推理）");await until("Boolean(document.querySelector('.agent-legacy-scope input[type=radio]'))");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认关联原根账').disabled"),true);
      await evaluate("document.querySelector('.agent-legacy-scope input[type=radio]').click();document.querySelector('.agent-legacy-scope input[type=checkbox]').click();");
      await click("确认关联原根账");await until("document.querySelector('.agent-legacy-scope')?.textContent.includes('已关联原根')");
      assert.equal((await qa()).modelCalls,1);assert.deepEqual(fs.readFileSync(journalFile),journal);const linked=await records();assert.equal(linked[0].rootScopeKey,"account-browser-scope");assert.equal(linked[0].rootLedger.usage.modelCalls,1);
      await click("明确发送同根新任务（合成模型）");await until("document.body.innerText.includes('同根新调用完成')");const shared=await records();assert.equal(shared.length,2);assert.ok(shared.every(task=>task.rootTaskId===before[0].id&&task.rootLedger.usage.modelCalls===2));
      await click("创建隔离旧任务（合成模型）");await until("document.body.innerText.includes('隔离旧任务已创建')");await openLedger();await click("读取可关联旧根账（不推理）");await until("document.querySelector('.agent-legacy-scope')?.textContent.includes('当前工作区已有另一根账')");
      assert.equal(await evaluate("document.querySelector('.agent-legacy-scope input[type=radio]').disabled"),true);assert.equal((await qa()).modelCalls,3);
      const tasks=await records(),after=await qa();fs.writeFileSync(checkpointFile,JSON.stringify({ids:tasks.map(task=>task.id),recordsHash:hash(JSON.stringify(tasks)),writes:after.paths.filter(route=>route.startsWith('POST /api/v1/agent/tasks')),journalFile,originalHash}));
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(checkpointFile,"utf8"));await openLedger();await click("读取可关联旧根账（不推理）");await until("document.querySelector('.agent-legacy-scope')?.textContent.includes('当前工作区已有另一根账')");
      const tasks=await records(),after=await qa();assert.equal(hash(JSON.stringify(tasks)),checkpoint.recordsHash);assert.deepEqual(tasks.map(task=>task.id),checkpoint.ids);assert.deepEqual(after.paths.filter(route=>route.startsWith('POST /api/v1/agent/tasks')),checkpoint.writes);assert.equal(hash(fs.readFileSync(checkpoint.journalFile)),checkpoint.originalHash);
      assert.equal(after.modelCalls,3);assert.equal(await evaluate("document.querySelector('.agent-legacy-scope input[type=radio]').disabled"),true);
    }
    assert.deepEqual(forbidden,[]);await s.cookies.flushStore();await s.flushStorageData();const after=await qa(),summary={stage,directory,fixtureDirectory:after.directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,modelCalls:after.modelCalls,externalModelCalls:0,fallbackCalls:after.fallbackCalls,taskPosts:after.paths.filter(route=>route.startsWith('POST /api/v1/agent/tasks')).length,blockedRequests:blocked};
    await w.webContents.capturePage().then(image=>fs.writeFileSync(path.join(directory,stage+".png"),image.toPNG()));fs.writeFileSync(path.join(directory,stage+"-summary.json"),JSON.stringify(summary,null,2));console.log("BETTERME_SCOPE_SMOKE "+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
