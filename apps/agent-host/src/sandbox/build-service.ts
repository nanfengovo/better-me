import { createHash } from "node:crypto";
import { transform } from "esbuild";
import { z } from "zod";

const scope = z.enum(["selected_offers", "backcheck_summary", "job_snapshots"]);
export type MicroAppScope = z.infer<typeof scope>;
const template = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), name: z.string().min(1).max(200),
  nameEn: z.string().max(200), icon: z.string().max(32), version: z.string().max(32),
  description: z.string().max(1000), grantedScopes: z.array(scope).max(3),
  sourceCode: z.string().max(64 * 1024), customCss: z.string().max(64 * 1024), htmlBody: z.string().max(64 * 1024),
}).strict();
export type SandboxBuildInput = z.infer<typeof template>;
export interface SandboxVerificationCheck { id: string; name: string; passed: boolean; detail: string }
export interface BuiltMicroAppArtifact {
  appId: string; name: string; nameEn: string; icon: string; version: string; description: string;
  grantedScopes: MicroAppScope[]; codeHash: string; bundleHtml: string; compiledAt: string; pinnedToDock: false;
  verifierVersion:"reviewed-builtin-v2"; dependencies:Record<string,never>;
  verification: { passed: boolean; timestamp: string; checks: SandboxVerificationCheck[]; profile: "reviewed-builtin-v2" };
}
export class SandboxBuildError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

// Release-time allowlist of the *entire* four reviewed UI templates, not a hash
// supplied by the caller. Changing markup, permissions or metadata needs review
// and a deliberate pin update. Model-generated code must use the QuickJS lab.
const reviewed = new Map([
  ["offer-backcheck-radar", "831f81dc8f61f3f69c38dc7b21f28944a98fecf1c9c55ea0b764d5f054121551"],
  ["star-prompter", "dc16b9fbcc2a8785d9f750ddad1b6c32b40d5f5399992eb9b47ba8dea3ba7735"],
  ["tax-fund-calculator", "d97726fbd7bb08a987e61cc13b4edb3f0d6328835507095c9da048164609f70a"],
  ["equity-options-calculator", "58b76857dc51d90c20a5d74881c1ea3b91c3daa2d1cf49eeb03c3044ca53f9d3"],
]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';";
const baseCss = `:root{--bg:#f6f6f0;--surface:#fff;--surface-soft:#eef1e8;--border:#dfe5d8;--text:#17261f;--muted:#64756c;--accent:#1f5a47;--accent-soft:rgba(31,90,71,.08);--accent-ink:#fff;--warn:#b85d19;--ok:#15803d}
:root[data-theme="dark"]{--bg:#0b0f13;--surface:#11181f;--surface-soft:rgba(255,255,255,.04);--border:rgba(255,255,255,.12);--text:#edf2ef;--muted:#8b9aa6;--accent:#4fd1a5;--accent-soft:rgba(79,209,165,.12);--accent-ink:#052017;--warn:#f59e0b;--ok:#34d399}
*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font:13px system-ui,sans-serif;padding:16px 20px}.mono{font-family:ui-monospace,monospace}`;
export class SandboxBuildService {
  async build(raw: unknown): Promise<BuiltMicroAppArtifact> {
    const parsed = template.safeParse(raw);
    if (!parsed.success) throw new SandboxBuildError("invalid_sandbox_template", 400);
    const t = parsed.data;
    const manifestHash = hash([t.appId,t.name,t.nameEn,t.icon,t.version,t.description,t.grantedScopes,t.htmlBody,t.customCss,t.sourceCode]);
    if (reviewed.get(t.appId) !== manifestHash) throw new SandboxBuildError("unreviewed_sandbox_template", 422);
    // Compile in memory, no loaders resolving dependencies, no untrusted path,
    // no candidate execution in the Node process, and no temporary source files.
    const { code } = await transform(t.sourceCode, { loader: "js", format: "iife", target: "es2022", logLevel: "silent" });
    // Only pinned, application-owned text enters this document. srcDoc isolation
    // is applied separately by SandboxedAppHost; this is not a browser E2E test.
    const bundleHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${t.name}</title><style>${baseCss}\n${t.customCss}</style></head><body>${t.htmlBody}<script>${code}</script></body></html>`;
    const at = new Date().toISOString();
    return { appId:t.appId, name:t.name, nameEn:t.nameEn, icon:t.icon, version:t.version, description:t.description,
      grantedScopes:t.grantedScopes, codeHash:hash(["reviewed-builtin-v2",manifestHash,bundleHtml]), bundleHtml, compiledAt:at, pinnedToDock:false,
      verifierVersion:"reviewed-builtin-v2", dependencies:{},
      verification:{profile:"reviewed-builtin-v2", passed:true, timestamp:at, checks:[
        {id:"template-integrity",name:"内置模板校验",passed:true,detail:"源码、HTML、样式、权限与版本均匹配发行时固定的摘要。"},
        {id:"compile",name:"脚本编译",passed:true,detail:"Host 已编译内置脚本；未在 Node 中运行候选代码，未运行浏览器功能测试。"},
      ]} };
  }
}
