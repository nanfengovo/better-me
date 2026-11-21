/** @jsxRuntime automatic */
import { useMemo, useState } from "react";
import { Check, Copy, Plug } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { Button, SegmentedControl, StatusPill } from "../../design-system";

type McpClientKind = "claude" | "cursor" | "antigravity";

/**
 * Settings → MCP Connector panel (inspired by Dossier's MCP Connector guide).
 * Generates ready-to-paste stdio MCP config for Claude Desktop, Cursor, and Antigravity
 * with explicit privacy & read-only guarantees.
 */
export function DesktopMcpSettings() {
  const { t } = useUiPreferences();
  const [client, setClient] = useState<McpClientKind>("claude");
  const [repoPath, setRepoPath] = useState("/path/to/better-me-agent-os");
  const [resumePath, setResumePath] = useState("/path/to/betterme-data/resume-backup.json");
  const [opportunitiesPath, setOpportunitiesPath] = useState("/path/to/betterme-data/opportunities.json");
  const [draftsDir, setDraftsDir] = useState("/path/to/betterme-data/drafts");
  const [copied, setCopied] = useState(false);

  const configJson = useMemo(() => {
    const cleanRepo = repoPath.trim() || "/path/to/better-me-agent-os";
    const cleanResume = resumePath.trim() || "/path/to/betterme-data/resume-backup.json";
    const cleanOpps = opportunitiesPath.trim();
    const cleanDrafts = draftsDir.trim();

    if (client === "claude") {
      const args = ["--dir", cleanRepo, "mcp:start", "--", "--resume", cleanResume];
      if (cleanOpps) args.push("--opportunities", cleanOpps);
      if (cleanDrafts) args.push("--drafts-dir", cleanDrafts);
      return JSON.stringify(
        { mcpServers: { betterme: { command: "pnpm", args } } },
        null,
        2,
      );
    }

    const env: Record<string, string> = { BETTERME_RESUME_FILE: cleanResume };
    if (cleanOpps) env.BETTERME_OPPORTUNITIES_FILE = cleanOpps;
    if (cleanDrafts) env.BETTERME_DRAFTS_DIR = cleanDrafts;
    return JSON.stringify(
      {
        mcpServers: {
          betterme: {
            command: "node",
            args: ["--import", "tsx", `${cleanRepo.replace(/\/+$/, "")}/apps/agent-host/src/career-mcp/local-cli.ts`],
            env,
          },
        },
      },
      null,
      2,
    );
  }, [client, repoPath, resumePath, opportunitiesPath, draftsDir]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(configJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard unavailable in restricted contexts. */
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p className="os-setting-intro">
        {t(
          "通过本地 stdio MCP 协议，将你的 BetterMe 事实库（FactBase）与机会库安全开放给 Claude Desktop、Cursor 或 Antigravity 调用。",
          "Expose your verified BetterMe FactBase and Opportunity Library locally over stdio MCP to Claude Desktop, Cursor, or Antigravity.",
        )}
      </p>

      <div className="os-settings-card" style={{ padding: "11px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <StatusPill tone="accent">{t("默认脱敏邮箱与电话", "Contact PII redacted by default")}</StatusPill>
          <StatusPill tone="neutral">{t("未核实指标自动过滤", "Unverified metrics withheld")}</StatusPill>
          <StatusPill tone="neutral">{t("绝不覆写主档 / 绝不自动投递", "Read-only master · No auto-apply")}</StatusPill>
        </div>
        <small style={{ color: "var(--os-muted)", fontSize: 11.5, lineHeight: 1.5 }}>
          {t(
            "内置 6 项工具：get_fact_base_summary、list_verified_claims、list_opportunities、check_rewrite_grounding（_novel_numbers 防编造守卫）、score_resume_against_jd、save_tailored_draft（仅写隔离草稿目录）。",
            "Exposes 6 tools: get_fact_base_summary, list_verified_claims, list_opportunities, check_rewrite_grounding (_novel_numbers guard), score_resume_against_jd, and isolated save_tailored_draft.",
          )}
        </small>
      </div>

      <div className="os-settings-card" style={{ padding: "11px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <strong style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plug size={14} aria-hidden="true" />
            {t("选择客户端并生成配置", "Choose client & generate config")}
          </strong>
          <SegmentedControl
            value={client}
            ariaLabel={t("MCP 客户端类型", "MCP client")}
            options={[
              { value: "claude", label: "Claude Desktop" },
              { value: "cursor", label: "Cursor" },
              { value: "antigravity", label: "Antigravity" },
            ]}
            onChange={setClient}
          />
        </div>

        <label style={{ display: "grid", gap: 4, fontSize: 11.5 }}>
          <span>{t("BetterMe 仓库路径", "BetterMe repository path")}</span>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} style={{ padding: "6px 9px", borderRadius: 7, border: "1px solid var(--ui-border)", background: "var(--ui-input, var(--ui-surface-soft))", color: "var(--ui-text)", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 11.5 }}>
          <span>{t("简历 JSON 备份路径（简历工作室 ··· → 下载 JSON 备份）", "Resume JSON backup path (Resume Studio ··· → Download JSON backup)")}</span>
          <input value={resumePath} onChange={(e) => setResumePath(e.target.value)} style={{ padding: "6px 9px", borderRadius: 7, border: "1px solid var(--ui-border)", background: "var(--ui-input, var(--ui-surface-soft))", color: "var(--ui-text)", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 11.5 }}>
            <span>{t("机会库备份路径（可选）", "Opportunities JSON (optional)")}</span>
            <input value={opportunitiesPath} onChange={(e) => setOpportunitiesPath(e.target.value)} style={{ padding: "6px 9px", borderRadius: 7, border: "1px solid var(--ui-border)", background: "var(--ui-input, var(--ui-surface-soft))", color: "var(--ui-text)", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 11.5 }}>
            <span>{t("隔离草稿输出目录（可选）", "Isolated drafts dir (optional)")}</span>
            <input value={draftsDir} onChange={(e) => setDraftsDir(e.target.value)} style={{ padding: "6px 9px", borderRadius: 7, border: "1px solid var(--ui-border)", background: "var(--ui-input, var(--ui-surface-soft))", color: "var(--ui-text)", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }} />
          </label>
        </div>

        <div style={{ position: "relative" }}>
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--ui-border)",
              background: "var(--ui-surface-soft)",
              color: "var(--ui-text)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
              lineHeight: 1.42,
              overflowX: "auto",
            }}
          >
            {configJson}
          </pre>
          <div style={{ position: "absolute", top: 8, right: 8 }}>
            <Button variant="secondary" size="xs" onClick={() => void handleCopy()}>
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              <span>{copied ? t("已复制配置", "Copied") : t("复制 JSON", "Copy JSON")}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
