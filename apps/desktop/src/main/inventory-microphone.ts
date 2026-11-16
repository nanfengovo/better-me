import type { BrowserWindow, IpcMainInvokeEvent, IpcMainEvent } from "electron";
type Frame={window:boolean;mainFrame:boolean;url?:string;origin?:string};
/** A one-hold permit, never a per-origin remembered permission. */
export class InventoryMicPermit{
  private until=0;
  constructor(private workspace:string,private now=Date.now){}
  private trusted(frame:Frame){
    try{const site=new URL(this.workspace),url=new URL(frame.url??"");
      return frame.window&&frame.mainFrame&&["http:","https:"].includes(site.protocol)&&
        ["127.0.0.1","[::1]","localhost"].includes(site.hostname)&&url.origin===site.origin&&frame.origin===site.origin&&!url.username&&!url.password;
    }catch{return false;}
  }
  arm(frame:Frame){if(!this.trusted(frame))return false;this.until=this.now()+15000;return true;}
  disarm(){this.until=0;}
  allowGeolocation(frame:Frame){return this.trusted(frame);}
  allow(frame:Frame,types:readonly string[]){return this.until>this.now()&&this.trusted(frame)&&types.length===1&&types[0]==="audio";}
  request(frame:Frame,types:readonly string[]){
    if(!this.allow(frame,types))return false;
    this.disarm();return true;
  }
}
export function installInventoryMic(win:BrowserWindow,url:string){
  const permit=new InventoryMicPermit(url),wc=win.webContents,ctx=wc.ipc;
  const frame=(e:IpcMainInvokeEvent|IpcMainEvent)=>{
    const f=e.senderFrame;return {window:e.sender===wc,mainFrame:!!f&&f===wc.mainFrame,url:f?.url,origin:f?.origin};
  };
  ctx.handle("inventory:arm-microphone",e=>!win.isDestroyed()&&win.isFocused()&&permit.arm(frame(e)));
  ctx.on("inventory:disarm-microphone",e=>{if(e.sender===wc&&e.senderFrame===wc.mainFrame)permit.disarm();});
  wc.on("did-start-navigation",()=>permit.disarm());win.on("blur",()=>permit.disarm());win.on("closed",()=>permit.disarm());
  wc.session.setPermissionCheckHandler((sender,permission,origin,details)=>permission==="clipboard-sanitized-write"||
    (permission==="geolocation"&&permit.allowGeolocation({window:sender===wc,mainFrame:details.isMainFrame,url:details.requestingUrl,origin:origin?.replace(/\/$/,"")}))||
    permission==="media"&&permit.allow({window:sender===wc,mainFrame:details.isMainFrame,url:details.requestingUrl,origin},[details.mediaType??"unknown"]));
  wc.session.setPermissionRequestHandler((sender,permission,callback,details)=>{
    if(permission==="geolocation"){
      let geoOrigin=(details as {securityOrigin?:string}).securityOrigin?.replace(/\/$/,"");
      if(!geoOrigin&&details.requestingUrl){try{geoOrigin=new URL(details.requestingUrl).origin;}catch{geoOrigin=undefined;}}
      callback(permit.allowGeolocation({window:sender===wc,mainFrame:details.isMainFrame,url:details.requestingUrl,origin:geoOrigin}));
      return;
    }
    if(permission!=="media"){callback(permission==="clipboard-sanitized-write");return;}
    const media=details as Electron.MediaAccessPermissionRequest;
    callback(permit.request({window:sender===wc,mainFrame:media.isMainFrame,url:media.requestingUrl,origin:media.securityOrigin?.replace(/\/$/,"")},media.mediaTypes??[]));
  });
}
