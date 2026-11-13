/* eslint-disable @typescript-eslint/no-require-imports -- Native isolated Electron acceptance. */
/** Fresh jd-ocr-live Host on 5301. Three independent processes, installed preload,
 * actual React/default clients, six originals/24 MiB, scripted model only. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5301",entry=origin+"/tests/ui-lab/jd-ocr-live.html",hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed app/dist required");const preload=path.join(fs.realpathSync(process.argv[2]),"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-ocr-"))),env={},png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=","base64");
  const images=[10,10,1,1,1,1].map((mib,index)=>{const bytes=Buffer.alloc(mib*1024*1024,index);png.copy(bytes);const file=path.join(directory,`original-${index}.png`);fs.writeFileSync(file,bytes,{mode:0o600});return {file,name:path.basename(file),bytes:bytes.length,hash:hash(`data:image/png;base64,${bytes.toString("base64")}`)};});
  fs.writeFileSync(path.join(directory,"original-manifest.json"),JSON.stringify(images,null,2));
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["pause","resume","restore"]){const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:90000});if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}}
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["pause","resume","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-ocr-")&&fs.realpathSync(directory)===directory);assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));
  app.setName("betterme-ocr-smoke");app.disableHardwareAcceleration();for(const key of ["userData","sessionData","crashDumps","logs"]){const location=path.join(directory,key);fs.mkdirSync(location,{recursive:true});app.setPath(key,location);}if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside isolated fixture");};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const qa=async()=>{const value=await(await fetch(origin+"/__ocr-qa/state")).json();assert.ok(path.basename(value.directory).startsWith("betterme-ocr-browser-"));assert.equal(value.legacyPosts,0);return value;};
  async function run(){
    const before=await qa();assert.equal(before.modelCalls,stage==="pause"?0:stage==="resume"?2:3);
    const originals=JSON.parse(fs.readFileSync(path.join(directory,"original-manifest.json"),"utf8")),s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5301,token:"synthetic_ocr_tasks_"+"q".repeat(43)}));ipcMain.handle("desktop:open-external",()=>{forbidden.push("external-navigation");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}}),evaluate=code=>w.webContents.executeJavaScript(code,true);
    const until=async code=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}fs.writeFileSync(path.join(directory,"failure-dom.txt"),await evaluate("document.body.innerText"));throw Error("UI condition failed: "+code+"; full DOM: "+path.join(directory,"failure-dom.txt"));};
    const button=async text=>{const match=`(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return (await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks;})()`);
    const detail=`document.querySelector('[aria-label="截图任务记录"] pre')`,candidate=`document.getElementById('jd-extracted')`,grant=`document.querySelector('[aria-label="截图任务记录"] input[type=checkbox]')`;
    await w.loadURL(entry);await until("document.querySelector('[aria-label=\"合成底座就绪\"]')?.dataset.ready==='true'");
    if(stage==="pause"){
      await button("打开 Agent 伴侣");await until("Boolean(document.querySelector('[aria-label=\"发送给 Agent\"]'))");
      await evaluate("(()=>{const e=document.querySelector('[aria-label=\"发送给 Agent\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'合成聊天根，不发送真实资料。');e.dispatchEvent(new Event('input',{bubbles:true}));})()");await button("发送消息");await until("document.body.textContent.includes('OCR-CHAT-END')");await button("关闭 Agent 伴侣");
    }
    await button("截图入口");await button("截图识别");
    if(stage==="pause"){
      w.webContents.debugger.attach("1.3");const document=await w.webContents.debugger.sendCommand("DOM.getDocument"),{nodeId}=await w.webContents.debugger.sendCommand("DOM.querySelector",{nodeId:document.root.nodeId,selector:'#jd-screenshot-panel input[type="file"]'});assert.ok(nodeId);await w.webContents.debugger.sendCommand("DOM.setFileInputFiles",{nodeId,files:originals.map(image=>image.file)});w.webContents.debugger.detach();
      await until("document.querySelectorAll('#jd-screenshot-panel img').length===6&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='授权并识别截图文字'&&!b.disabled)");await button("授权并识别截图文字");await until(`Boolean(${detail})&&JSON.parse((${detail}).textContent).status==='paused'`);
      assert.equal(await evaluate(`Boolean(${grant}?.checked)`),false);assert.equal(await evaluate(`Boolean(${candidate})`),false);
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(path.join(directory,stage==="resume"?"pause-checkpoint.json":"complete-checkpoint.json"),"utf8"));assert.equal(before.directory,checkpoint.hostDirectory);
      await button("读取上次截图任务与原图（不重新识别）");await until(`Boolean(${detail})&&document.querySelectorAll('#jd-screenshot-panel img').length===6`);
      let tasks=await records(),after=await qa();assert.equal(hash(JSON.stringify(tasks)),checkpoint.tasksHash);assert.deepEqual(after.paths.filter(value=>value.startsWith("POST /api/v1/agent/tasks")),checkpoint.writes);assert.equal(after.modelCalls,stage==="resume"?2:3);
      if(stage==="resume"){
        assert.equal(await evaluate(`Boolean(${grant}?.checked)`),false);assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='恢复原截图任务').disabled"),true);
        await evaluate(`${grant}.click()`);await button("恢复原截图任务");await until(`Boolean(${candidate})&&JSON.parse((${detail}).textContent).status==='completed'`);
      }else await until(`Boolean(${candidate})`);
      tasks=await records();after=await qa();const ocr=tasks.find(task=>task.kind==="jd_ocr");assert.equal(ocr.result.text,after.text);assert.equal(ocr.id,checkpoint.ocrId);assert.equal(ocr.usage.modelCalls,2);assert.equal(await evaluate("document.getElementById('jd-text').value"),"");
    }
    const tasks=await records(),after=await qa(),ocr=tasks.find(task=>task.kind==="jd_ocr");assert.equal(tasks.length,2);assert.equal(after.modelCalls,stage==="pause"?2:3);assert.equal(after.adapterBuilds,1);assert.equal(new Set(tasks.map(task=>task.rootTaskId??task.id)).size,1);assert.equal(ocr.request.images.length,6);assert.equal(ocr.request.images.reduce((sum,image)=>sum+image.byteLength,0),24*1024*1024);
    assert.deepEqual(ocr.request.images.map(image=>image.hash),originals.map(image=>image.hash));for(const received of after.images)assert.deepEqual(received.map(image=>image.hash),originals.map(image=>image.hash));
    const hashes=await evaluate(`Promise.all(Array.from(document.querySelectorAll('#jd-screenshot-panel img')).map(async image=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(image.getAttribute('src')))),byte=>byte.toString(16).padStart(2,'0')).join('')))`);assert.deepEqual(hashes,originals.map(image=>image.hash));
    assert.deepEqual(forbidden,[]);fs.writeFileSync(path.join(directory,stage+"-tasks.json"),JSON.stringify(tasks,null,2));
    const checkpoint={hostDirectory:after.directory,tasksHash:hash(JSON.stringify(tasks)),writes:after.paths.filter(value=>value.startsWith("POST /api/v1/agent/tasks")),ocrId:ocr.id};fs.writeFileSync(path.join(directory,stage==="pause"?"pause-checkpoint.json":"complete-checkpoint.json"),JSON.stringify(checkpoint));
    await w.webContents.session.flushStorageData();await s.cookies.flushStore();const summary={stage,directory,hostDirectory:after.directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),modelCalls:after.modelCalls,ocrCalls:after.ocrCalls,adapterBuilds:after.adapterBuilds,originalImageBytes:24*1024*1024,originalImages:6,tasksHash:checkpoint.tasksHash,externalModelCalls:0,legacyPosts:after.legacyPosts,blockedRequests:blocked};fs.writeFileSync(path.join(directory,stage+"-summary.json"),JSON.stringify(summary,null,2));console.log("BETTERME_OCR_SMOKE "+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
