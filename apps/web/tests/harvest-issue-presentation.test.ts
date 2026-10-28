import assert from "node:assert/strict";
import test from "node:test";
import type { LiveHarvestProvider } from "../src/components/atlas/live-harvest-view";
import type { HarvestProgressState } from "../src/components/atlas/harvest-progress-presentation";
import { sanitizeHarvestDiagnostic, summarizeHarvestIssues } from "../src/components/atlas/harvest-issue-presentation";

function provider(overrides: Partial<LiveHarvestProvider> = {}): LiveHarvestProvider {
  return {
    provider: "51job", platform: "51JOB", status: "ready", cardCount: 40,
    pagesVisited: 2, scrollSteps: 0, warnings: [],
    coverage: { pagesVisited: 2, scrollSteps: 0, scrollLimit: 0, pageLimit: 10, cardLimit: 500, stopReason: "exhausted", partial: false },
    ...overrides,
  };
}

function completed(stats: HarvestProgressState["stats"] = {}): HarvestProgressState {
  return { stage: "completed", stageIndex: 5, totalStages: 5, message: "本轮处理已结束", stats };
}

test("a login receipt names the required action without blaming the service", () => {
  const [issue] = summarizeHarvestIssues({ providers: [provider({ status: "login_required" })] });
  assert.equal(issue!.source, "51JOB");
  assert.equal(issue!.scope, "source");
  assert.equal(issue!.severity, "warning");
  assert.equal(issue!.action.kind, "login");
  assert.equal(issue!.action.provider, "51job");
  assert.match(issue!.reason, /平台要求.*登录/);
  assert.doesNotMatch(issue!.reason, /服务故障|预算|验证码/);
});

test("structured verification, layout and reader limits remain distinct even when free text says something else", () => {
  const cases = [
    { status: "verification_required", title: /验证/, kind: "login", reason: /验证码|安全验证/ },
    { status: "unknown_layout", title: /列表|页面/, kind: "details", reason: /未.*识别/ },
    { status: "oversized", title: /上限/, kind: "details", reason: /读取上限/ },
    { status: "unsupported_page", title: /不支持/, kind: "details", reason: /不支持/ },
  ] as const;
  for (const expected of cases) {
    const [issue] = summarizeHarvestIssues({ providers: [provider({ status: expected.status, error: "token rejected; login_required? 未确认诊断" })] });
    assert.match(issue!.title, expected.title);
    assert.match(issue!.reason, expected.reason);
    assert.equal(issue!.action.kind, expected.kind);
    assert.ok(issue!.rawDetails.includes("token rejected; login_required? 未确认诊断"));
    assert.equal(issue!.severity, "warning");
  }
});

test("actual errors are visible without guessing login from text and missing causes are admitted", () => {
  const [known] = summarizeHarvestIssues({ providers: [provider({ status: "error", error: "captcha failed; login required? 这是原始返回", warnings: ["已收到的卡片仍保留"] })] });
  assert.equal(known!.severity, "error");
  assert.equal(known!.action.kind, "details", "unstructured text must not select a login action");
  assert.match(known!.reason, /captcha failed; login required\? 这是原始返回/);
  assert.deepEqual(known!.rawDetails, ["captcha failed; login required? 这是原始返回", "已收到的卡片仍保留"]);
  const [unknown] = summarizeHarvestIssues({ providers: [provider({ status: "error" })] });
  assert.match(unknown!.reason, /平台未返回具体原因/);
  const [partialFailure] = summarizeHarvestIssues({ providers: [provider({ coverage: { ...provider().coverage, stopReason: "error", partial: true }, error: "第 3 页读取超时" })] });
  assert.match(partialFailure!.title, /部分页面.*失败/);
  assert.match(partialFailure!.reason, /第 3 页读取超时/);
  assert.doesNotMatch(partialFailure!.reason, /没有岗位|全部失败|已保存.*0/);
});

