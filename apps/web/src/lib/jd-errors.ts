export type JdFailureCode =
  | "invalid_link" | "network" | "timeout" | "login_required" | "verification_required" | "access_denied"
  | "rate_limited" | "unavailable" | "ambiguous_jobs" | "job_mismatch"
  | "unsupported_page" | "service_unavailable" | "browser_unavailable" | "browser_setup_required" | "browser_required" | "browser_session_expired";

export type JdFailure = {
  code: JdFailureCode;
  stage: "link" | "connect" | "http" | "page" | "service";
  message: string;
  status?: number;
  retryAfterSeconds?: number;
};

const codes = new Set<JdFailureCode>([
  "invalid_link", "network", "timeout", "login_required", "verification_required", "access_denied", "rate_limited",
  "unavailable", "ambiguous_jobs", "job_mismatch", "unsupported_page", "service_unavailable", "browser_unavailable", "browser_setup_required", "browser_required", "browser_session_expired",
]);
const stages = new Set<JdFailure["stage"]>(["link", "connect", "http", "page", "service"]);

export class JdExtractionError extends Error {
  readonly failure: JdFailure;
  constructor(failure: JdFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "JdExtractionError";
    this.failure = failure;
  }
}

/** Created only by the local client after an exact startup cancellation was unconfirmed. */
export class JdBrowserStartCleanupError extends JdExtractionError {
  constructor(readonly input: string, readonly requestId: string, message: string, options?: ErrorOptions) {
    super({ code: "service_unavailable", stage: "service", message }, options);
    this.name = "JdBrowserStartCleanupError";
  }
}

/** Only accept the documented error fields; remote payloads cannot choose UI actions or URLs. */
export function readJdFailure(value: unknown): JdFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!codes.has(input.code as JdFailureCode) || !stages.has(input.stage as JdFailure["stage"]) || typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000) return null;
  const failure: JdFailure = { code: input.code as JdFailureCode, stage: input.stage as JdFailure["stage"], message: input.message };
  if (typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) failure.status = input.status;
  if (typeof input.retryAfterSeconds === "number" && Number.isFinite(input.retryAfterSeconds) && input.retryAfterSeconds >= 0) failure.retryAfterSeconds = Math.min(Math.ceil(input.retryAfterSeconds), 86400);
  return failure;
}

export function jdFailureGuidance(failure: JdFailure): { title: string; guidance: string; network: boolean } {
  switch (failure.code) {
    case "network": return failure.stage === "page"
      ? { title: "岗位正文读取中断", guidance: "已经收到网站响应，但正文未完整传输。请检查网络路线后再读，不会采用不完整正文。", network: true }
      : { title: "尚未连接到招聘网站", guidance: "还没有收到网页响应，暂不能判断是否需要登录或验证。检查代理路线；应用直连仍可能受系统 TUN 或全局网络影响。", network: true };
    case "timeout": return { title: "岗位读取超时", guidance: "当前路线未在限定时间内完成读取。可检查网络；请避免连续重复请求。", network: true };
    case "login_required": return { title: "网站要求登录", guidance: "请在专用招聘浏览器中自行登录，再回来读取原岗位。本站登录保存在本机，原网站可能要求再次验证。", network: false };
    case "verification_required": return { title: "网站要求访问验证", guidance: "可打开独立浏览器，在原网站自行处理访问验证，再回来读取原岗位。本软件不会自动处理验证码。", network: false };
    case "access_denied": return { title: "网站拒绝访问", guidance: "网站返回了拒绝访问的响应；仅凭这个状态不能确定是登录、验证码、地区还是其他限制。请打开原岗位核对。", network: false };
    case "rate_limited": return { title: "网站限制了请求频率", guidance: failure.retryAfterSeconds ? `网站建议至少等待 ${failure.retryAfterSeconds} 秒。请稍后再读，当前不会自动重试。` : "请稍后再读，当前不会自动重试。", network: false };
    case "unavailable": return { title: "岗位页面暂不可用", guidance: "请打开原岗位核对是否已下线、链接已失效，或站点正在维护；不会使用推荐岗位替代。", network: false };
    case "ambiguous_jobs": return { title: "无法确定目标岗位", guidance: "页面含有多条岗位。请复制具体岗位详情的链接，避免导入搜索页或推荐列表。", network: false };
    case "job_mismatch": return { title: "岗位来源不匹配", guidance: "返回的正文无法确认属于这个岗位链接。请打开原页核对，不会自动采用其他岗位。", network: false };
    case "invalid_link": return { title: "岗位链接需要检查", guidance: "请粘贴单个岗位的完整官方分享链接或分享消息。", network: false };
    case "service_unavailable": return { title: "岗位读取服务不可用", guidance: "请确认本地服务正在运行。纯静态网页需要配套岗位读取服务。", network: false };
    case "browser_unavailable": return { title: "浏览器读取暂不可用", guidance: "本地服务没有可用的浏览器运行环境，或浏览器未能启动。请按服务提示完成配置，再使用浏览器读取。", network: false };
    case "browser_setup_required": return { title: "请先完成 Edge 首次设置", guidance: "专用 Edge 正在显示浏览器账号或同步设置。请在该窗口完成或跳过设置，再点击“浏览器读取”；已有岗位页时点击“完成后读取原岗位”。可以跳过微软账号登录，窗口会保留，可从任务栏打开专用 Edge 查看。", network: false };
    case "browser_required": return { title: "岗位正文需要浏览器加载", guidance: "已收到网页，但正文需要执行网页脚本后加载。可点击“浏览器读取”；完成后仍需核对正文与来源。", network: false };
    case "browser_session_expired": return { title: "本次岗位页已结束", guidance: "请重新打开岗位页。岗位页最多保留 10 分钟；专用浏览器及本站登录保留，是否需要重新登录或验证由原网站决定。", network: false };
    case "unsupported_page": return { title: "网页中未找到可确认的岗位正文", guidance: "页面可能由浏览器动态加载，或页面结构尚未适配。请打开原页核对；网络连通并不能证明正文已取得。", network: false };
  }
}
