export const localBridgeHeaders = { "X-BetterMe-Bridge": "1" };

export async function requestLocalBridgeGrant(purpose: "cookies" | "job", origin?: string): Promise<{ token: string; expiresAt: number }> {
  const response = await fetch("/api/jd/bridge-grant", { method: "POST", headers: { ...localBridgeHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose, ...(origin ? { origin } : {}) }) });
  const result = await response.json() as { token?: string; expiresAt?: number; error?: string };
  if (!response.ok || !/^[a-f0-9]{64}$/.test(result.token ?? "") || !Number.isFinite(result.expiresAt)) throw new Error(result.error || "无法生成本机桥接授权。");
  return { token: result.token!, expiresAt: result.expiresAt! };
}

export function cookieBridgeBookmarklet(serviceOrigin: string, token: string): string {
  const target = new URL(serviceOrigin);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.origin !== serviceOrigin || !/^[a-f0-9]{64}$/.test(token)) throw new Error("请在本机工作台生成书签授权。");
  // The page receives only a single-use cookie-import capability, never workbench authority.
  return `javascript:(function(){try{if(location.protocol!=='https:'||!/(^|\\.)(zhipin\\.com|liepin\\.com|51job\\.com|linkedin\\.com)$/.test(location.hostname)){alert('仅支持已授权的招聘网站');return;}var raw=document.cookie||'';var list=raw.split(';').map(function(s){var i=s.indexOf('=');return i<1?null:{name:s.slice(0,i).trim(),value:s.slice(i+1).trim(),domain:location.hostname};}).filter(Boolean);if(!list.length){alert('未读取到 Cookie，请先登录招聘平台');return;}fetch(${JSON.stringify(`${serviceOrigin}/api/jd/cookie-bridge`)},{method:'POST',headers:{'Content-Type':'application/json','Authorization':${JSON.stringify(`Bearer ${token}`)}},body:JSON.stringify({platform:location.hostname,cookies:list})}).then(function(r){return r.json();}).then(function(d){alert(d.success?'同步完成：'+d.count+' 项':'同步未完成，请回到工作台重新授权');}).catch(function(){alert('无法连接本机桥接服务，请回到工作台重新授权');});}catch(e){alert('同步未完成，请回到工作台重新授权');}})();`;
}