test("coverage budgets, stalled pages, verification gates, cancellation and partial coverage are not service failures", () => {
  const cases = [
    { stopReason: "page_limit", title: /页数.*上限/, reason: /2.*10.*页/, severity: "info", kind: "resume" },
    { stopReason: "scroll_limit", title: /滚动.*上限/, reason: /滚动/, severity: "info", kind: "resume" },
    { stopReason: "card_limit", title: /卡片.*上限/, reason: /500.*张/, severity: "info", kind: "resume" },
    { stopReason: "no_progress", title: /进展|变化/, reason: /未确认.*变化/, severity: "warning", kind: "resume" },
    { stopReason: "gate", title: /登录.*验证/, reason: /未返回具体.*类型/, severity: "warning", kind: "login" },
    { stopReason: "cancelled", title: /停止/, reason: /未.*页面.*不计作.*覆盖/, severity: "info", kind: "resume" },
  ] as const;
  for (const expected of cases) {
    const [issue] = summarizeHarvestIssues({ failed: true, providers: [provider({ coverage: { ...provider().coverage, stopReason: expected.stopReason, partial: true } })] });
    assert.match(issue!.title, expected.title);
    assert.match(issue!.reason, expected.reason);
    assert.equal(issue!.severity, expected.severity);
    assert.equal(issue!.action.kind, expected.kind);
    assert.doesNotMatch(issue!.reason, /服务.*失败|服务故障|平台未返回具体原因/);
  }
  const [partial] = summarizeHarvestIssues({ providers: [provider({ coverage: { ...provider().coverage, partial: true }, warnings: ["仅返回部分列表"] })] });
  assert.match(partial!.title, /部分覆盖/);
  assert.match(partial!.reason, /仅返回部分列表/);
  assert.equal(partial!.severity, "warning");
  assert.deepEqual(summarizeHarvestIssues({ providers: [provider(), provider({ status: "empty", cardCount: 0 })] }), []);
});

test("active providers are not budget failures and unfinished providers require a final receipt before completion", () => {
  for (const status of ["running", "queued"] as const) {
    const pending = provider({ status, coverage: { ...provider().coverage, stopReason: "page_limit", partial: true } });
    assert.deepEqual(summarizeHarvestIssues({ providers: [pending] }), [], "progress placeholders are not budget receipts");
    const [failed] = summarizeHarvestIssues({ providers: [pending], failed: true, progress: completed() });
    assert.match(failed!.title, /最终回执/);
    assert.match(failed!.reason, /未返回最终回执/);
    assert.doesNotMatch(failed!.reason, /无岗位|达到.*预算|全部读取成功/);
    const [cancelled] = summarizeHarvestIssues({ providers: [pending], cancelled: true });
    assert.equal(cancelled!.severity, "info");
    assert.match(cancelled!.reason, /停止.*最终回执/);
  }
  const [stopped] = summarizeHarvestIssues({ providers: [provider({ status: "cancelled" })] });
  assert.equal(stopped!.severity, "info");
  assert.match(stopped!.title, /停止/);
});

test("query diagnostics stay visible, duplicate platform errors collapse and unexplained failures are explicit", () => {
  const progress = completed({ queryTermError: "51JOB：页面加载超时", failedPlatforms: 1 });
  const [query] = summarizeHarvestIssues({ progress, failed: true });
  assert.equal(query!.scope, "query");
  assert.equal(query!.reason, "51JOB：页面加载超时");
  assert.deepEqual(query!.rawDetails, ["51JOB：页面加载超时"]);
  const combined = summarizeHarvestIssues({ progress, providers: [provider({ status: "error", error: "页面加载超时" })], failed: true });
  assert.equal(combined.length, 1);
  assert.equal(combined[0]!.scope, "source");
  const [unknown] = summarizeHarvestIssues({ progress: completed({ failedPlatforms: 1 }), failed: true });
  assert.equal(unknown!.scope, "run");
  assert.match(unknown!.reason, /平台未返回具体原因/);
  assert.doesNotMatch(unknown!.reason, /登录验证拦截或达到采集预算|网络故障|验证码/);
  assert.deepEqual(summarizeHarvestIssues({}), []);
  const budget = summarizeHarvestIssues({ failed: true, providers: [provider({ coverage: { ...provider().coverage, stopReason: "page_limit", partial: true } })] });
  assert.equal(budget.length, 1, "a coarse failed flag must not turn a known budget stop into an unexplained service failure");
  assert.equal(budget[0]!.severity, "info");
});

