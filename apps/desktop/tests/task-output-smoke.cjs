/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in isolated Electron verification. */
/** Fresh chatgpt-task-live.config.ts on 5299 only. Real installed preload,
 * production readers/default clients, fictional OAuth/model, never real data. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5299",entry=origin+"/tests/ui-lab/chatgpt-task-live.html",hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const original="\ufeff  合成原始输出😀\r\n"+"完整原文，不截取、不自动续答。\r\n".repeat(12000)+"OUTPUT-ARTIFACT-END  ";
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed app/dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-output-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:60000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-output-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-output-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const target=path.join(directory,key);fs.mkdirSync(target,{recursive:true});app.setPath(key,target);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside fixture");};
  const qa=async()=>{const data=await(await fetch(origin+"/__account-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-account-browser-"));assert.equal(data.fallbackCalls,0);return data;};
  async function run(){
    assert.equal((await qa()).modelCalls,stage==="run"?0:1);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5299,token:"synthetic_account_tasks_"+"q".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const evaluate=code=>w.webContents.executeJavaScript(code,true),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async code=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}fs.writeFileSync(path.join(directory,"failure-page.txt"),await evaluate("document.body.innerText"));throw Error("output fixture condition failed: "+code);};
    const button=async label=>{const match=`(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return(await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks;})()`);
    const body=()=>evaluate(`document.querySelector('[aria-label="完整原始输出正文"]')?.textContent`);
    const downloadFile=path.join(directory,"complete-raw-output.txt"),checkpointFile=path.join(directory,"checkpoint.json");
    await w.loadURL(stage==="run"?entry:entry+"?pane=outputs");
    // Exercise the real copy handler while leaving the user's OS clipboard intact.
    await evaluate("Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.__SYNTHETIC_OUTPUT_COPY__=text;}})");
    await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.runtimeReady==='true'&&document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.ready==='true'");
    if(stage==="run"){
      await button("打开 Agent 伴侣");await evaluate("document.querySelector('[data-testid=\"agent-companion-tools-toggle\"]').click()");await evaluate("document.querySelector('[data-testid=\"agent-companion-quick-run-toggle\"]').click()");
      await until("Boolean(document.querySelector('.agent-companion-field textarea'))");
      await evaluate("(()=>{const e=document.querySelector('.agent-companion-field textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'SYNTHETIC-OVERSIZED-OUTPUT');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await until("document.querySelector('.agent-companion-field textarea')?.value==='SYNTHETIC-OVERSIZED-OUTPUT'");await pause(40);
      await until("document.querySelector('.agent-companion-run input[type=checkbox]')?.disabled===false");await evaluate("document.querySelector('.agent-companion-run input[type=checkbox]').click()");
      await until("document.querySelector('.agent-companion-run input[type=checkbox]')?.checked===true");await button("开始运行");await until("Boolean(document.querySelector('.task-output-artifact'))");
      assert.equal(await body(),undefined);assert.equal((await qa()).paths.filter(x=>x.includes('/outputs/')).length,0,"opening a task does not read bodies");
      await button("读取完整原文");await until("Boolean(document.querySelector('[aria-label=\"完整原始输出正文\"]'))");assert.equal(await body(),original);
      await button("复制完整原文");await until("document.querySelector('.task-output-artifact [role=status]')?.textContent.includes('已复制')");assert.equal(await evaluate("window.__SYNTHETIC_OUTPUT_COPY__"),original);
      const downloading=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("raw output download timeout")),8000);s.once("will-download",(_event,item)=>{assert.ok(item.getURL().startsWith('blob:'+origin));item.setSavePath(downloadFile);item.once('done',(_event,status)=>{clearTimeout(timer);if(status==='completed')resolve();else reject(Error(status));});});});
      await button("下载完整原文");await downloading;assert.deepEqual(fs.readFileSync(downloadFile),Buffer.from(original));
      await button("outputs");await until("document.querySelector('.agent-task-ledger > summary')?.textContent.includes('原始输出 1 项任务')");await evaluate("document.querySelector('.agent-task-ledger > summary').click()");
      assert.equal(await body(),undefined);await button("读取完整原文");await until("Boolean(document.querySelector('[aria-label=\"完整原始输出正文\"]'))");assert.equal(await body(),original);
      const tasks=await records(),after=await qa();assert.equal(tasks.length,1);assert.equal(tasks[0].status,'budget_exhausted');assert.equal(tasks[0].usage.modelCalls,1);assert.equal(after.modelCalls,1);assert.equal(tasks[0].reply,undefined);
      assert.equal(tasks[0].outputArtifacts[0].hash,hash(fs.readFileSync(downloadFile)));assert.equal(tasks[0].outputArtifacts[0].bytes,Buffer.byteLength(original));
      fs.writeFileSync(path.join(directory,'complete-task-records.json'),JSON.stringify(tasks,null,2));
      fs.writeFileSync(checkpointFile,JSON.stringify({ids:tasks.map(t=>t.id),recordsHash:hash(JSON.stringify(tasks)),writes:after.paths.filter(x=>x.startsWith('POST /api/v1/agent/tasks')),fileHash:hash(fs.readFileSync(downloadFile))}));
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(checkpointFile,'utf8'));
      await until("document.querySelector('.agent-task-ledger > summary')?.textContent.includes('原始输出 1 项任务')");
      const beforeRead=await qa();assert.equal(beforeRead.paths.filter(x=>x.includes('/outputs/')).length,2,"restart reads metadata only");assert.equal(await body(),undefined);
      await evaluate("document.querySelector('.agent-task-ledger > summary').click()");await button("读取完整原文");await until("Boolean(document.querySelector('[aria-label=\"完整原始输出正文\"]'))");assert.equal(await body(),original);
      const tasks=await records(),after=await qa();assert.equal(after.modelCalls,1);assert.equal(hash(JSON.stringify(tasks)),checkpoint.recordsHash);assert.deepEqual(tasks.map(t=>t.id),checkpoint.ids);assert.deepEqual(after.paths.filter(x=>x.startsWith('POST /api/v1/agent/tasks')),checkpoint.writes);assert.equal(hash(fs.readFileSync(downloadFile)),checkpoint.fileHash);
      await button("收起并清除本页全文");assert.equal(await body(),undefined);
    }
    assert.deepEqual(forbidden,[]);await s.cookies.flushStore();await s.flushStorageData();const after=await qa();
    const summary={stage,directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,modelCalls:after.modelCalls,externalModelCalls:0,fallbackCalls:after.fallbackCalls,fullBytes:Buffer.byteLength(original),fullHash:hash(Buffer.from(original)),taskPosts:after.paths.filter(x=>x.startsWith('POST /api/v1/agent/tasks')).length,readBodies:after.paths.filter(x=>x.includes('/outputs/')).length,blockedRequests:blocked};
    fs.writeFileSync(path.join(directory,stage+'-summary.json'),JSON.stringify(summary,null,2));console.log('BETTERME_OUTPUT_SMOKE '+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
