import {
  architectureGraphFingerprint, validateArchitectureDocument,
  type ArchitectureDocument, type ArchitectureEdge, type ArchitectureFaultKind,
  type ArchitectureFaultRun, type ArchitectureFaultState, type ArchitectureNode,
} from "./model";

const priority: Record<ArchitectureFaultState, number> = { failed: 4, "at-risk": 3, unknown: 2, contained: 1, unaffected: 0 };

/** 仅计算图上的假设传播；这里没有磁盘、网络、账号、进程或工具调用。 */
export function simulateArchitectureFault(document: ArchitectureDocument,
  fault: { kind: ArchitectureFaultKind; targetNodeId: string }, options: { id?: string; maxSteps?: number } = {}): ArchitectureFaultRun {
  const errors = validateArchitectureDocument(document);
  if (errors.length) throw new Error(errors.join("；"));
  const target = document.nodes.find(node => node.id === fault.targetNodeId);
  if (!target) throw new Error("请先选择图中存在的故障节点");
  if (fault.kind === "disk-full" && target.kind !== "store") throw new Error("磁盘写满只在存储节点上建模");
  if (!["disk-full", "session-switch", "network-timeout", "duplicate-event"].includes(fault.kind)) throw new Error("未知故障类型");
  const maxSteps = Number.isFinite(options.maxSteps) ? Math.min(10000, Math.max(1, Math.floor(options.maxSteps!))) : 4000;
  const outcomes = new Map(document.nodes.map(node => [node.id, { nodeId: node.id, state: "unaffected" as ArchitectureFaultState,
    detail: "未在已画出的故障路径中触及；不代表真实系统不受影响。", evidenceIds: [...node.evidenceIds] }]));
  const reverse = fault.kind === "disk-full" || fault.kind === "network-timeout";
  const firstState: ArchitectureFaultState = reverse ? "failed" : guardState(target, fault.kind);
  const pending: { node: ArchitectureNode; state: ArchitectureFaultState; edge?: ArchitectureEdge }[] = [{ node: target, state: firstState }];
  const visited = new Set<string>();
  const propagation: ArchitectureFaultRun["propagation"] = [];
  let steps = 0, truncated = false;
  while (pending.length) {
    const current = pending.shift()!;
    const visitKey = `${current.node.id}:${current.state}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const previous = outcomes.get(current.node.id)!;
    if (priority[current.state] >= priority[previous.state]) {
      outcomes.set(current.node.id, { nodeId: current.node.id, state: current.state,
        detail: describeState(current.state, fault.kind),
        evidenceIds: [...new Set([...current.node.evidenceIds, ...(current.edge?.evidenceIds ?? [])])] });
    }
    if (current.state === "contained") continue;
    const edges = document.edges.filter(edge => reverse ? edge.to === current.node.id : edge.from === current.node.id);
    for (const edge of edges) {
      if (steps >= maxSteps) { truncated = true; break; }
      steps++;
      const next = document.nodes.find(node => node.id === (reverse ? edge.from : edge.to))!;
      let state: ArchitectureFaultState;
      if (reverse) {
        const guard = fault.kind === "disk-full" ? next.guards.diskFull : "unknown";
        state = edge.failurePolicy === "isolate" || guard === "yes" ? "contained"
          : current.state === "unknown" || edge.failurePolicy === "unknown" || guard === "unknown" ? "unknown" : "at-risk";
        if (fault.kind === "network-timeout" && edge.failurePolicy === "propagate") state = current.state === "unknown" ? "unknown" : "at-risk";
      } else {
        const guarded = guardState(next, fault.kind);
        state = (fault.kind === "session-switch" && edge.sessionPolicy === "validate") || guarded === "contained" ? "contained"
          : current.state === "unknown" || guarded === "unknown" || (fault.kind === "session-switch" && edge.sessionPolicy === "unknown") ? "unknown" : "at-risk";
      }
      propagation.push({ edgeId: edge.id, from: current.node.id, to: next.id, state });
      pending.push({ node: next, state, edge });
    }
    if (truncated) break;
  }
  if (truncated) for (const outcome of outcomes.values()) {
    if (outcome.state === "unaffected") { outcome.state = "unknown"; outcome.detail = "传播预算已用尽，此节点结果未知。"; }
  }
  return {
    id: options.id ?? `fault-${document.faults.length + 1}`, simulated: true, binding: { ...document.binding },
    graphFingerprint: architectureGraphFingerprint(document), graphRevision: document.graphRevision,
    fault: { ...fault }, outcomes: [...outcomes.values()], propagation, steps, truncated,
    assumptions: ["这是针对用户绘制图与声明策略的离线模拟，没有操作真实系统。",
      "策略、拓扑、个人贡献和生产行为仍需授权证据核对；引用编号本身不证明实现正确。",
      "缺失策略保留未知；未画出的依赖、容量、调度与运行时行为不在本次模型中。"],
  };
}

function guardState(node: ArchitectureNode, kind: ArchitectureFaultKind): ArchitectureFaultState {
  const guard = kind === "session-switch" ? node.guards.sessionEpoch : node.guards.idempotency;
  return guard === "yes" ? "contained" : guard === "no" ? "at-risk" : "unknown";
}
function describeState(state: ArchitectureFaultState, fault: ArchitectureFaultKind): string {
  switch (state) {
    case "failed": return "注入点在本次假设中不可用，不是实际运行观察。";
    case "at-risk": return fault === "session-switch" ? "按图中未校验会话的假设，存在旧结果或脏写风险；不等于已发生脏写。" : "按图中传播与防护假设，此链路存在失败或重复执行风险。";
    case "contained": return "按声明的隔离/校验策略在此处收敛；防护是否真实实现尚待引用核对。";
    case "unknown": return "拓扑或策略信息不足，不能确定是否传播、阻断或写入。";
    case "unaffected": return "未在已画图范围内触及。";
  }
}
