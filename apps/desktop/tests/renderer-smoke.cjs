/** Opt-in real Electron smoke, not part of ordinary node:test discovery.
 * node apps/desktop/tests/renderer-smoke.cjs '/path/to/BetterMe.app/Contents/Resources/app/dist'
 * Creates only a private temporary test profile, summary.json and (if available)
 * a nonblank PNG. Never starts the default app, a backend or a model provider.
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict"), { once } = require("node:events");
const readArgument = (name) => process.argv.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
const denySwitches = ["--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--disable-breakpad", "--force-prefers-reduced-motion", "--use-mock-keychain", "--password-store=basic", "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=<-loopback>"];

if (!process.versions.electron) {
  assert.ok(process.argv[2], "pass the compiled app/dist containing index.html, main and preload");
  const dist = fs.realpathSync(process.argv[2]);
  for (const file of ["index.html", "main/index.cjs", "preload/index.cjs"]) assert.ok(fs.statSync(path.join(dist,file)).isFile());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-electron-offline-")));
  const env = {};
  for (const key of ["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","SystemRoot","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR"])
    if (process.env[key]) env[key] = process.env[key];
  const executable = require("electron"); // stock development binary; do not launch the regular BetterMe profile
  const child = require("node:child_process").spawnSync(executable, [
    "--user-data-dir=" + path.join(dir,"userData"), "--crash-dumps-dir=" + path.join(dir,"crashDumps"), ...denySwitches,
    __filename, "--fixture-dir=" + dir, "--fixture-dist=" + dist,
  ], { env, cwd:dir, stdio:"inherit", timeout:30000 });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  const { app, BrowserWindow, session, dialog } = require("electron");
  const dir = readArgument("--fixture-dir"), dist = readArgument("--fixture-dist");
  assert.ok(dir && dist && path.basename(dir).startsWith("betterme-electron-offline-") && fs.realpathSync(dir) === dir);
  assert.equal(app.commandLine.getSwitchValue("user-data-dir"),path.join(dir,"userData"),"an isolated initial profile is required");
  const origin = "http://127.0.0.1:5173", url = origin + "/?workspace=autopilot";
  const forbidden = [], assets = new Set(), sleep = (ms) => new Promise((r) => setTimeout(r,ms));
  let syntheticApiReads = 0, blockedRequests = 0, windows = 0;
  app.setName("better-me-desktop");
  for (const key of ["userData","sessionData","crashDumps","logs"]) {
    const location = path.join(dir,key); fs.mkdirSync(location,{ recursive:true }); app.setPath(key,location);
  }
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  Object.defineProperty(app,"isPackaged",{value:true});
  // The deployed main believes both services are ready. Requests are served
  // in-process only; an unexpected Node process or real fetch is never permitted.
  for (const op of ["spawn","spawnSync","exec","execFile","execFileSync","fork"])
    require("node:child_process")[op] = () => { forbidden.push("unexpected-child"); throw Error("outside fixture"); };
  const index = fs.readFileSync(path.join(dist,"index.html"),"utf8");
  globalThis.fetch = async (u,options={}) => {
    if ((options.method ?? "GET") === "GET") {
      if (String(u) === origin) return new Response(index,{headers:{"Content-Type":"text/html"}});
      if (String(u) === "http://127.0.0.1:5179/api/v1/agent/health") return new Response("{}");
    }
    forbidden.push("unexpected-main-fetch"); throw Error("outside fixture");
  };
  dialog.showErrorBox = (title) => { forbidden.push("native-error: " + title); };
  const mime = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",
    ".svg":"image/svg+xml",".webp":"image/webp",".png":"image/png",".jpg":"image/jpeg",".woff2":"font/woff2" };
  function fixtureResponse(req) {
    const to = new URL(req.url);
    if (to.origin !== origin) { blockedRequests++; return new Response("",{status:403}); }
    if (req.method !== "GET") { forbidden.push("renderer-mutation"); return new Response("",{status:403}); }
    if (to.pathname.startsWith("/api/")) { syntheticApiReads++; return new Response("{}",{headers:{"Content-Type":"application/json"}}); }
    const name = to.pathname === "/" ? "index.html" : decodeURIComponent(to.pathname.slice(1));
    const file = path.resolve(dist,name);
    if (!file.startsWith(dist+path.sep) || !fs.existsSync(file) || fs.realpathSync(file)!==file || !fs.statSync(file).isFile())
      return new Response("",{status:404});
    assets.add(name); return new Response(fs.readFileSync(file),{headers:{"Content-Type":mime[path.extname(file)]??"application/octet-stream"}});
  }
  app.on("browser-window-created",(_,w) => {
    windows++; w.show=()=>{}; w.focus=()=>{}; w.webContents.setBackgroundThrottling(false);
  });
  async function signedOut() {
    for (let i=0;i<80;i++) {
      const w = BrowserWindow.getAllWindows()[0];
      if (w && !w.webContents.isLoadingMainFrame() && w.webContents.getURL() === url) {
        const state = await w.webContents.executeJavaScript(`(async()=>({
          title:document.title,heading:document.querySelector("#identity-title")?.textContent,
          fields:!!document.querySelector('input[name="username"]'),
          formVisible:(()=>{const f=document.querySelector(".identity-card"),r=f?.getBoundingClientRect();return !!f && r.width>100 && r.height>100 && Number(getComputedStyle(f).opacity)>.98;})(),
          mark:document.querySelector("main.identity-screen")?.dataset.electron,
          bridge:window.desktopApi?.isElectron===true && (await window.desktopApi.getAgentHostInfo()).port===5179
        }))()`);
        if (state.fields && state.formVisible && state.bridge && state.mark==="true") {
          assert.equal(state.title,"迈向更好 · BetterMe");
          assert.ok(["欢迎回来","Welcome back"].includes(state.heading)); return { w, heading:state.heading };
        }
      }
      await sleep(120);
    }
    throw Error("bundled React login and preload IPC did not both initialize");
  }
  async function run() {
    const s = session.defaultSession;
    s.setPermissionCheckHandler(()=>false); s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    // Intercept the real production URL inside Chromium; no loopback listener
    // is started or contacted. Offline emulation and a sink proxy add a backstop.
    s.protocol.handle("http",fixtureResponse);
    s.protocol.handle("https",()=>{ blockedRequests++; return new Response("",{status:403}); });
    s.webRequest.onBeforeRequest((details,cb)=>{
      const u=new URL(details.url), allowed=u.origin===origin || ["about:","data:","blob:"].includes(u.protocol);
      if(!allowed) blockedRequests++; cb({cancel:!allowed});
    });
    await s.setProxy({mode:"fixed_servers",proxyRules:"http://127.0.0.1:1",proxyBypassRules:"<-loopback>"});
    s.enableNetworkEmulation({offline:true});
    require(path.join(dist,"main/index.cjs"));
    const first=await signedOut(), closed=once(first.w,"closed"); first.w.close(); await closed;
    assert.equal(BrowserWindow.getAllWindows().length,0);
    app.emit("activate"); app.emit("activate");
    const second=await signedOut();
    assert.equal(second.heading,first.heading); assert.equal(BrowserWindow.getAllWindows().length,1);
    assert.equal(windows,2); assert.deepEqual(forbidden,[]);
    for (const suffix of [".js",".css"]) assert.ok([...assets].some(x=>x.startsWith("assets/index-") && x.endsWith(suffix)));
    let screenshot;
    // A hidden window can expose the updated DOM one compositor frame before
    // capturePage sees it. Keep it hidden, wake the surface, then capture the
    // next painted frame instead of storing the intermediate "connecting" view.
    await second.w.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await Promise.race([second.w.webContents.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))"),sleep(1200)]);
    await sleep(150);
    const image = await second.w.capturePage(undefined,{stayHidden:true,stayAwake:true});
    if (!image.isEmpty()) {
      const bytes = image.toBitmap(), colors = new Set();
      for (let i=0;i+4<=bytes.length && colors.size<16;i+=40) colors.add(bytes.readUInt32LE(i));
      if (colors.size>=16) { screenshot=path.join(dir,"desktop-login.png"); fs.writeFileSync(screenshot,image.toPNG()); }
    }
    const evidence = {electron:process.versions.electron,packagedMain:true,packagedPreload:true,packagedReact:true,
      heading:second.heading,windowsCreated:windows,assetsLoaded:assets.size,syntheticApiReads,blockedRequests,
      actualServiceOrModelCalls:0,profileIsolated:fs.realpathSync(app.getPath("userData"))===path.join(dir,"userData"),
      screenshot:screenshot??null,summary:path.join(dir,"summary.json")};
    assert.ok(evidence.profileIsolated); fs.writeFileSync(evidence.summary,JSON.stringify(evidence,null,2)+"\n");
    console.log("BETTERME_ELECTRON_SMOKE "+JSON.stringify(evidence));
  }
  const fail = (e) => { console.error("BETTERME_ELECTRON_SMOKE_FAILED",e?.message??String(e)); app.exit(1); };
  const timer=setTimeout(()=>fail(Error("timeout")),24000);
  app.whenReady().then(run).then(()=>{clearTimeout(timer);app.exit(0);},fail);
}