test("unconfirmed ingestion is independent of source errors and takes priority without inventing a cause", () => {
  const progress = completed({ failedCards: 15, cancelledCards: 2, committedCards: 1122 });
  const issues = summarizeHarvestIssues({ failed: true, progress, providers: [
    provider({ provider: "boss", platform: "BOSS直聘", status: "login_required" }),
    provider({ coverage: { ...provider().coverage, stopReason: "page_limit", partial: true } }),
    provider({ provider: "linkedin", platform: "LinkedIn", status: "error", error: "分页请求没有响应" }),
  ] });
  assert.deepEqual(issues.map(issue => issue.scope), ["ingestion", "source", "source", "source"]);
  assert.match(issues[0]!.reason, /17.*保存结果待确认/);
  assert.match(issues[0]!.reason, /未收到回执不等于未写入/);
  assert.match(issues[0]!.advice, /已确认保存.*不受影响/);
  assert.doesNotMatch(issues[0]!.reason, /登录|页面|超时|网络/);
  assert.equal(issues[0]!.action.kind, "details");
  assert.equal(issues[1]!.severity, "error");
  assert.equal(issues[2]!.action.kind, "login");
  assert.equal(issues[3]!.severity, "info");
  assert.equal(summarizeHarvestIssues({ failed: true, progress }).length, 1, "unconfirmed writes alone do not imply a platform failure");
  const ongoing = { ...completed({ pendingCards: 5 }), stage: "cas-ingestion" as const };
  assert.deepEqual(summarizeHarvestIssues({ progress: ongoing }), []);
  assert.equal(summarizeHarvestIssues({ progress: completed({ pendingCards: 5 }) })[0]!.scope, "ingestion");
  assert.deepEqual(summarizeHarvestIssues({ progress: completed({ failedCards: Number.NaN, cancelledCards: -1 }) }), []);
});

test("reported import failures and run catches remain visible without deriving extra unconfirmed counts", () => {
  const issues = summarizeHarvestIssues({ failed: true, progress: completed({ failedCards: 15, committedCards: 1122, cardsFetched: 1220 }),
    importFailures: [{ platform: "51JOB", cards: 15, error: "入库请求返回 503" }, { platform: "51JOB", cards: 15, error: "入库请求返回 503" }],
    failureMessage: "本轮提交无法确认：等待回执超时",
  });
  assert.equal(issues[0]!.scope, "ingestion");
  assert.match(issues[0]!.reason, /15.*保存结果待确认/);
  assert.match(issues[0]!.reason, /51JOB.*入库请求返回 503/);
  assert.doesNotMatch(issues[0]!.reason, /30 张|98 张|平台未返回具体原因/);
  assert.deepEqual(issues[0]!.rawDetails, ["51JOB（15 张卡片）：入库请求返回 503"]);
  assert.equal(issues[1]!.scope, "run");
  assert.equal(issues[1]!.reason, "本轮提交无法确认：等待回执超时");
  const [withoutCounter] = summarizeHarvestIssues({ importFailures: [{ platform: "LinkedIn", cards: 22, error: "本地写入请求超时" }] });
  assert.match(withoutCounter!.reason, /LinkedIn.*本地写入请求超时/);
  assert.doesNotMatch(withoutCounter!.reason, /22 张卡片尚未|未确认总数[：:\s]*22/);
  const [oversized] = summarizeHarvestIssues({ providers: [provider({ status: "oversized" })] });
  assert.match(oversized!.advice, /缩小范围.*重新采集/);
  assert.equal(oversized!.action.kind, "details", "resume must not imply changed terms will replace a saved checkpoint input");
});

