/* eslint-disable @typescript-eslint/no-require-imports -- Native Electron smoke entrypoint. */
/** Start chatgpt-task-live.config.ts on 5299 with a fresh synthetic Host first.
 * Uses real installed preload + production React/default clients over real HTTP;
 * the signed OAuth provider and model responses are fictional, never OpenAI. */
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const origin="http://127.0.0.1:5299",entry=origin+"/tests/ui-lab/chatgpt-task-live.html";
const argument=name=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const companion="  Electron 合成账号：只做接口测试，不认领上线。🙂 END-COMPANION  ";
const advisor="  Electron 合成顾问：请先问缺失职责。🙂 END-ADVISOR  ";
const supplement="  本人编写接口校验与测试样本。🙂\r\n"+"完整补充，不推断生产规模。\n".repeat(130)+"END-WRITING  ";
const answer="  本人只做测试环境的异常回执验证，尚未核实生产恢复。🙂\n"+"逐项说明未覆盖的范围。\n".repeat(110)+"END-ANSWER  ";
const answerTwo="  本人只验证了重复回执的测试样本，没有核实生产恢复或吞吐量。😀 END-SECOND-ANSWER  ";
const draft="未发送的独立账号伴侣草稿。🙂 END-DRAFT";
const advisorDraft="  顾问未发送草稿：与对练作答独立保存。😀 END-ADVISOR-DRAFT  ";
const oneOff="  Electron 单次文本任务😀\n"+"完整原文，不读取未授权的对话或文件。\n".repeat(120)+"END-ONE-OFF  ";

