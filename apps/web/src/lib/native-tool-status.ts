import type { UnderstandingCapability } from "@better-me/agent-contracts";

type Translate = (chinese: string, english: string) => string;
const chineseOnly: Translate = chinese => chinese;

export function nativeToolStatus(item: UnderstandingCapability, t: Translate = chineseOnly): string {
  const labels: Record<NonNullable<UnderstandingCapability["code"]>, string> = {
    ready: t("已验证 · 本账号可用", "Verified · available to this account"),
    needs_verification: t("已授权 · 待运行验证", "Authorized · awaiting a live check"),
    needs_authorization: t("已安装 · 待本账号授权", "Installed · needs authorization for this account"),
    authorization_pending: t("等待本人完成登录", "Waiting for you to finish signing in"),
    not_installed: t("未安装", "Not installed"),
    adapter_missing: t("尚未接入", "Not integrated yet"),
    sandbox_unavailable: t("系统隔离不可用", "System isolation unavailable"),
    protocol_incompatible: t("CLI 版本不兼容", "CLI version incompatible"),
    managed_policy_unavailable: t("管理策略同步受阻", "Managed policy sync blocked"),
    runtime_terminated: t("隔离启动被系统终止", "Isolated launch terminated by the system"),
  };
  return item.code ? labels[item.code] : !item.available ? t("未安装", "Not installed") : item.supported ? t("可用于受控取证", "Available for controlled evidence reading") : t("未通过兼容检查", "Failed the compatibility check");
}
