/* eslint-disable @typescript-eslint/no-require-imports -- Explicit isolated desktop acceptance, not a production entry. */
const {app,BrowserWindow,session,ipcMain}=require("electron");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const arg=name=>process.argv.find(a=>a.startsWith(name+"="))?.slice(name.length+1);
const directory=arg("--directory"),preload=arg("--preload");
assert.ok(directory&&preload);assert.equal(fs.realpathSync(directory),directory);assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));assert.match(path.basename(directory),/^betterme-text-electron-[A-Za-z0-9_-]+$/);assert.ok(fs.statSync(preload).isFile());
app.setName("BetterMe Text Acceptance");for(const name of ["userData","sessionData","crashDumps","logs"]){const target=path.join(directory,name);fs.mkdirSync(target,{recursive:true,mode:0o700});app.setPath(name,target);}
for(const flag of ["disable-background-networking","disable-component-update","disable-sync","disable-breakpad","use-mock-keychain"])app.commandLine.appendSwitch(flag);app.commandLine.appendSwitch("password-store","basic");
app.whenReady().then(async()=>{
  const origin="http://127.0.0.1:5341",downloads=path.join(directory,"downloads");fs.mkdirSync(downloads,{recursive:true,mode:0o700});
  session.defaultSession.on("will-download",(_event,item)=>{if(!/^BetterMe-ct_[a-f0-9]{32}-approved\.md$/.test(item.getFilename()))return item.cancel();item.setSavePath(path.join(downloads,item.getFilename()));});
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const url=new URL(details.url);callback({cancel:url.origin!==origin&&!["blob:","data:","about:"].includes(url.protocol)});});
  session.defaultSession.setPermissionCheckHandler(()=>false);session.defaultSession.setPermissionRequestHandler((_c,_p,callback)=>callback(false));
  ipcMain.handle("desktop:get-agent-info",()=>({endpoint:origin,token:"synthetic_text_only_"+"x".repeat(43),port:5341}));
  const window=new BrowserWindow({width:1100,height:950,title:"BetterMe · 文本闭环隔离验收",webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:"deny"}));window.webContents.on("will-navigate",(event,url)=>{if(!url.startsWith(origin+"/"))event.preventDefault();});
  await window.loadURL(origin+"/tests/ui-lab/resume-text.html?user=desktop");
});app.on("window-all-closed",()=>app.quit());