if(!process.versions.electron){
  assert.ok(process.argv[2],"explicit installed app/dist required");const dist=fs.realpathSync(process.argv[2]),preload=path.join(dist,"preload/index.cjs");assert.ok(fs.statSync(preload).isFile());
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"betterme-electron-account-"))),env={};
  for(const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])if(process.env[key])env[key]=process.env[key];
  for(const stage of ["run","restore"]){
    const child=require("node:child_process").spawnSync(require("electron"),["--user-data-dir="+path.join(directory,"userData"),"--crash-dumps-dir="+path.join(directory,"crashDumps"),"--disable-background-networking","--disable-component-update","--disable-sync","--disable-breakpad","--use-mock-keychain","--password-store=basic",__filename,"--directory="+directory,"--preload="+preload,"--stage="+stage],{env,cwd:directory,stdio:"inherit",timeout:90000});
    if(child.error)throw child.error;if(child.status!==0){process.exitCode=child.status??1;break;}
  }
}else{
  const {app,BrowserWindow,session,ipcMain}=require("electron"),directory=argument("--directory"),preload=argument("--preload"),stage=argument("--stage");
  assert.ok(directory&&preload&&["run","restore"].includes(stage));assert.ok(path.basename(directory).startsWith("betterme-electron-account-")&&fs.realpathSync(directory)===directory);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(directory,"userData"));app.setName("betterme-account-smoke");app.disableHardwareAcceleration();
  for(const key of ["userData","sessionData","crashDumps","logs"]){const location=path.join(directory,key);fs.mkdirSync(location,{recursive:true});app.setPath(key,location);}
  if(process.platform==="darwin")app.setActivationPolicy("accessory");
  const forbidden=[];let blocked=0;
  for(const method of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])require("node:child_process")[method]=()=>{forbidden.push("child-process");throw Error("outside isolated fixture");};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const qa=async()=>{const data=await(await fetch(origin+"/__account-qa/state")).json();assert.ok(path.basename(data.directory).startsWith("betterme-account-browser-"));assert.equal(data.fallbackCalls,0);assert.ok(!data.paths.some(value=>/^POST .*\/(?:runs|chatgpt\/response|understanding\/sessions|routing\/respond|chat\/respond)/.test(value)));return data;};
  async function run(){
    const before=await qa();if(stage==="run")assert.equal(before.modelCalls,0);else assert.equal(before.modelCalls,10);
    const s=session.defaultSession;s.setPermissionCheckHandler(()=>false);s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    s.webRequest.onBeforeRequest((details,cb)=>{const url=new URL(details.url),allowed=url.origin===origin||["about:","data:","blob:"].includes(url.protocol);if(!allowed)blocked++;cb({cancel:!allowed});});
    ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,port:5299,token:"synthetic_account_tasks_"+"q".repeat(43)}));
    ipcMain.handle("desktop:open-external",()=>{forbidden.push("external-navigation");throw Error("outside fixture");});
    const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    const evaluate=code=>w.webContents.executeJavaScript(code,true);
    const until=async(code)=>{for(let i=0;i<500;i++){if(await evaluate(code))return;await pause(20);}throw Error("fixture UI condition failed: "+code+"\n"+await evaluate("document.body.innerText"));};
    const button=async text=>{const match=`(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled`;await until(`Array.from(document.querySelectorAll('button')).some(b=>${match})`);await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>${match}).click()`);};
    const fill=async(selector,value)=>{await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(30);};
    const check=async text=>{const match=`e.parentElement.textContent.includes(${JSON.stringify(text)})&&!e.disabled`;await until(`Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>${match})`);await evaluate(`Array.from(document.querySelectorAll('input[type=checkbox]')).find(e=>${match}).click()`);await until(`Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>${match}&&e.checked)`);};
    const records=()=>evaluate(`(async()=>{const headers={Authorization:'Bearer '+window.__BETTER_ME_RUNTIME__.agentToken};const {principal}=await(await fetch('/api/v1/agent/identity/session',{headers})).json();headers['X-BetterMe-Owner']=principal.id;return(await(await fetch('/api/v1/agent/tasks',{headers})).json()).tasks;})()`);
    await w.loadURL(entry);await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.textContent.includes('chatgpt · fixture-gpt')");
    await button("打开 Agent 伴侣");await until("Boolean(document.querySelector('[aria-label=\"发送给 Agent\"]'))");
    await until("document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.ready==='true'&&document.querySelector('[aria-label=\"合成账号选择\"]')?.dataset.runtimeReady==='true'");
    if(stage==="run"){
      await fill('[aria-label="发送给 Agent"]',companion);await button("发送消息");await until("document.querySelector('[aria-label=\"对话记录\"]')?.textContent.includes('ACCOUNT-REPLY-END')");
      await fill('[aria-label="发送给 Agent"]',draft);
      await evaluate("document.querySelector('[data-testid=\"agent-companion-tools-toggle\"]').click()");
      await evaluate("document.querySelector('[data-testid=\"agent-companion-quick-run-toggle\"]').click()");
      await fill('.agent-companion-field textarea',oneOff);await check("允许将这段原文发送给当前底座");await button("开始运行");await until("document.querySelector('.agent-output-text')?.textContent.includes('END-ONE-OFF')");
      await button("advisor");await fill('.agent-chat-textarea',advisor);await button("发送");await until("document.body.textContent.includes('ACCOUNT-REPLY-END')");
      await button("writing");await button("检查当前简历");await button("一起完善这条经历");await fill('#writing-answer',supplement);await check("我确认这段补充");await button("请 Agent 整理候选表达");await until("Boolean(document.querySelector('#writing-proposal'))");
      assert.equal(await evaluate("document.querySelector('#writing-answer').value"),supplement.replaceAll("\r\n","\n"),"native textarea normalizes CRLF; no model-side clipping");
      await button("project");await check("允许本轮将这条原文");await button("让 Agent 继续理解");await until("document.body.textContent.includes('合成账号项目理解：先核对术语。')");
      await button("interview");
      await until("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim().startsWith('面试攻防防御'))");
      await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith('面试攻防防御')).click()");
      const preLaunch=await qa();await button("与 Copilot 模拟对练这道题 →");await until("Boolean(document.querySelector('.mock-interview'))");
      assert.equal((await qa()).modelCalls,preLaunch.modelCalls);assert.equal((await qa()).paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')).length,preLaunch.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')).length,"opening a selected question does not dispatch or grant");
      await button("返回顾问");await fill('.agent-chat-textarea',advisorDraft);await button("回到对练会话");
      await check("授权本次 JD");await button("授权并开始对练");await until("Boolean(document.querySelector('.mock-interview-thread'))");
      await fill('.mock-interview textarea',answer);await button("提交回答并追问");await until("document.querySelectorAll('.mock-interview-thread article[data-role=user]').length===1&&document.querySelector('.mock-interview-scroll > [role=status]')?.textContent.includes('awaiting_answer')");
      await fill('.mock-interview textarea',answerTwo);await button("提交回答并追问");await until("document.querySelectorAll('.mock-interview-thread article[data-role=user]').length===2&&document.querySelector('.mock-interview-scroll > [role=status]')?.textContent.includes('awaiting_answer')");
      await button("结束演练并生成回执");await until("Boolean(document.querySelector('[aria-label=\"面试攻防评估回执\"]'))");
      const receiptFile=path.join(directory,'complete-interview-record.json');
      const download=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('complete interview download timeout')),8000);s.once('will-download',(_event,item)=>{assert.ok(item.getURL().startsWith('blob:'+origin));assert.equal(item.getFilename(),'BetterMe-面试攻防评估记录.json');item.setSavePath(receiptFile);item.once('done',(_event,status)=>{clearTimeout(timeout);if(status==='completed')resolve();else reject(Error('download '+status));});});});
      await button("下载完整记录");await download;
      const downloaded=JSON.parse(fs.readFileSync(receiptFile,'utf8'));assert.deepEqual(downloaded.task.interview.receipt.answers.map(row=>row.quote),[answer,answerTwo]);assert.equal(downloaded.selection.matching.rawJd,"岗位要求\n熟悉 C# 与 .NET 接口测试。");assert.equal(downloaded.draft,"");assert.ok(!downloaded.pending);
      await button("返回顾问");assert.equal(await evaluate("document.querySelector('.agent-chat-textarea').value"),advisorDraft);await button("回到对练会话");
      await button("report");await button("授权当前简历并生成报告");await until("document.body.textContent.includes('合成账号协议报告')");
      const data=await records(),after=await qa();assert.equal(after.modelCalls,10);assert.equal(new Set(data.map(task=>task.rootTaskId??task.id)).size,1);
      assert.equal(data.length,8);for(const task of data){assert.equal(task.runtimeBinding.id,`chatgpt:${after.profileId}:fixture-gpt`);assert.equal(task.rootLedger.usage.modelCalls,10);}
      const users=data.filter(task=>task.kind==='free_chat').map(task=>task.conversation.messages.find(message=>message.role==='user').content);assert.ok(users.includes(companion));assert.ok(users.includes(advisor));
      const writing=data.find(task=>task.kind==='experience_refine');assert.equal(writing.conversation.messages[0].content,supplement.replaceAll("\r\n","\n"));
      const interview=data.find(task=>task.kind==='mock_interview');assert.equal(interview.status,'completed');assert.deepEqual(interview.interview.receipt.answers.map(row=>row.quote),[answer,answerTwo]);assert.equal(downloaded.task.id,interview.id);assert.equal(downloaded.task.parentTaskId,interview.parentTaskId);assert.equal(data.find(task=>task.id===interview.parentTaskId).kind,'jd_match');assert.equal(downloaded.task.rootTaskId,interview.rootTaskId);
      const single=data.find(task=>task.workspaceKey==='one-off:account-browser-scope');assert.equal(single.conversation.messages[0].content,oneOff);assert.equal(single.conversation.context,undefined);assert.ok(single.reply.content.includes(oneOff));
      fs.writeFileSync(path.join(directory,'complete-task-records.json'),JSON.stringify(data,null,2));
      fs.writeFileSync(path.join(directory,'checkpoint.json'),JSON.stringify({directory:after.directory,modelCalls:10,recordsHash:hash(JSON.stringify(data)),writes:after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),ids:data.map(task=>task.id).sort(),completeInterviewHash:hash(fs.readFileSync(receiptFile)),interviewId:interview.id}));
    }else{
      const checkpoint=JSON.parse(fs.readFileSync(path.join(directory,'checkpoint.json'),'utf8'));assert.equal(before.directory,checkpoint.directory);
      assert.equal(await evaluate("document.querySelector('[aria-label=\"发送给 Agent\"]').value"),draft);
      await evaluate("document.querySelector('[data-testid=\"agent-companion-tools-toggle\"]').click()");await evaluate("document.querySelector('[data-testid=\"agent-companion-quick-run-toggle\"]').click()");
      await until("document.querySelector('.agent-output-text')?.textContent.includes('END-ONE-OFF')");assert.equal(await evaluate("document.querySelector('.agent-companion-field textarea').value"),oneOff);assert.equal(await evaluate("document.querySelector('.agent-companion-run input[type=checkbox]').checked"),false);
      await button("writing");await button("一起完善这条经历");await until("Boolean(document.querySelector('#writing-answer'))");
      assert.equal(await evaluate("document.querySelector('#writing-answer').value"),supplement.replaceAll("\r\n","\n"));
      assert.equal(await evaluate("Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>e.checked)"),false,"writing consent is not restored");
      await button("project");await until("document.body.textContent.includes('合成账号项目理解：先核对术语。')");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('input[type=checkbox]')).some(e=>e.checked)"),false);
      await button("interview");await until("Boolean(document.querySelector('[aria-label=\"面试攻防评估回执\"]'))");
      assert.equal(await evaluate("document.querySelectorAll('.mock-interview-thread article[data-role=user]').length"),2);assert.ok(await evaluate("document.querySelector('[aria-label=\"面试攻防评估回执\"]').textContent.includes('END-SECOND-ANSWER')"));
      assert.equal(hash(fs.readFileSync(path.join(directory,'complete-interview-record.json'))),checkpoint.completeInterviewHash);
      await button("返回顾问");assert.equal(await evaluate("document.querySelector('.agent-chat-textarea').value"),advisorDraft);await button("回到对练会话");
      await button("report");await until("document.body.textContent.includes('合成账号协议报告')");
      const data=await records(),after=await qa();assert.equal(after.modelCalls,10);assert.deepEqual(after.paths.filter(value=>value.startsWith('POST /api/v1/agent/tasks')),checkpoint.writes);assert.deepEqual(data.map(task=>task.id).sort(),checkpoint.ids);assert.equal(hash(JSON.stringify(data)),checkpoint.recordsHash);assert.equal(data.find(task=>task.kind==='mock_interview').id,checkpoint.interviewId);
      await w.webContents.session.flushStorageData();
    }
    await s.cookies.flushStore();assert.deepEqual(forbidden,[]);const after=await qa();
    const summary={stage,directory,sourceReact:true,installedPreloadHash:hash(fs.readFileSync(preload)),profileIsolated:true,actualDefenseButton:true,workspaceChildSession:true,answers:2,manualFinish:true,fullDownload:true,modelCalls:after.modelCalls,fallbackCalls:after.fallbackCalls,externalModelCalls:0,taskKinds:after.phases,blockedRequests:blocked};
    fs.writeFileSync(path.join(directory,stage+'-summary.json'),JSON.stringify(summary,null,2));console.log('BETTERME_ACCOUNT_SMOKE '+JSON.stringify(summary));w.destroy();
  }
  app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
}
