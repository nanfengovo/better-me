import type { UnderstandingCapability } from "@better-me/agent-contracts";

export function nativeToolStatus(item: UnderstandingCapability): string {
  const labels: Record<NonNullable<UnderstandingCapability["code"]>, string> = {
    ready: "已验证 · 本账号可用", needs_verification: "已授权 · 待运行验证", needs_authorization: "已安装 · 待本账号授权",
    authorization_pending: "等待本人完成登录", not_installed: "未安装", adapter_missing: "尚未接入",
    sandbox_unavailable: "系统隔离不可用", protocol_incompatible: "CLI 版本不兼容",
    managed_policy_unavailable: "管理策略同步受阻", runtime_terminated: "隔离启动被系统终止",
  };
  return item.code ? labels[item.code] : !item.available ? "未安装" : item.supported ? "可用于受控取证" : "未通过兼容检查";
}
