// Inputs come exclusively from the original Host records rebuilt by reviewCollection.
// Model text, daily owner totals and configured allowances are not invocation receipts.
const rate = (numerator, denominator) => ({
  numerator, denominator, percent: denominator > 0 ? 100 * numerator / denominator : null,
});

const directReads = new Set(["discover_tools", "decompose_job", "list_evidence", "read_evidence", "read_job",
  "read_resume", "search_materials", "read_material", "list_directory", "search_directory", "read_file"]);
const dispatchedTools = new Set([...directReads, "build_tool", "use_tool"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function toolOutcomes(record) {
  const { kind, usage } = record.task;
  const career = kind === "resume_tailor" || kind === undefined;
  const byCall = new Map();
  let succeeded = 0, failed = 0;
  for (const entry of record.recent) {
    if (!object(entry)) continue;
    if (career && (Object.hasOwn(entry, "call") || Object.hasOwn(entry, "status"))) {
      if (!Number.isSafeInteger(entry.call) || entry.call < 1 || entry.call > usage.toolCalls) continue;
      // New Host journals use one slot per reservation. A missing or
      // contradictory result cannot supply a second outcome for that charge.
      let outcome = null;
      if (entry.status === "observed" && entry.request?.kind === "tool" && entry.request.tool === entry.tool
          && dispatchedTools.has(entry.tool) && Array.isArray(entry.evidenceIds) && object(entry.result)) {
        if (!Object.hasOwn(entry.result, "error")) outcome = "success";
        else if (typeof entry.result.error === "string") outcome = "failure";
      }
      if (byCall.has(entry.call)) byCall.set(entry.call, null);
      else byCall.set(entry.call, outcome);
    } else if (career && directReads.has(entry.tool)
        && Array.isArray(entry.evidenceIds) && object(entry.result)) {
      if (!Object.hasOwn(entry.result, "error")) succeeded++;
      else if (typeof entry.result.error === "string") failed++;
    } else if (kind === "project_understanding" && Object.hasOwn(entry,"call")) {
      if (!Number.isSafeInteger(entry.call) || entry.call < 1 || entry.call > usage.toolCalls) continue;
      const read = typeof entry.operation === "string" && entry.request?.operation === entry.operation && Array.isArray(entry.evidenceIds);
      const verification = entry.kind === "project_verification_result" && ["model_source_version","selected_quote","human_confirmation"].includes(entry.check)
        && typeof entry.grantId === "string" && typeof entry.path === "string" && typeof entry.hash === "string";
      let outcome = null;
      if ((read || verification) && object(entry.result)) {
        if (typeof entry.result.error?.code === "string") outcome = "failure";
        else if (!Object.hasOwn(entry.result,"error") && (read || entry.result.verified === true)) outcome = "success";
      }
      byCall.set(entry.call,byCall.has(entry.call)?null:outcome);
    } else if (kind === "project_understanding" && typeof entry.operation === "string" && entry.request?.operation === entry.operation
        && Array.isArray(entry.evidenceIds) && object(entry.result)) {
      if (!Object.hasOwn(entry.result, "error")) succeeded++;
      else if (typeof entry.result.error?.code === "string") failed++;
    } else if ((kind === "jd_match" && entry.kind === "jd_match_read" || kind === "mock_interview" && entry.kind === "mock_interview_read")
        && typeof entry.evidenceId === "string" && entry.requested?.kind === "read_evidence" && object(entry.actual)) succeeded++;
  }
  for (const outcome of byCall.values()) {
    if (outcome === "success") succeeded++;
    if (outcome === "failure") failed++;
  }
  // Each of these Host result records follows one reservation. A contradictory
  // archive cannot establish an outcome denominator for this member.
  if (succeeded + failed > usage.toolCalls) return { succeeded: 0, failed: 0 };
  return { succeeded, failed };
}

function firstTurnMs(task) {
  const starts = task.events.filter(event => event.kind === "started");
  if (starts.length !== 1) return null;
  const end = task.status === "awaiting_answer" ? task.reply?.createdAt
    : task.events.findLast(event => event.kind === "stopped" && event.sequence > starts[0].sequence)?.at;
  const elapsed = Date.parse(end) - Date.parse(starts[0].at);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function archivedProviderObservations({ task, recent }) {
  const byCall = new Map();
  for (const entry of recent) {
    if (!object(entry) || !object(entry.providerObservation)) continue;
    const ordinal = entry.providerCallOrdinal;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > task.usage.modelCalls) continue;
    const chatOutput = task.kind === "free_chat" && Number.isSafeInteger(entry.turn) && entry.turn > 0 && (
      entry.kind === "free_chat_output" && typeof entry.output === "string"
      || entry.kind === "free_chat_output_artifact" && task.outputArtifacts?.some(artifact => artifact.id === entry.artifact?.id
        && artifact.hash === entry.artifact.hash && artifact.bytes === entry.artifact.bytes));
    const writingOutput = (task.kind === "resume_tailor" || task.kind === undefined) && entry.kind === undefined
      && ["resume_text_plan", "resume_text_draft"].includes(entry.writingPhase) && typeof entry.output === "string"
      && Number.isSafeInteger(entry.runGeneration) && typeof entry.late === "boolean";
    const projectOutput = task.kind === "project_understanding" && Number.isSafeInteger(entry.turn) && entry.turn > 0 && (
      entry.kind === "project_understanding_output" && typeof entry.output === "string"
      || entry.kind === "project_understanding_output_artifact" && task.outputArtifacts?.some(artifact => artifact.id === entry.artifact?.id
        && artifact.hash === entry.artifact.hash && artifact.bytes === entry.artifact.bytes));
    if (!chatOutput && !writingOutput && !projectOutput) continue;
    const { wallMs, inputTokens, outputTokens } = entry.providerObservation;
    if (!Number.isFinite(wallMs) || wallMs < 0) continue;
    const observation = { wallMs };
    if (Number.isSafeInteger(inputTokens) && inputTokens >= 0) observation.inputTokens = inputTokens;
    if (Number.isSafeInteger(outputTokens) && outputTokens >= 0) observation.outputTokens = outputTokens;
    if (!byCall.has(ordinal)) byCall.set(ordinal, observation);
    else if (JSON.stringify(byCall.get(ordinal)) !== JSON.stringify(observation)) byCall.set(ordinal, null);
  }
  return [...byCall.values()].filter(Boolean);
}

export function observedRuntime(task, records, execution) {
  const root = task.rootLedger;
  if (new Set(records.map(record => record.task.id)).size !== root.memberCount || records.length !== root.memberCount
      || records.some(record => (record.task.rootTaskId ?? record.task.id) !== root.rootTaskId))
    throw Error("collection_runtime_root_members_changed");
  const outcomes = records.map(toolOutcomes);
  return {
    rootId: root.rootTaskId, maxActiveMs: root.budget.maxActiveMs, ...root.usage,
    succeeded: outcomes.reduce((sum, item) => sum + item.succeeded, 0),
    failed: outcomes.reduce((sum, item) => sum + item.failed, 0),
    taskElapsedMs: firstTurnMs(task),
    providerObservations: execution === "model" ? records.flatMap(archivedProviderObservations) : [],
  };
}

const median = sorted => sorted.length === 0 ? null
  : (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;

export function summarizeProviderObservations(observations, denominator) {
  const inputs = observations.filter(row => row.inputTokens !== undefined);
  const outputs = observations.filter(row => row.outputTokens !== undefined);
  const paired = inputs.filter(row => row.outputTokens !== undefined);
  const waits = observations.map(row => row.wallMs).sort((a, b) => a - b);
  const subtotal = (entries, key) => entries.length > 0 ? entries.reduce((sum, item) => sum + item[key], 0) : null;
  return {
    coverageDenominator: "verified_model_budget_charges",
    inputTokenCoverage: rate(inputs.length, denominator), inputTokens: subtotal(inputs, "inputTokens"),
    outputTokenCoverage: rate(outputs.length, denominator), outputTokens: subtotal(outputs, "outputTokens"),
    tokenCoverage: rate(paired.length, denominator),
    pairedTokens: { inputTokens: subtotal(paired, "inputTokens"), outputTokens: subtotal(paired, "outputTokens") },
    timingCoverage: rate(waits.length, denominator),
    hostWaitMs: { observedSum: subtotal(observations, "wallMs"), median: median(waits), maximum: waits.at(-1) ?? null },
    chargesWithoutProviderObservation: denominator === null ? null : denominator - observations.length,
    providerLatencyMs: null, billingCoverage: rate(0, denominator), billedAmount: null, currency: null,
  };
}

/** Keep the planned-case denominator even if no task or archive was recovered. */
export function campaignRuntimeQuality(results, observations) {
  const planned = results.length, rows = results.map(result => observations.get(result.caseId)).filter(Boolean);
  const roots = new Set();
  for (const row of rows) {
    if (roots.has(row.rootId)) throw Error("collection_runtime_root_reused");
    roots.add(row.rootId);
  }
  const sum = field => rows.reduce((total, row) => total + row[field], 0);
  const verifiedCases = rows.length, ledgerCoverage = rate(verifiedCases, planned);
  const modelCharges = sum("modelCalls"), toolCharges = sum("toolCalls");
  const successes = sum("succeeded"), failures = sum("failed"), returned = successes + failures;
  const elapsed = rows.map(row => row.taskElapsedMs).filter(value => value !== null).sort((a, b) => a - b);
  const frozen = results.filter(result => result.outcome === "frozen").length;
  return {
    taskDelivery: { ...rate(frozen, planned), failed: results.filter(result => result.outcome === "failure").length,
      unresolved: results.filter(result => result.outcome === "unresolved").length },
    userAdoption: { observedDecisions: 0, frozenCandidates: frozen, adopted: null, percent: null },
    ledgerCoverage,
    budget: { modelCharges: verifiedCases > 0 ? modelCharges : null, toolCharges: verifiedCases > 0 ? toolCharges : null, activeMs: verifiedCases > 0 ? sum("activeMs") : null,
      maxActiveMsForVerifiedRoots: verifiedCases > 0 ? sum("maxActiveMs") : null },
    tools: { returnedSuccess: rate(successes, returned), returnedFailures: failures,
      outcomeCoverageOfCharges: rate(returned, verifiedCases > 0 ? toolCharges : null), chargesWithoutOutcome: verifiedCases > 0 ? toolCharges - returned : null,
      campaignSuccessPercent: verifiedCases === planned && returned === toolCharges ? rate(successes, returned).percent : null },
    taskElapsed: { from: "host_first_start_to_reply_or_stop", caseCoverage: rate(elapsed.length, planned), medianMs: median(elapsed),
      maximumMs: elapsed.at(-1) ?? null },
    providerUsage: summarizeProviderObservations(rows.flatMap(row => row.providerObservations), verifiedCases > 0 ? modelCharges : null),
  };
}

export function runtimeQualityMarkdown(metrics) {
  const fraction = item => `${item.numerator}/${item.denominator ?? "未知"}`;
  const ratio = item => item.percent === null ? `${fraction(item)}（无分母）` : `${fraction(item)}（${Number(item.percent.toFixed(1))}%）`;
  const tools = metrics.tools, usage = metrics.providerUsage, budget = metrics.budget, elapsed = metrics.taskElapsed;
  const duration = ms => ms === null ? "未观测" : `${ms} ms`;
  return [
    "## 任务运行质量", "",
    `- 冻结候选交付率 ${ratio(metrics.taskDelivery)}，失败 ${metrics.taskDelivery.failed}，未决 ${metrics.taskDelivery.unresolved}。用户采纳决策未采集。`,
    `- 根账覆盖 ${fraction(metrics.ledgerCoverage)} 个计划案例。已核验根账登记模型尝试 ${budget.modelCharges ?? "未知"} 次、工具尝试 ${budget.toolCharges ?? "未知"} 次。累计活动时间 ${duration(budget.activeMs)}，对应活动时间上限 ${duration(budget.maxActiveMsForVerifiedRoots)}。`,
    `- 有明确 Host 返回的工具调用成功 ${ratio(tools.returnedSuccess)}，返回错误 ${tools.returnedFailures} 次。结果覆盖 ${fraction(tools.outcomeCoverageOfCharges)} 个已登记工具尝试，结果未确认的次数为 ${tools.chargesWithoutOutcome ?? "未知"}。全批工具成功率${tools.campaignSuccessPercent === null ? "不可计算" : ` ${Number(tools.campaignSuccessPercent.toFixed(1))}%`}。`,
    `- 原任务首次启动至回复或停止的耗时覆盖 ${fraction(elapsed.caseCoverage)} 个计划案例，中位数 ${duration(elapsed.medianMs)}，最长 ${duration(elapsed.maximumMs)}。`,
    `- 已观测输入 token 小计 ${usage.inputTokens ?? "未知"}（覆盖 ${fraction(usage.inputTokenCoverage)} 次已登记模型尝试），输出小计 ${usage.outputTokens ?? "未知"}（${fraction(usage.outputTokenCoverage)}）。两侧完整回执 ${fraction(usage.tokenCoverage)}。`,
    `- Host 等待提供商返回的耗时覆盖 ${fraction(usage.timingCoverage)}，中位数 ${duration(usage.hostWaitMs.median)}，最长 ${duration(usage.hostWaitMs.maximum)}。实付费用凭据覆盖 ${fraction(usage.billingCoverage)}，金额未知。`,
    `- 已核验根账中，${usage.chargesWithoutProviderObservation ?? "未知"} 次模型尝试缺少可关联到该次返回的观测。旧归档和传输中断均可能出现缺测。`,
  ].join("\n");
}
