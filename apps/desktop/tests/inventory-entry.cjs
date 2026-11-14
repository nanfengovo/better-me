/* Isolated acceptance only. Never use the installed app's normal profile or service. */
const {app,session,dialog}=require("electron");
const path=require("node:path"),fs=require("node:fs"),os=require("node:os"),assert=require("node:assert/strict");
const profile=process.argv.find(s=>s.startsWith("--profile=")).slice(10);
const origin=process.argv.find(s=>s.startsWith("--origin=")).slice(9);
const fake=process.argv.find(s=>s.startsWith("--fake-inventory-audio="))?.split("=")[1];
assert.equal(new URL(origin).hostname,"127.0.0.1");assert.equal(path.dirname(profile),fs.realpathSync(os.tmpdir()));assert.match(path.basename(profile),/^betterme-inventory-native-[\w-]+$/);
assert.equal(fs.realpathSync(profile),profile);assert.deepEqual(fs.readdirSync(profile).filter(s=>s!=="userData"),[]);
for(const name of ["userData","sessionData","crashDumps","logs","downloads"]){const target=path.join(profile,name);fs.mkdirSync(target,{recursive:true});app.setPath(name,target);}
// Don't strand a user-facing system dialog if the disposable Host/Web probe fails.
dialog.showErrorBox=(title,message)=>{fs.writeFileSync(path.join(profile,"qa-main-error.txt"),title+"\n"+message,{flag:"wx",mode:0o600});app.exit(71);};
app.on("browser-window-created",(_event,win)=>win.once("ready-to-show",()=>{win.show();app.focus({steal:true});win.focus();}));
for(const flag of ["disable-background-networking","disable-component-update","disable-sync","use-mock-keychain"])app.commandLine.appendSwitch(flag);
if(fake){
  assert.equal(fs.realpathSync(fake),fake);assert.equal(path.dirname(path.dirname(fake)),fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(path.dirname(fake)),/^betterme-inventory-qa-[\w-]+$/);assert.equal(path.basename(fake),"fake-microphone.wav");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");app.commandLine.appendSwitch("use-file-for-fake-audio-capture",fake);
}
app.whenReady().then(()=>{
  session.defaultSession.webRequest.onBeforeRequest((r,cb)=>{const u=new URL(r.url);cb({cancel:u.origin!==origin&&!["blob:","data:","about:"].includes(u.protocol)});});
  session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
  session.defaultSession.on("will-download",(event,item)=>{
    if(!/^better-me-backup-[\d-]+\.json$/.test(item.getFilename())||!item.getURL().startsWith("blob:"+origin+"/")){event.preventDefault();return;}
    item.setSavePath(path.join(profile,"downloads","verified-backup.json"));
  });
  // Actual compiled main, its own preload and window permission handlers.
  // The existing external-only QA configuration refuses spawn or fallback.
  assert.equal(app.isPackaged,false);assert.equal(process.env.BETTERME_DESKTOP_QA_MODE,"external-reuse-only");
  assert.equal(process.env.BETTERME_DESKTOP_QA_WEB_URL,origin);
  const api=new URL(process.env.BETTERME_DESKTOP_QA_HOST_URL);assert.equal(api.hostname,"127.0.0.1");
  for(const url of [api,new URL(origin)])assert.ok(Number(url.port)>1024&&!["5173","5179"].includes(url.port));
  require(path.resolve(__dirname,process.argv.includes("--installed")?"../../../../BetterMe.app/Contents/Resources/app/dist/main/index.cjs":"../dist/main/index.cjs"));
});
app.on("window-all-closed",()=>app.quit());
