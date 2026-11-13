/* eslint-disable @typescript-eslint/no-require-imports -- Native Electron acceptance entrypoint. */
/** Fresh chatgpt-task-live Host on 5299. Real preload/React/default task clients;
 * fictional signed OAuth/model, isolated profile, no business adoption. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5299",entry=origin+"/tests/ui-lab/chatgpt-task-live.html?pane=intake";
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const source="  PAUSE-INTAKE\n岗位职责：\n"+"只提供合成岗位原文，不认领任何个人经验。\n".repeat(200)+"合成接口测试工程师\n合成设备企业\n20k-30k\n上海浦东\nMETADATA-END  ";
const fields={"例如：资深前端工程师 / 架构师":"合成接口测试工程师","例如：字节跳动 / 腾讯 / 创新企业":"合成设备企业","例如：35k-50k · 16薪":"20k-30k","例如：上海 / 远程":"上海浦东"};
if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed app/dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-intake-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:90000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-intake-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-intake-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const location=path.join(directory,key);fs.mkdirSync(location,{recursive:true});app.setPath(key,location);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside isolated fixture");};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const qa=async()=>{const data=await(await fetch(origin+"/__account-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-account-browser-"));assert.equal(data.fallbackCalls,0);assert.ok(!data.paths.some(value=>/^POST .*\/(?:chatgpt\/response|understanding\/sessions|routing\/respond|chat\/respond)/.test(value)));return data;};
  async function run(){
    const before=await qa();assert.equal(before.modelCalls,stage==="run"?0:3);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5299,token:"synthetic_account_tasks_"+"q".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external-navigation");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const evaluate=code=>w.webContents.executeJavaScript(code,true);
    const until=async code=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}fs.writeFileSync(path.join(directory,'failure-dom.txt'),await evaluate("document.body.innerText"));throw Error("fixture UI condition failed: "+code+"; full DOM: "+path.join(directory,'failure-dom.txt'));};
    const button=async text=>{const match=`(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const input=`Array.from(document.querySelectorAll('textarea')).find(e=>e.placeholder.startsWith('粘贴 BOSS直聘'))`;
    const detail=`document.querySelector('[aria-label="岗位字段提取任务"] pre')`;
    const fill=async()=>{await until(`Boolean(${input})`);await evaluate(`(()=>{const e=${input};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(source)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return (await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks;})()`);
    const ready=()=>until("document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.ready==='true'&&document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.runtimeReady==='true'");
    const reload=async()=>{await new Promise(resolve=>{w.webContents.once("did-finish-load",resolve);w.reload();});await ready();};
    const verifyFields=async()=>{for(const [placeholder,value] of Object.entries(fields)){await until(`document.querySelector('input[placeholder='+${JSON.stringify(JSON.stringify(placeholder))}+']')?.value===${JSON.stringify(value)}`);}};
    await w.loadURL(entry);await ready();
    if(stage==="run"){
      await button("companion");await button("打开 Agent 伴侣");await until("Boolean(document.querySelector('[aria-label=\"发送给 Agent\"]'))");
      await ready();
      await evaluate("(()=>{const e=document.querySelector('[aria-label=\"发送给 Agent\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'合成聊天根，不发送真实资料。');e.dispatchEvent(new Event('input',{bubbles:true}));})()");await button("发送消息");await until("document.body.textContent.includes('ACCOUNT-REPLY-END')");
      await button("intake");await fill();await button("读取并自动填入");await until("Array.from(document.querySelectorAll('textarea')).some(e=>e.placeholder.startsWith('请在此粘贴')&&e.value.endsWith('METADATA-END'))");
      assert.equal((await qa()).modelCalls,1,"rule intake cannot invoke model");await reload();assert.equal(await evaluate(`(${input}).value`),source);
      await button("授权模型提取并填入");await until(`Boolean(${detail})&&document.querySelector('[aria-label="岗位字段提取任务"]').textContent.includes('paused')`);
      const paused=(await records()).find(task=>task.kind==='jd_intake');assert.equal(paused.status,'paused');assert.equal(paused.request.text,source);assert.ok(paused.partialOutput.text.endsWith('}'));assert.equal((await qa()).modelCalls,2);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='恢复原字段提取任务').disabled"),true);
      await reload();assert.equal((await qa()).modelCalls,2);assert.equal(await evaluate(`(${input}).value`),source);
      await button("授权模型提取并填入");await until(`Boolean(${detail})`);assert.equal((await qa()).modelCalls,2);
      const shown=await evaluate(`JSON.parse((${detail}).textContent)`);assert.deepEqual(shown.request,paused.request);assert.deepEqual(shown.partialOutput,paused.partialOutput);
      assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"岗位字段提取任务\"] input:checked'))"),false);
      await evaluate("document.querySelector('[aria-label=\"岗位字段提取任务\"] input[type=checkbox]').click()");await button("恢复原字段提取任务");await verifyFields();
      const tasks=await records(),after=await qa(),intake=tasks.find(task=>task.kind==='jd_intake');assert.equal(after.modelCalls,3);assert.equal(tasks.length,2);assert.equal(intake.id,paused.id);assert.equal(intake.status,'completed');assert.equal(intake.request.text,source);assert.equal(intake.usage.modelCalls,2);
      assert.equal(new Set(tasks.map(task=>task.rootTaskId??task.id)).size,1);for(const task of tasks){assert.equal(task.runtimeBinding.id,`chatgpt:${after.profileId}:fixture-gpt`);assert.equal(task.rootLedger.usage.modelCalls,3);}
      for(const quote of Object.values(intake.result.fields)){assert.ok(quote.start>3000);assert.equal(source.slice(quote.start,quote.end),quote.value);}
      fs.writeFileSync(path.join(directory,'complete-tasks.json'),JSON.stringify(tasks,null,2));fs.writeFileSync(path.join(directory,'checkpoint.json'),JSON.stringify({directory:after.directory,writes:after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),tasksHash:hash(JSON.stringify(tasks)),intakeId:intake.id}));
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(path.join(directory,'checkpoint.json'),'utf8'));assert.equal(before.directory,checkpoint.directory);assert.equal(await evaluate(`(${input}).value`),source);await verifyFields();
      assert.equal(await evaluate("Boolean(document.querySelector('input[type=checkbox]:checked'))"),false);assert.equal((await qa()).modelCalls,3);
      await button("授权模型提取并填入");await until(`Boolean(${detail})&&document.querySelector('[aria-label="岗位字段提取任务"]').textContent.includes('completed')`);await verifyFields();
      const tasks=await records(),after=await qa();assert.equal(after.modelCalls,3);assert.equal(hash(JSON.stringify(tasks)),checkpoint.tasksHash);assert.deepEqual(after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),checkpoint.writes);
    }
    await w.webContents.session.flushStorageData();await s.cookies.flushStore();assert.deepEqual(forbidden,[]);const after=await qa();
    const summary={stage,directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,modelCalls:after.modelCalls,fallbackCalls:after.fallbackCalls,externalModelCalls:0,taskKinds:after.phases,sourceLength:source.length,blockedRequests:blocked};
    fs.writeFileSync(path.join(directory,stage+'-summary.json'),JSON.stringify(summary,null,2));console.log('BETTERME_INTAKE_SMOKE '+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
