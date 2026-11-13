/* eslint-disable @typescript-eslint/no-require-imports -- Native Electron smoke entrypoint. */
/** Fresh chatgpt-task-live fixture on 5299, actual installed preload and source React.
 * Fictional signed OAuth + model only; every inference must cross authenticated tasks. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5299",entry=origin+"/tests/ui-lab/chatgpt-task-live.html?pane=coach";
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const goal="  合成接口测试学习目标，不认领生产上线。END-GOAL  ";
const analysis="  COACH-PAUSE-ONCE\n"+"本人补充完整测试边界，不代表生产效果。\n".repeat(100)+"END-ANALYSIS  ";
const evidence="  只提交合成可读说明，尚未实际验证。\nEND-EVIDENCE  ";
const answer="  使用唯一键记录结果，生产恢复尚未核实。\n"+"保留实际回答，不补造生产规模。\n".repeat(100)+"END-ANSWER  ";
const draft="  独立未发送的成长草稿。END-DRAFT  ";

if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed app/dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-coach-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:90000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-coach-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-coach-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const location=path.join(directory,key);fs.mkdirSync(location,{recursive:true});app.setPath(key,location);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside isolated fixture");};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const qa=async()=>{const data=await(await fetch(origin+"/__account-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-account-browser-"));assert.equal(data.fallbackCalls,0);assert.ok(!data.paths.some(value=>/^POST .*\/(?:chatgpt\/response|understanding\/sessions|routing\/respond|chat\/respond)/.test(value)));return data;};
  async function run(){
    const before=await qa();assert.equal(before.modelCalls,stage==="run"?0:11);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5299,token:"synthetic_account_tasks_"+"q".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external-navigation");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const evaluate=code=>w.webContents.executeJavaScript(code,true);
    const until=async code=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}throw Error("fixture UI condition failed: "+code+"\n"+await evaluate("document.body.innerText"));};
    const button=async text=>{const match=`(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const field=text=>`Array.from(document.querySelectorAll('.career-coach label')).find(l=>l.textContent.startsWith(${JSON.stringify(text)}))?.querySelector('input,textarea,select')`;
    const fill=async(text,value)=>{const target=field(text);await until(`Boolean(${target})`);await evaluate(`(()=>{const e=${target};Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(30);};
    const check=async text=>{const match=`e.parentElement.textContent.includes(${JSON.stringify(text)})&&!e.disabled`;await until(`Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>${match})`);await evaluate(`Array.from(document.querySelectorAll('input[type=checkbox]')).find(e=>${match}).click()`);await until(`Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>${match}&&e.checked)`);};
    const setup=async()=>{await evaluate("document.querySelector('.coach-setup').open=true");};
    const settled=async()=>{await until("!document.querySelector('.coach-running')");};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return {tasks:(await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks,growth:(await(await fetch('/api/v1/agent/records/growth?key=account-browser-scope',{headers})).json()).value};})()`);
    const ready=async()=>{await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.textContent.includes('chatgpt · fixture-gpt')");await until("!document.querySelector('.coach-alert[role=\"alert\"] > strong')&&!document.body.textContent.includes('正在读取本地成长记录')");};
    await w.loadURL(entry);await ready();
    if(stage==="run"){
      await button("companion");await button("打开 Agent 伴侣");await until("Boolean(document.querySelector('[aria-label=\"发送给 Agent\"]'))");
      await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.ready==='true'");
      await evaluate("(()=>{const e=document.querySelector('[aria-label=\"发送给 Agent\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'合成聊天根，不发送真实材料。');e.dispatchEvent(new Event('input',{bubbles:true}));})()");await button("发送消息");await until("document.body.textContent.includes('ACCOUNT-REPLY-END')");
      await button("coach");await ready();await setup();await fill("本阶段目标",goal);await fill("计划周数","2");await fill("每周小时","2");await fill("面试轮数","2");await check("共享当前简历字段");
      await fill("本轮问题或补充回答",analysis);await button("开始规划分析");await until("document.body.textContent.includes('核对原任务后恢复')");await settled();
      assert.equal((await qa()).modelCalls,2);const paused=(await records()).tasks.find(task=>task.kind==='career_coach');assert.equal(paused.status,'paused');assert.equal(paused.request.input,analysis);assert.ok(paused.partialOutput.text.endsWith('}'));
      assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('恢复原任务（')).disabled"),true);
      await new Promise(resolve=>{w.webContents.once("did-finish-load",resolve);w.reload();});await ready();await setup();assert.equal(await evaluate(`(${field("本轮问题或补充回答")}).value`),analysis);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.coach-permissions input')).some(e=>e.checked)"),false);assert.equal((await qa()).modelCalls,2);
      await check("共享当前简历字段");await button("开始规划分析");await until("document.body.textContent.includes('核对原任务后恢复')");await settled();assert.equal((await qa()).modelCalls,2);
      const shown=await evaluate("JSON.parse(document.querySelector('.coach-alert pre').textContent)");assert.deepEqual(shown.request,paused.request);assert.deepEqual(shown.partialOutput,paused.partialOutput);
      await check("授权恢复原任务");await button("恢复原任务（保留已用额度）");await until("document.body.textContent.includes('合成目标理解')");await settled();assert.equal((await qa()).modelCalls,3);
      await button("我确认目标与理解一致");await until("document.body.textContent.includes('已确认这版理解')&&document.querySelector('.coach-journey')?.textContent.includes('目标已确认')");await button("修改建议");await button("生成修改建议");await until("document.body.textContent.includes('候选表达，未采用。')");await settled();
      await button("学习方案");await button("生成学习方案");await until("document.body.textContent.includes('候选方案 · 尚未执行')");await settled();assert.equal((await records()).growth.activePlan,undefined);
      await button("采纳此学习方案");await until("document.body.textContent.includes('已采纳学习方案')");await button("学习监督");await fill("学习证据",evidence);await button("保存学习提交");await until("document.body.textContent.includes('已保留提交，尚无模型反馈。')");await button("请求模型反馈");await until("document.body.textContent.includes('合成复盘，仅供参考。')");await settled();
      await button("针对性刷题");await fill("这次练什么","  回执幂等 END-TOPIC  ");await button("生成一道练习题");await until(`Boolean(${field("我的练习回答")})`);await settled();await fill("我的练习回答",answer);await button("保存回答并请求评价");await until("document.body.textContent.includes('仅有自述，需要实测。')");await settled();
      await button("模拟面试");await button("开始模拟面试");await until(`Boolean(${field("你的面试回答")})`);await settled();
      for(let i=0;i<2;i++){await fill("你的面试回答",answer+String(i));await button("提交回答并继续");await until(i===0?"document.body.textContent.includes('已作答 1/2')&&Boolean(document.querySelector('.coach-question textarea'))":"document.body.textContent.includes('合成面试参考，非认证。')");await settled();}
      const data=await records(),after=await qa();assert.equal(after.modelCalls,11);assert.equal(data.tasks.length,10);assert.equal(data.growth.records.length,9);assert.equal(new Set(data.tasks.map(task=>task.rootTaskId??task.id)).size,1);
      for(const task of data.tasks){assert.equal(task.runtimeBinding.id,`chatgpt:${after.profileId}:fixture-gpt`);assert.equal(task.rootLedger.usage.modelCalls,11);assert.equal(task.status,task.kind==='free_chat'?'awaiting_answer':'completed');}
      assert.equal(data.tasks.find(task=>task.id===paused.id).usage.modelCalls,2);assert.equal(data.growth.settings.goal,goal);assert.equal(data.growth.submissions[0].evidence,evidence);assert.equal(data.growth.drills[0].answer,answer);assert.equal(data.growth.drills[0].topic,"  回执幂等 END-TOPIC  ");
      assert.deepEqual(data.growth.interview.turns.map(turn=>turn.answer),[answer+'0',answer+'1']);assert.equal(data.growth.interview.status,'completed');
      for(const mode of ['analysis','resume','plan','review','drill','interview'])assert.ok(data.tasks.some(task=>task.request?.mode===mode));
      const review=data.tasks.find(task=>task.request?.mode==='review');assert.ok(review.parentTaskId);assert.equal(review.request.submission.evidence,evidence);assert.equal(data.growth.records.every(record=>record.id===record.basis.taskId),true);
      await button("规划分析");await fill("本轮问题或补充回答",draft);await button("模拟面试");
      fs.writeFileSync(path.join(directory,'complete-records.json'),JSON.stringify(data,null,2));fs.writeFileSync(path.join(directory,'checkpoint.json'),JSON.stringify({directory:after.directory,writes:after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),recordsHash:hash(JSON.stringify(data)),ids:data.tasks.map(task=>task.id).sort()}));
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(path.join(directory,'checkpoint.json'),'utf8'));assert.equal(before.directory,checkpoint.directory);await until("document.body.textContent.includes('合成面试参考，非认证。')");
      await setup();assert.equal(await evaluate("Array.from(document.querySelectorAll('.coach-permissions input')).some(e=>e.checked)"),false);assert.equal(await evaluate("Boolean(document.querySelector('.coach-alert input:checked'))"),false);assert.equal(await evaluate("document.body.textContent.includes('面试使用的简历或岗位授权已变化')"),true);
      await button("规划分析");assert.equal(await evaluate(`(${field("本轮问题或补充回答")}).value`),draft);await button("修改建议");await until("document.body.textContent.includes('候选表达，未采用。')");assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('核对并应用此条')).disabled"),true);
      const data=await records(),after=await qa();assert.equal(after.modelCalls,11);assert.equal(hash(JSON.stringify(data)),checkpoint.recordsHash);assert.deepEqual(after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),checkpoint.writes);assert.deepEqual(data.tasks.map(task=>task.id).sort(),checkpoint.ids);
    }
    await w.webContents.session.flushStorageData();await s.cookies.flushStore();assert.deepEqual(forbidden,[]);const after=await qa();
    const summary={stage,directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,modelCalls:after.modelCalls,fallbackCalls:after.fallbackCalls,externalModelCalls:0,taskKinds:after.phases,blockedRequests:blocked};
    fs.writeFileSync(path.join(directory,stage+'-summary.json'),JSON.stringify(summary,null,2));console.log('BETTERME_COACH_SMOKE '+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
