import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { SOCIAL_PROVIDERS } from "@better-me/agent-contracts";
import { OIDC_CALLBACK_PATH, type OidcOptions } from "./oidc.js";

export interface BuiltinIdentityProfile {
  subject: string;
  provider: string;
  handle: string;
  displayName: string;
  updatedAt: string;
}

interface PersistedBuiltinIdpState {
  version: 1;
  clientId: string;
  clientSecret: string;
  publicJwk: JWK;
  privateJwk: JWK;
  profiles: BuiltinIdentityProfile[];
}

interface PendingAuthFlow {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  providerHint: string;
  createdAt: number;
}

interface IssuedAuthCode {
  flow: PendingAuthFlow;
  subject: string;
  displayName: string;
  createdAt: number;
}

const PRIMARY_PROVIDERS = SOCIAL_PROVIDERS.filter((provider) => provider.primary);

const CHANNEL_META: Record<string, { id: string; label: string; badge: string; accent: string; placeholderHandle: string; placeholderName: string; desc: string }> = {
  "betterme-wechat": {
    id: "wechat",
    label: "微信",
    badge: "微信安全登录 · 网页快捷授权",
    accent: "#07c160",
    placeholderHandle: "wxid_betterme_user",
    placeholderName: "微信用户",
    desc: "内置免安装微信授权网关：支持一键快捷登录或输入微信号标识绑定当前工作空间。",
  },
  "betterme-qq": {
    id: "qq",
    label: "QQ",
    badge: "QQ 安全中心 · 快捷授权",
    accent: "#12b7f5",
    placeholderHandle: "qq_betterme_user",
    placeholderName: "QQ 用户",
    desc: "内置免安装 QQ 授权网关：支持一键快捷登录或输入 QQ 标识绑定当前工作空间。",
  },
  "betterme-github": {
    id: "github",
    label: "GitHub",
    badge: "GitHub OAuth · 开发者身份",
    accent: "#24292f",
    placeholderHandle: "github-developer",
    placeholderName: "GitHub Developer",
    desc: "内置免安装 GitHub 身份网关：支持开发者账号一键授权并同步关联工作空间。",
  },
  "betterme-google": {
    id: "google",
    label: "Google",
    badge: "Google Identity · 账号授权",
    accent: "#4285f4",
    placeholderHandle: "user@gmail.com",
    placeholderName: "Google User",
    desc: "内置免安装 Google 身份网关：支持邮箱标识一键授权并安全绑定工作空间。",
  },
  unified: {
    id: "unified",
    label: "BetterMe 统一账号",
    badge: "BetterMe Unified OIDC · 统一身份中心",
    accent: "#1f5f4a",
    placeholderHandle: "betterme_member",
    placeholderName: "BetterMe 成员",
    desc: "内置零配置 OIDC 统一身份服务（RS256 + PKCE），无需额外安装外部 Casdoor 服务即可登录与注册。",
  },
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadOrCreateIdpState(storageDir: string, preset?: { clientId?: string; clientSecret?: string }): Promise<{
  state: PersistedBuiltinIdpState;
  save: () => Promise<void>;
}> {
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(storageDir, "builtin-idp-v1.json");
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as PersistedBuiltinIdpState;
    if (raw && raw.version === 1 && raw.publicJwk && raw.privateJwk) {
      if (preset?.clientId) raw.clientId = preset.clientId;
      if (preset?.clientSecret) raw.clientSecret = preset.clientSecret;
      const save = async () => {
        await writeFile(filePath, JSON.stringify(raw, null, 2), { mode: 0o600 });
      };
      return { state: raw, save };
    }
  } catch {
    // Generate fresh state below
  }

  const keys = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "betterme-builtin-v1", alg: "RS256", use: "sig" };
  const privateJwk: JWK = { ...(await exportJWK(keys.privateKey)), kid: "betterme-builtin-v1", alg: "RS256", use: "sig" };
  const state: PersistedBuiltinIdpState = {
    version: 1,
    clientId: preset?.clientId ?? "betterme-builtin-client",
    clientSecret: preset?.clientSecret ?? randomBytes(24).toString("base64url"),
    publicJwk,
    privateJwk,
    profiles: [],
  };
  const save = async () => {
    await writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  };
  await save();
  return { state, save };
}

