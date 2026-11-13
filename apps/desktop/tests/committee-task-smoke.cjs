/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in isolated Electron acceptance. */
/** Fresh committee-task-live fixture on 5296, installed preload and production
 * React/client/authenticated Host only; no real identity, model or user files. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5296",entry=origin+"/tests/ui-lab/committee-task-live.html",hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-committee-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:60000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-committee-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-committee-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const target=path.join(directory,key);fs.mkdirSync(target,{recursive:true});app.setPath(key,target);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside fixture");};
  const qa=async()=>{const data=await(await fetch(origin+"/__committee-task-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-committee-browser-"));assert.equal(fs.realpathSync(data.directory),data.directory);assert.equal(data.legacyCalls,0);return data;};
  const journals=data=>{
    const owners=fs.readdirSync(path.join(data.directory,"identity/owners"));assert.equal(owners.length,1);
    const taskDirectory=path.join(data.directory,"identity/owners",owners[0],"career-tasks-v1");
    return fs.readdirSync(taskDirectory).filter(name=>/^ct_[a-f0-9]{32}\.json$/.test(name)).sort().map(name=>{const bytes=fs.readFileSync(path.join(taskDirectory,name));return {name,hash:hash(bytes),bytes:bytes.length,record:JSON.parse(bytes)};});
  };
  async function run(){
    assert.equal((await qa()).modelCalls,stage==="run"?0:17);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5296,token:"synthetic_committee_only_"+"x".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}}),evaluate=code=>w.webContents.executeJavaScript(code,true),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async code=>{for(let i=0;i<600;i++){if(await evaluate(code))return;await pause(20);}fs.writeFileSync(path.join(directory,"failure-page.txt"),await evaluate("document.body.innerText"));throw Error("committee condition failed: "+code);};
    const click=async label=>{const match=`b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const fill=async(label,value)=>evaluate(`(()=>{const el=Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes(${JSON.stringify(label)})).querySelector('input,textarea');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const stoppedPosts=data=>data.paths.filter(route=>route.startsWith("POST "));
    await w.loadURL(entry);await until("document.body.innerText.includes('明确建立合成审查范围')");
    if(stage==="run"){
      await click("明确建立合成审查范围");await until("Boolean(document.querySelector('.career-analysis-panel'))||document.body.innerText.includes('开始有界抗压测试')");
      await fill("授权源码目录",(await qa()).source);await fill("目录内源码文件","lease.ts");await fill("结束行","2");await fill("补充本人陈述","  本人只参与合成设计😀；生产结果未知。  ");
      await evaluate("document.querySelector('input[type=checkbox]').click()");await click("开始有界抗压测试");await until("document.body.innerText.includes('分析状态：paused')");
      assert.equal((await qa()).modelCalls,5);await click("核对原任务状态");assert.equal((await qa()).modelCalls,5);
      await click("明确恢复原任务（沿用原预算）");await until("document.body.innerText.includes('分析状态：completed')");assert.equal((await qa()).modelCalls,16);
      await fill("补充本人陈述","  第二份合成设计，用于明确停止验收😀。  ");assert.equal(await evaluate("document.querySelector('input[type=checkbox]').checked"),false);
      await evaluate("document.querySelector('input[type=checkbox]').click()");await click("开始有界抗压测试");await until("fetch('/__committee-task-qa/state').then(r=>r.json()).then(s=>s.modelCalls===17)");await click("取消本次分析");await until("document.body.innerText.includes('分析状态：paused')");
      for(let i=0;i<150;i++){if(journals(await qa()).some(row=>row.record.task.status==="paused"&&row.record.recent.some(output=>output.kind==="studio_committee_output"&&output.late===true)))break;await pause(20);}
      const after=await qa(),records=journals(after);assert.equal(records.length,3);assert.equal(after.modelCalls,17);assert.equal(after.adapters,1);assert.equal(after.committeeCalls,16);
      const complete=records.find(row=>row.record.task.kind==="studio_committee"&&row.record.task.status==="completed"),stopped=records.find(row=>row.record.task.kind==="studio_committee"&&row.record.task.status==="paused");assert.ok(complete&&stopped);
      assert.equal(complete.record.task.usage.modelCalls,15);assert.equal(stopped.record.task.usage.modelCalls,1);assert.equal(complete.record.task.rootTaskId,stopped.record.task.rootTaskId);
      assert.equal(complete.record.task.request.statements[0].text,"  本人只参与合成设计😀；生产结果未知。  ");assert.ok(complete.record.recent.some(row=>row.kind==="studio_committee_output"&&row.output==="  完整部分回复😀\r\nTAIL  "));
      assert.ok(stopped.record.recent.some(row=>row.kind==="studio_committee_output"&&row.late===true));assert.equal(stopped.record.committeeState.completed.length,0);assert.equal(stopped.record.task.result,undefined);
      assert.equal(fs.readFileSync(path.join(after.source,"lease.ts"),"utf8"),"export const lease = 'synthetic only';\n// 完整合成源码😀\n");
      fs.writeFileSync(path.join(directory,"checkpoint.json"),JSON.stringify({records:records.map(({name,hash,bytes})=>({name,hash,bytes})),postPaths:stoppedPosts(after)},null,2));
      for(const row of records)fs.writeFileSync(path.join(directory,row.name),JSON.stringify(row.record,null,2));
    }else{
      const before=JSON.parse(fs.readFileSync(path.join(directory,"checkpoint.json"),"utf8"));await pause(600);const after=await qa();
      assert.deepEqual(journals(after).map(({name,hash,bytes})=>({name,hash,bytes})),before.records);assert.deepEqual(stoppedPosts(after),before.postPaths);assert.equal(after.modelCalls,17);
      assert.equal(await evaluate("document.querySelectorAll('input[type=checkbox]:checked').length"),0);await w.reload();await until("document.body.innerText.includes('明确建立合成审查范围')");await pause(600);
      assert.deepEqual(stoppedPosts(await qa()),before.postPaths);assert.deepEqual(journals(await qa()).map(({name,hash,bytes})=>({name,hash,bytes})),before.records);
    }
    assert.deepEqual(forbidden,[]);await s.cookies.flushStore();await s.flushStorageData();const after=await qa(),summary={stage,directory,fixtureDirectory:after.directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,modelCalls:after.modelCalls,externalModelCalls:0,adapters:after.adapters,legacyCalls:after.legacyCalls,postPaths:stoppedPosts(after),records:journals(after).map(({name,hash,bytes})=>({name,hash,bytes})),blockedRequests:blocked};
    await w.webContents.capturePage().then(image=>fs.writeFileSync(path.join(directory,stage+".png"),image.toPNG()));fs.writeFileSync(path.join(directory,stage+"-summary.json"),JSON.stringify(summary,null,2));console.log("BETTERME_COMMITTEE_SMOKE "+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