test("all diagnostic surfaces redact common credentials while retaining real causes and full safe details", () => {
  const diagnostic = "页面加载超时 https://user:password-secret@example.test/search?q=Java&token=url-secret&access%5Ftoken=encoded-secret&X-Amz-Credential=aws-secret#credential=fragment-secret\nAuthorization: Bearer bearer-secret\nCookie: session=cookie-secret; theme=dark\napi_key=key-secret client_secret: client-secret password='quoted secret'";
  const sanitized = sanitizeHarvestDiagnostic(diagnostic);
  for (const secret of ["password-secret", "url-secret", "encoded-secret", "aws-secret", "fragment-secret", "bearer-secret", "cookie-secret", "key-secret", "client-secret", "quoted secret"]) {
    assert.ok(!sanitized.includes(secret), `credential ${secret} must not reach presentation`);
  }
  assert.match(sanitized, /页面加载超时/);
  assert.match(sanitized, /q=Java/);
  assert.match(sanitized, /已隐藏/);
  const issues = summarizeHarvestIssues({ providers: [provider({ status: "error", error: diagnostic, warnings: ["Authorization: Basic basic-secret"] })],
    failureMessage: diagnostic, importFailures: [{ platform: "51JOB", cards: 2, error: "token=import-secret" }],
    progress: completed({ queryTermError: "检索结束：token=query-secret" }),
  });
  const exposed = JSON.stringify(issues);
  assert.doesNotMatch(exposed, /url-secret|bearer-secret|basic-secret|import-secret|query-secret/);
  const full = `页面加载超时。${"完整诊断".repeat(1500)}终点标记`;
  const [long] = summarizeHarvestIssues({ providers: [provider({ status: "error", error: full })] });
  assert.equal(long!.reason, full, "presentation does not truncate an actual cause");
  assert.equal(long!.rawDetails[0], full);
  assert.equal(sanitizeHarvestDiagnostic("captcha failed; login_required? 未确认诊断"), "captcha failed; login_required? 未确认诊断");
});

test("diagnostic redaction is repeatable and handles quoted JSON credentials without destroying safe text", () => {
  const value = 'HTTP 401 {"token":"json-secret","credential":"credential-secret","message":"连接已拒绝"} /search?token=query-secret Bearer bearer-secret';
  const once = sanitizeHarvestDiagnostic(value);
  assert.equal(sanitizeHarvestDiagnostic(once), once, "presentation wrappers may safely sanitize an already sanitized diagnosis");
  assert.doesNotMatch(once, /json-secret|credential-secret|query-secret|bearer-secret/);
  assert.match(once, /连接已拒绝/);
  assert.equal(sanitizeHarvestDiagnostic(undefined), "");
});

test("aggregate receipt counters stay actionable and a query cause is never deduplicated into a hidden healthy receipt", () => {
  const [blocked] = summarizeHarvestIssues({ failed: true, progress: completed({ blockedPlatforms: 2 }) });
  assert.equal(blocked!.action.kind, "login");
  assert.match(blocked!.reason, /2.*平台.*登录.*验证/);
  assert.equal(blocked!.severity, "warning");
  const [partial] = summarizeHarvestIssues({ failed: true, progress: completed({ partialPlatforms: 1 }) });
  assert.match(partial!.title, /部分覆盖/);
  assert.notEqual(partial!.severity, "error");
  const [query] = summarizeHarvestIssues({ progress: completed({ queryTermError: "51JOB：加载超时" }), providers: [provider({ error: "加载超时" })] });
  assert.equal(query!.scope, "query");
  assert.equal(query!.reason, "51JOB：加载超时");
  const layout = summarizeHarvestIssues({ failed: true, progress: completed({ queryTermError: "51JOB：列表没有被识别", failedQueryTerms: 1 }),
    providers: [provider({ status: "unknown_layout", error: "列表没有被识别" })] });
  assert.equal(layout.length, 1, "a displayed known cause must not be paired with an unknown-cause claim");
  assert.doesNotMatch(layout[0]!.reason, /平台未返回具体原因/);
});