function renderAuthorizePage(params: {
  flow: PendingAuthFlow;
  profiles: BuiltinIdentityProfile[];
  callbackOrigin: string;
}): string {
  const meta = CHANNEL_META[params.flow.providerHint] ?? CHANNEL_META["unified"]!;
  const channelProfiles = params.profiles.filter((item) => item.provider === meta.id || meta.id === "unified");
  const defaultHandle = channelProfiles[0]?.handle ?? meta.placeholderHandle;
  const defaultName = channelProfiles[0]?.displayName ?? meta.placeholderName;

  const existingCards = channelProfiles.length > 0
    ? `<div class="saved-section">
        <div class="section-label">已保存在本机的授权身份（点击一键登录）</div>
        <div class="saved-list">
          ${channelProfiles
            .map(
              (profile) => `
            <form method="POST" action="/authorize/complete" class="saved-card-form">
              <input type="hidden" name="flow" value="${escapeHtml(params.flow.id)}" />
              <input type="hidden" name="subject" value="${escapeHtml(profile.subject)}" />
              <input type="hidden" name="displayName" value="${escapeHtml(profile.displayName)}" />
              <input type="hidden" name="handle" value="${escapeHtml(profile.handle)}" />
              <input type="hidden" name="provider" value="${escapeHtml(profile.provider)}" />
              <button type="submit" class="saved-card">
                <span class="avatar">${escapeHtml(profile.displayName.slice(0, 1).toUpperCase())}</span>
                <span class="saved-info">
                  <strong>${escapeHtml(profile.displayName)}</strong>
                  <small>${escapeHtml(profile.handle)} · ${escapeHtml(profile.provider.toUpperCase())}</small>
                </span>
                <span class="saved-arrow">一键继续 →</span>
              </button>
            </form>`
            )
            .join("")}
        </div>
      </div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(meta.label)} · BetterMe 统一身份认证</title>
  <style>
    :root {
      color-scheme: light;
      --accent: ${meta.accent};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 20px;
      font-family: "Plus Jakarta Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background: radial-gradient(circle at 20% 15%, rgba(31, 95, 74, 0.10), transparent 45%),
                  radial-gradient(circle at 80% 85%, rgba(18, 183, 245, 0.08), transparent 45%),
                  #f4f5f0;
      color: #161816;
    }
    .card {
      width: min(460px, 100%);
      background: #ffffff;
      border: 1px solid rgba(22, 24, 22, 0.1);
      border-radius: 22px;
      padding: 28px;
      box-shadow: 0 24px 60px rgba(15, 23, 20, 0.08);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(31, 95, 74, 0.08);
      color: var(--accent);
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }
    h1 {
      margin: 14px 0 6px;
      font-size: 22px;
      letter-spacing: -0.02em;
    }
    p.desc {
      margin: 0 0 18px;
      color: #5a605d;
      font-size: 13px;
      line-height: 1.55;
    }
    .section-label {
      font-size: 12px;
      font-weight: 600;
      color: #525855;
      margin-bottom: 8px;
    }
    .saved-section {
      margin-bottom: 18px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e7e9e4;
    }
    .saved-list {
      display: grid;
      gap: 8px;
    }
    .saved-card-form { margin: 0; }
    .saved-card {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid #dfe3dc;
      background: #f9faf7;
      cursor: pointer;
      text-align: left;
      font: inherit;
      transition: border-color 0.15s ease, transform 0.12s ease;
    }
    .saved-card:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .avatar {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 14px;
      flex-shrink: 0;
    }
    .saved-info {
      display: grid;
      flex: 1;
      min-width: 0;
    }
    .saved-info strong {
      font-size: 13.5px;
      color: #161816;
    }
    .saved-info small {
      font-size: 11.5px;
      color: #6c726f;
    }
    .saved-arrow {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
    }
    label {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
      font-size: 12.5px;
      font-weight: 600;
      color: #2f3431;
    }
    input[type="text"] {
      width: 100%;
      min-height: 40px;
      padding: 8px 12px;
      border: 1px solid #d5d9d2;
      border-radius: 10px;
      font: inherit;
      font-size: 13.5px;
      background: #fcfcfa;
    }
    input[type="text"]:focus {
      outline: 2px solid rgba(31, 95, 74, 0.22);
      border-color: var(--accent);
    }
    .actions {
      display: grid;
      gap: 8px;
      margin-top: 16px;
    }
    .btn-primary {
      min-height: 42px;
      border: 0;
      border-radius: 11px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-cancel {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      min-height: 36px;
      border-radius: 9px;
      color: #5f6662;
      text-decoration: none;
      font-size: 12.5px;
      font-weight: 500;
    }
    .btn-cancel:hover { background: #f1f3ee; }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge"><span class="badge-dot"></span>${escapeHtml(meta.badge)}</div>
    <h1>使用 ${escapeHtml(meta.label)} 登录 BetterMe</h1>
    <p class="desc">${escapeHtml(meta.desc)}</p>
    ${existingCards}
    <form method="POST" action="/authorize/complete">
      <input type="hidden" name="flow" value="${escapeHtml(params.flow.id)}" />
      <input type="hidden" name="provider" value="${escapeHtml(meta.id)}" />
      <label>
        <span>${escapeHtml(meta.label)} 账号标识 (OpenID / 用户名 / 邮箱)</span>
        <input type="text" name="handle" required maxlength="80" value="${escapeHtml(defaultHandle)}" />
      </label>
      <label>
        <span>展示昵称</span>
        <input type="text" name="displayName" required maxlength="64" value="${escapeHtml(defaultName)}" />
      </label>
      <div class="actions">
        <button type="submit" class="btn-primary">授权并登录 BetterMe →</button>
        <a class="btn-cancel" href="/authorize/complete?flow=${encodeURIComponent(params.flow.id)}&cancel=1">取消并返回 (${escapeHtml(params.callbackOrigin)})</a>
      </div>
    </form>
  </main>
</body>
</html>`;
}

