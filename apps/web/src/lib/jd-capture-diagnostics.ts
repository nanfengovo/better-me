/** Fixed diagnostic values only; never carry a page URL, DOM fragment or protocol error text. */
export const SNAPSHOT_FAILURE_STAGES = ["document_state", "capture", "projection", "post_projection"] as const;
export const SNAPSHOT_FAILURE_REASONS = [
  "main_pending", "main_failed", "main_not_committed", "response_not_200", "frame_loader_mismatch", "frame_url_mismatch",
  "source_rejected", "navigation_changed", "protocol_unavailable", "network_unavailable", "projection_internal_error",
  "snapshot_shape", "snapshot_string", "main_document_count", "document_url", "node_arrays", "node_parent", "attributes",
  "layout_arrays", "layout_entry", "text_box_arrays", "text_box_entry", "text_box_range", "snapshot_limit_exceeded",
  "projection_depth_limit", "snapshot_visibility_unsupported", "document_body_missing",
] as const;
export const SNAPSHOT_VISIBILITY_DETAILS = [
  "computed_style_incomplete", "shadow_or_pseudo", "overflow_clip_or_scroll", "text_ellipsis", "line_clamp",
  "legacy_clip", "clip_path", "transform", "filter", "mask", "text_range_gap", "layout_style_conflict", "text_fragment_mapping",
  "boss_description_collapsed",
] as const;
export type SnapshotVisibilityDetail = typeof SNAPSHOT_VISIBILITY_DETAILS[number];
export const SNAPSHOT_LAYOUT_DETAILS = ["node_index", "style_count", "text_opacity", "computed_style", "bounds"] as const;
export type SnapshotFailureDetail = SnapshotVisibilityDetail | typeof SNAPSHOT_LAYOUT_DETAILS[number];
export type SnapshotFailure = {
  stage: typeof SNAPSHOT_FAILURE_STAGES[number];
  reason: typeof SNAPSHOT_FAILURE_REASONS[number];
  detail?: SnapshotFailureDetail;
};

export function isSnapshotFailure(value: unknown): value is SnapshotFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { stage, reason, detail } = value as Record<string, unknown>;
  return typeof stage === "string" && (SNAPSHOT_FAILURE_STAGES as readonly string[]).includes(stage)
    && typeof reason === "string" && (SNAPSHOT_FAILURE_REASONS as readonly string[]).includes(reason)
    && (detail === undefined || (typeof detail === "string" && (
      (reason === "snapshot_visibility_unsupported" && (SNAPSHOT_VISIBILITY_DETAILS as readonly string[]).includes(detail)
        && (detail !== "boss_description_collapsed" || stage === "projection"))
      || (reason === "layout_entry" && (SNAPSHOT_LAYOUT_DETAILS as readonly string[]).includes(detail))
    )));
}

export function isBossDescriptionCollapsed(failure: SnapshotFailure | undefined): boolean {
  return failure?.stage === "projection" && failure.reason === "snapshot_visibility_unsupported" && failure.detail === "boss_description_collapsed";
}

export function snapshotFailureMessage(failure: SnapshotFailure): string {
  if (isBossDescriptionCollapsed(failure)) return "职位描述仍被折叠为四行，尚未取得完整正文。请在专用 Edge 的职位描述区域点击“查看全部”，全部显示后再读取。";
  if (failure.reason === "snapshot_visibility_unsupported") return "页面含有尚未支持的裁剪或文字布局，当前未采用可能被截断的正文。";
  if (failure.reason === "main_pending" || failure.reason === "main_not_committed") return "主页面仍在切换，稍后可再次检查当前窗口。";
  if (failure.reason === "main_failed") return "当前主页面请求未完成，请核对专用浏览器中的加载结果。";
  if (failure.reason === "response_not_200") return "主页面没有返回可用于读取的成功响应，请结合加载记录核对。";
  if (["frame_loader_mismatch", "frame_url_mismatch", "navigation_changed"].includes(failure.reason)) return "检查期间页面发生切换，本次未采用先前页面的内容。";
  if (failure.reason === "source_rejected") return "当前页面的来源不符合本次岗位要求，未采用该页面。";
  if (failure.reason === "network_unavailable") return "本次专用浏览器网络检查未通过，当前未采用页面内容。";
  if (failure.reason === "document_body_missing") return "当前页面快照还没有可确认的正文，稍后可再次检查。";
  if (failure.reason === "snapshot_limit_exceeded" || failure.reason === "projection_depth_limit") return "页面结构超过本次读取上限，未采用不完整的内容。";
  if (failure.stage === "capture") return "浏览器未完成本次页面快照读取，请保留窗口后再次检查。";
  if (failure.stage === "post_projection") return "读取后未能确认页面状态仍然一致，本次未采用内容。";
  return "页面内容校验未通过，本次未采用未确认的正文。";
}