test("failure counters do not obscure a known layout cause with an unexplained aggregate failure", () => {
  const issues = summarizeHarvestIssues({
    failed: true,
    progress: completed({ failedPlatforms: 1 }),
    providers: [provider({ status: "unknown_layout", error: "页面加载超时：30秒未识别招聘列表" })],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.scope, "source");
  assert.match(issues[0]!.reason, /页面加载超时：30秒未识别招聘列表/);
  assert.doesNotMatch(issues[0]!.reason, /平台未返回具体原因/);
  assert.equal(issues[0]!.action.kind, "details");

  const budget = summarizeHarvestIssues({
    progress: completed({ failedPlatforms: 1 }),
    providers: [provider({ coverage: { ...provider().coverage, stopReason: "page_limit", partial: true } })],
  });
  assert.equal(budget.length, 2, "a budget stop alone does not explain a separately reported platform failure");
  assert.equal(budget[0]!.id, "run:unexplained");
  assert.equal(budget[1]!.severity, "info");
});

test("warning-only failure diagnostics remain visible without a contradictory missing-cause claim", () => {
  for (const receipt of [
    provider({ status: "error", warnings: ["  ", "第3页读取超时", "login_required? 未确认诊断"] }),
    provider({ status: "running", warnings: ["第3页读取超时"] }),
  ]) {
    const [issue] = summarizeHarvestIssues({ providers: [receipt], progress: completed() });
    assert.match(issue!.reason, /第3页读取超时/);
    assert.doesNotMatch(issue!.reason, /平台未返回具体原因/);
    assert.equal(issue!.action.kind, "details", "warning text cannot imply a structured login requirement");
    assert.ok(issue!.rawDetails.includes("第3页读取超时"));
  }
  const [unknown] = summarizeHarvestIssues({ providers: [provider({ status: "error", error: "  ", warnings: [" "] })] });
  assert.match(unknown!.reason, /平台未返回具体原因/);
});

test("X-API-Key headers and URL keys are redacted on every diagnostic surface", () => {
  const diagnostic = "Request failed; X-API-Key: synthetic-header-secret\nhttps://example.test/jobs?q=C%23&X-API-Key=synthetic-url-secret";
  const sanitized = sanitizeHarvestDiagnostic(diagnostic);
  assert.doesNotMatch(sanitized, /synthetic-header-secret|synthetic-url-secret/);
  assert.match(sanitized, /Request failed/);
  assert.match(sanitized, /q=C%23/);
  assert.equal(sanitizeHarvestDiagnostic(sanitized), sanitized);
  const exposed = JSON.stringify(summarizeHarvestIssues({
    providers: [provider({ status: "error", error: diagnostic })],
    importFailures: [{ platform: "51JOB", cards: 2, error: diagnostic }],
  }));
  assert.doesNotMatch(exposed, /synthetic-header-secret|synthetic-url-secret/);
});

test("in-flight partial counters wait for settlement before claiming a missing stop reason", () => {
  const progress = { ...completed({ partialPlatforms: 3 }), stage: "platform-harvest" as const };
  const providers = [provider({ status: "running" }), provider({ provider: "boss", platform: "BOSS直聘", status: "running" })];
  assert.deepEqual(summarizeHarvestIssues({ progress, providers }), []);
  assert.deepEqual(summarizeHarvestIssues({ progress }), []);
  for (const settlement of [{ failed: true }, { cancelled: true }, { progress: completed({ partialPlatforms: 3 }) }]) {
    const issues = summarizeHarvestIssues({ progress, ...settlement });
    assert.equal(issues[0]!.id, "run:partial");
    assert.match(issues[0]!.reason, /3.*部分覆盖/);
  }
  const [gate] = summarizeHarvestIssues({ progress: { ...progress, stats: { blockedPlatforms: 1 } } });
  assert.equal(gate!.action.kind, "login", "an explicit gate receipt remains actionable while other providers run");
});

test("import diagnostics keep their original punctuation without adding a duplicate sentence ending", () => {
  const [issue] = summarizeHarvestIssues({ importFailures: [{ platform: "51JOB", cards: 2, error: "入库请求返回 503。" }] });
  assert.match(issue!.reason, /入库请求返回 503。$/);
  assert.doesNotMatch(issue!.reason, /。。/);
  assert.deepEqual(issue!.rawDetails, ["51JOB（2 张卡片）：入库请求返回 503。"]);
});