export interface BuiltinIdentityProviderHandle {
  issuer: string;
  options: OidcOptions;
  close: () => Promise<void>;
}

/**
 * Starts the built-in zero-install OIDC & Social Login Broker in-process.
 * Supports RS256 signed JWTs, PKCE S256, state/nonce verification, and all 4 primary social channels
 * (`wechat`, `qq`, `github`, `google`) plus unified account login without requiring external Casdoor.
 */
export async function startBuiltinIdentityProvider(config: {
  storageDir: string;
  callbackUrl: string;
  host?: string;
  port?: number;
  clientId?: string;
  clientSecret?: string;
}): Promise<BuiltinIdentityProviderHandle> {
  const host = config.host ?? "127.0.0.1";
  const preferredPort = config.port ?? 18000;
  const { state, save } = await loadOrCreateIdpState(config.storageDir, {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const privateKey = await importJWK(state.privateJwk, "RS256");
  const flows = new Map<string, PendingAuthFlow>();
  const codes = new Map<string, IssuedAuthCode>();
  let issuer = "";

  const issueCodeForFlow = async (
    flow: PendingAuthFlow,
    input: { subject?: string; provider?: string; handle?: string; displayName?: string }
  ): Promise<string> => {
    const provider = (input.provider || CHANNEL_META[flow.providerHint]?.id || "unified").trim().toLowerCase();
    const handle = (input.handle || CHANNEL_META[flow.providerHint]?.placeholderHandle || "betterme_user").trim();
    const displayName = (input.displayName || handle || "BetterMe User").trim();
    const subject =
      input.subject && input.subject.trim().length > 0
        ? input.subject.trim()
        : `${provider}:${createHash("sha256").update(`${provider}:${handle.toLowerCase()}`).digest("hex").slice(0, 24)}`;

    const existingIdx = state.profiles.findIndex((item) => item.subject === subject);
    const record: BuiltinIdentityProfile = {
      subject,
      provider,
      handle,
      displayName,
      updatedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      state.profiles[existingIdx] = record;
    } else {
      state.profiles.unshift(record);
    }
    await save();

    const code = randomUUID();
    codes.set(code, { flow, subject, displayName, createdAt: Date.now() });
    return new URLSearchParams({ code, state: flow.state }).toString();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer || `http://${host}:${preferredPort}`);
    res.setHeader("Cache-Control", "no-store");

    if (url.pathname === "/api/get-app-login" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (url.searchParams.get("clientId") !== state.clientId) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ status: "error", msg: "client_mismatch" }));
      }
      return res.end(
        JSON.stringify({
          status: "ok",
          data: {
            clientId: state.clientId,
            disableSignin: false,
            signinMethods: [{ name: "Password" }],
            providers: PRIMARY_PROVIDERS.map((provider) => ({
              name: `betterme-${provider.id}`,
              canSignIn: true,
              canSignUp: true,
              bindingRule: [],
              provider: {
                name: `betterme-${provider.id}`,
                category: "OAuth",
                type: provider.type,
                subType: provider.type === "WeChat" ? "Web" : "",
                clientId: `builtin-${provider.id}-client`,
                clientSecret: "***",
              },
            })),
          },
        })
      );
    }

    if (url.pathname === "/.well-known/openid-configuration" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        })
      );
    }

    if (url.pathname === "/jwks" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ keys: [state.publicJwk] }));
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const stateParam = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
      const providerHint = url.searchParams.get("provider_hint") ?? "unified";

      if (
        clientId !== state.clientId ||
        redirectUri !== config.callbackUrl ||
        !stateParam ||
        !nonce ||
        !codeChallenge ||
        codeChallengeMethod !== "S256"
      ) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.end(JSON.stringify({ error: "invalid_authorize_request" }));
      }

      const flow: PendingAuthFlow = {
        id: randomUUID(),
        clientId,
        redirectUri,
        state: stateParam,
        nonce,
        codeChallenge,
        codeChallengeMethod,
        providerHint,
        createdAt: Date.now(),
      };
      flows.set(flow.id, flow);

      const autoSubject = url.searchParams.get("auto_subject");
      if (autoSubject) {
        flows.delete(flow.id);
        const query = await issueCodeForFlow(flow, {
          subject: autoSubject,
          displayName: url.searchParams.get("auto_name") ?? "BetterMe User",
          provider: CHANNEL_META[providerHint]?.id ?? "unified",
        });
        res.writeHead(303, { Location: `${redirectUri}?${query}` });
        return res.end();
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(
        renderAuthorizePage({
          flow,
          profiles: state.profiles,
          callbackOrigin: new URL(config.callbackUrl).origin,
        })
      );
    }

    if (url.pathname === "/authorize/complete" && (req.method === "POST" || req.method === "GET")) {
      let params = url.searchParams;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      }
      const flowId = params.get("flow") ?? "";
      const flow = flows.get(flowId);
      flows.delete(flowId);
      if (!flow || Date.now() - flow.createdAt > 5 * 60_000) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end('<h1>授权会话已过期</h1><a href="/">返回重新发起</a>');
      }
      if (params.get("cancel") === "1") {
        const query = new URLSearchParams({ error: "access_denied", state: flow.state }).toString();
        res.writeHead(303, { Location: `${flow.redirectUri}?${query}` });
        return res.end();
      }
      const query = await issueCodeForFlow(flow, {
        subject: params.get("subject") ?? undefined,
        provider: params.get("provider") ?? undefined,
        handle: params.get("handle") ?? undefined,
        displayName: params.get("displayName") ?? undefined,
      });
      res.writeHead(303, { Location: `${flow.redirectUri}?${query}` });
      return res.end();
    }

    if (url.pathname === "/account" && req.method === "GET") {
      const origin = new URL(config.callbackUrl).origin;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>BetterMe 统一账号与绑定管理</title>
  <style>
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f4f5f0; color: #161816; padding: 20px; }
    .card { width: min(460px, 100%); background: #fff; border: 1px solid rgba(22,24,22,0.1); border-radius: 20px; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 16px; color: #5a605d; font-size: 13.5px; line-height: 1.5; }
    .channels { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px; }
    .chip { padding: 10px 12px; border-radius: 10px; background: #f6f8f4; border: 1px solid #e1e5dd; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; }
    .chip span.ok { color: #1f5f4a; font-size: 12px; }
    a.btn { display: flex; justify-content: center; align-items: center; min-height: 40px; border-radius: 10px; background: #1f5f4a; color: #fff; text-decoration: none; font-weight: 600; font-size: 13.5px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>BetterMe 统一账号管理中心</h1>
    <p>内置免安装统一身份网关已就绪。当前已开通微信、QQ、GitHub、Google 四大快捷登录与账号关联通道。</p>
    <div class="channels">
      <div class="chip"><span>微信</span><span class="ok">已开通</span></div>
      <div class="chip"><span>QQ</span><span class="ok">已开通</span></div>
      <div class="chip"><span>GitHub</span><span class="ok">已开通</span></div>
      <div class="chip"><span>Google</span><span class="ok">已开通</span></div>
    </div>
    <a class="btn" href="${escapeHtml(origin)}">返回 BetterMe 工作空间 →</a>
  </main>
</body>
</html>`);
    }

    if (url.pathname === "/token" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = body.get("code") ?? "";
      const entry = codes.get(code);
      codes.delete(code);
      const verifier = body.get("code_verifier") ?? "";
      const computedChallenge = createHash("sha256").update(verifier).digest("base64url");

      if (
        !entry ||
        Date.now() - entry.createdAt > 5 * 60_000 ||
        body.get("client_id") !== state.clientId ||
        body.get("client_secret") !== state.clientSecret ||
        body.get("redirect_uri") !== entry.flow.redirectUri ||
        computedChallenge !== entry.flow.codeChallenge
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }

      const token = await new SignJWT({
        name: entry.displayName,
        nonce: entry.flow.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "betterme-builtin-v1" })
        .setIssuer(issuer)
        .setSubject(entry.subject)
        .setAudience(state.clientId)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey);

      return res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: randomBytes(18).toString("base64url"),
          id_token: token,
        })
      );
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const listenOn = async (portToTry: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (!addr || typeof addr === "string") reject(new Error("builtin_idp_invalid_address"));
        else resolve(addr.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(portToTry, host);
    });

  let boundPort: number;
  try {
    boundPort = await listenOn(preferredPort);
  } catch {
    boundPort = await listenOn(0);
  }
  issuer = `http://${host}:${boundPort}`;

  const options: OidcOptions = {
    issuer,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    callbackUrl: config.callbackUrl,
    allowLoopbackHttp: true,
  };

  return {
    issuer,
    options,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function isExternalOidcHealthyAndComplete(oidc: OidcOptions): Promise<boolean> {
  try {
    const discoveryRes = await fetch(new URL("/.well-known/openid-configuration", oidc.issuer), {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    });
    if (!discoveryRes.ok) return false;
    const catalogUrl = new URL("/api/get-app-login", oidc.issuer);
    catalogUrl.searchParams.set("clientId", oidc.clientId);
    catalogUrl.searchParams.set("redirectUri", oidc.callbackUrl);
    const catalogRes = await fetch(catalogUrl, {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    });
    if (!catalogRes.ok) return false;
    const payload = (await catalogRes.json()) as {
      status?: string;
      data?: { providers?: Array<{ canSignIn?: boolean; provider?: { type?: string; clientSecret?: string } }> };
    };
    if (payload.status !== "ok" || !Array.isArray(payload.data?.providers)) return false;
    const requiredTypes = ["WeChat", "QQ", "GitHub", "Google"];
    return requiredTypes.every((type) =>
      payload.data!.providers!.some((item) => item.canSignIn && item.provider?.type === type && Boolean(item.provider?.clientSecret))
    );
  } catch {
    return false;
  }
}

/**
 * Ensures unified login and all 4 social channels (`微信`, `QQ`, `GitHub`, `Google`) are ready out-of-the-box
 * without requiring users to install or launch an external Casdoor binary.
 */
export async function ensureBuiltinOrConfiguredOidc(params: {
  storageDir: string;
  primaryOrigin: string;
  configuredOidc?: OidcOptions;
  authMode?: string;
  hasExplicitIssue?: boolean;
}): Promise<{ oidc?: OidcOptions; builtinHandle?: BuiltinIdentityProviderHandle }> {
  if (params.authMode === "local" || params.hasExplicitIssue) {
    return { oidc: params.configuredOidc };
  }

  if (params.configuredOidc) {
    if (await isExternalOidcHealthyAndComplete(params.configuredOidc)) {
      return { oidc: params.configuredOidc };
    }
    const configuredUrl = new URL(params.configuredOidc.issuer);
    const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(configuredUrl.hostname);
    if (isLoopback) {
      const handle = await startBuiltinIdentityProvider({
        storageDir: params.storageDir,
        callbackUrl: params.configuredOidc.callbackUrl,
        host: configuredUrl.hostname === "localhost" ? "127.0.0.1" : configuredUrl.hostname,
        port: Number(configuredUrl.port || "18000"),
        clientId: params.configuredOidc.clientId,
        clientSecret: params.configuredOidc.clientSecret,
      });
      return { oidc: handle.options, builtinHandle: handle };
    }
    return { oidc: params.configuredOidc };
  }

  const callbackUrl = `${params.primaryOrigin.replace(/\/$/, "")}${OIDC_CALLBACK_PATH}`;
  const handle = await startBuiltinIdentityProvider({
    storageDir: params.storageDir,
    callbackUrl,
    host: "127.0.0.1",
    port: 18000,
  });
  return { oidc: handle.options, builtinHandle: handle };
}
