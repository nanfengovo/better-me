import { Building2, PenLine, ShieldCheck, Sparkles } from "lucide-react";
import { Button, EmptyState } from "../../design-system";

type Translate = (chinese: string, english: string) => string;

interface AgentEmptyPromptCardsProps {
  isDark: boolean;
  t: Translate;
  company?: string;
  onSendMessage: (message: string) => Promise<void> | void;
  onTriggerGuide: (guide: { section: "headline" | "experience"; label: string }) => void;
}

export function AgentEmptyPromptCards({
  t,
  company,
  onSendMessage,
  onTriggerGuide,
}: AgentEmptyPromptCardsProps) {
  return (
    <EmptyState
      compact
      align="start"
      icon={<Sparkles size={15} />}
      title={t("BetterMe 专属求职顾问已就绪", "BetterMe Career Copilot Ready")}
      description={t("可以一起调研雇主、打磨一条项目经历，或准备面试追问。", "Research an employer, refine a project contribution, or prepare for interview questions.")}
      actions={
        <>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => void onSendMessage(`帮我深入调研 ${company || "这家公司"} 的企业背景、实控人与经营稳定性`)}
          >
            <Building2 size={12} aria-hidden="true" />
            {t("查公司", "Company")}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              onTriggerGuide({
                section: "headline",
                label: t("Agent 正在针对岗位优化个人优势", "Refining headline for job"),
              });
              void onSendMessage(t("对照目标岗位，找一条最有依据的经历，写清交付对象和本人动作；缺少关键细节就先问我。", "Help me refine one supported contribution for the target role. Ask me for missing details before suggesting a rewrite."));
            }}
          >
            <PenLine size={12} aria-hidden="true" />
            {t("打磨一条经历", "Refine a bullet")}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              onTriggerGuide({
                section: "experience",
                label: t("Agent 正在结合缺口准备面试防守", "Analyzing gaps for defense"),
              });
              void onSendMessage("针对本岗位任职要求中我可能存在的经验缺口，提供高情商的面试应答防守策略");
            }}
          >
            <ShieldCheck size={12} aria-hidden="true" />
            {t("面试防守", "Defense")}
          </Button>
        </>
      }
    />
  );
}
