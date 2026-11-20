/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { careerJobSnapshotVersion, careerTrainingRequirements, type CareerTrainingJob } from "@better-me/agent-contracts";
import { pickLocale, type DecomposedJdItem } from "@better-me/core";
import type { RequirementEvidenceLink } from "@better-me/core/document";
import {
  canSupportRequirement, currentLinkState, currentRequirementLinks, evidenceSources,
  requirementEvidenceAdvice, requirementSourceKey, summarizeRequirements, type EvidenceWorkspace, type RequirementReviewCommand,
} from "../lib/requirement-evidence";
import { useUiPreferences } from "../lib/ui-preferences";

const roles = {
  implementation: ["本人实施", "Implementation"], design: ["本人设计与取舍", "Design decisions"],
  collaboration: ["协作", "Collaboration"], maintenance: ["维护", "Maintenance"], other: ["其他贡献", "Other contribution"],
} as const;
const labels = {
  "personal-action": ["本人行动记录", "Personal action"], "self-report": ["本人自述", "Self-report"], negative: ["否定陈述", "Negative statement"],
  team: ["团队背景", "Team background"], planned: ["计划", "Planned work"], practice: ["训练记录", "Practice record"], unconfirmed: ["待核实", "Unconfirmed"],
  supports: ["本人核对支持", "Reviewed as supporting"], partial: ["部分支持", "Partial support"],
  observed: ["已记录观察", "Observation recorded"], withdrawn: ["已撤回", "Withdrawn"], outdated: ["材料已变化或移除", "Source changed or removed"],
} as const;
const results = {
  met: ["达到可核对条件", "Criterion met"], missed: ["仍有未达到的条件", "Criterion missed"], recorded: ["已保存独立原答", "Independent response recorded"],
} as const;
const suggestions = {
  review: ["有独立作答原文。先对照验收条件核对内容，再判断能支持哪一项要求。", "Review the independent answer against the criterion before using it as supporting evidence."],
  practice: ["复测仍有条件未达到。先补练这一项，再换个情境验证。", "A criterion was missed in the retest. Practice it again before another scenario."],
  prepare: ["可以用工作成果准备面试案例，再用复测核对你能否解释关键决策。", "Use the work outcome to prepare an interview example and the retest to review your reasoning."],
  work: ["已有独立复测记录。下一步补一份实际工作成果，说明自己做了什么。", "There is an independent retest. Find a work outcome that shows your own contribution."],
  retest: ["已有工作依据。可以安排一次独立复测，核对换个情境能否完成。", "There is work evidence. An independent retest can check the same skill in a different scenario."],
  clarify: ["先找一条能说明本人做了什么的材料，或针对这项要求练一次。", "Find a source showing your own contribution, or practice this requirement."],
} as const;
type Props = { job: CareerTrainingJob; workspace: EvidenceWorkspace; onTrain?: (quote: string, itemId: string) => void };

export function RequirementEvidencePanel(props: Props) {
  const { t } = useUiPreferences();
  const version = useMemo(() => careerJobSnapshotVersion(props.job), [props.job]);
  const [open, setOpen] = useState(false);
  return <details className="requirement-evidence rounded-xl border border-[var(--ui-border)] p-3 text-sm"
    open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">{t("这条要求，我能用什么证明？", "What evidence do I have for this requirement?")}</summary>
    {open && <RequirementReview key={version} {...props} version={version}/>}
  </details>;
}

function RequirementReview({ job, workspace, version, onTrain }: Props & { version: string }) {
  const { t } = useUiPreferences();
  const items = useMemo(() => careerTrainingRequirements(job), [job]);
  const [selection, setSelection] = useState("");
  const item = items.find(i => i.id === selection) ?? items[0];
  const sources = useMemo(() => evidenceSources(workspace.facts), [workspace.facts]);
  const links = workspace.links.filter(link => link.jobVersion === version);
  const previousVersions = job.id ? workspace.links.filter(link => link.jobId === job.id && link.jobVersion !== version) : [];
  const coverage = summarizeRequirements(items, links, sources);
  const labelOf = ([zh, en]: readonly [string, string]) => t(zh, en);
  if (!item) return <p>{t("尚未识别到可核对的岗位原句。", "No reviewable requirement found.")}</p>;
  return <div className="mt-3 grid gap-3">
    <p>{t(`共 ${items.length} 条 · 本人核对支持 ${coverage.supported} · 部分支持 ${coverage.partial} · 待补证 ${items.length - coverage.supported - coverage.partial}`,
      `${items.length} items · ${coverage.supported} supported · ${coverage.partial} partial · ${items.length - coverage.supported - coverage.partial} need evidence`)}</p>
    <label>{t("选择岗位原句", "Choose a requirement")}<select className="block w-full" value={item.id} onChange={event => setSelection(event.target.value)}>
      {items.map(i => <option key={i.id} value={i.id}>{i.sourceSpan?.line ? t(`第 ${i.sourceSpan.line} 行 · `, `Line ${i.sourceSpan.line} · `) : ""}{i.originalQuote}</option>)}
    </select></label>
    <RequirementSources key={item.id} item={item} job={job} workspace={workspace} onTrain={onTrain}
      links={links.filter(link => link.itemId === item.id && link.quote === item.originalQuote)} sources={sources}/>
    {previousVersions.length > 0 && <details><summary className="cursor-pointer">{t("查看此前岗位版本的证据", "Review evidence from earlier job versions")}</summary>
      {previousVersions.slice().reverse().map((link, i) => {
        const label = link.assessment === "withdrawn" ? labels.withdrawn
          : link.sourceKind === "independent-retest" ? results[link.result] : labels[link.assessment];
        return <article className="mt-2" key={i}>
          <blockquote>{link.quote}</blockquote>
          <p>{labelOf(label)}
            {" · "}{link.sourceKind === "independent-retest" ? link.sourceLabel : link.sourceExcerpt ?? link.sourceLabel}</p>
          <time dateTime={link.reviewedAt}>{new Date(link.reviewedAt).toLocaleDateString()}</time>
        </article>;
      })}
    </details>}
  </div>;
}

function RequirementSources({ item, job, workspace, onTrain, links, sources }: Props & {
  item: DecomposedJdItem; links: RequirementEvidenceLink[]; sources: ReturnType<typeof evidenceSources>;
}) {
  const { t, locale } = useUiPreferences();
  const labelOf = ([zh, en]: readonly [string, string]) => t(zh, en);
  const [sourceKey, setSourceKey] = useState("");
  const [contribution, setContribution] = useState<RequirementEvidenceLink["contribution"]>("implementation");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [retests, setRetests] = useState<Awaited<ReturnType<EvidenceWorkspace["loadRetests"]>>>();
  const [readingRetests, setReadingRetests] = useState(false);
  const read = useRef<AbortController | null>(null);
  useEffect(() => () => read.current?.abort(), []);
  const active = currentRequirementLinks(links);
  const historical = links.filter(link => !active.includes(link));
  const source = sources.find(s => requirementSourceKey({ experienceId: s.experience.id, claimId: s.claim.id }) === sourceKey);
  async function save(command: RequirementReviewCommand) {
    setSaving(true); setError("");
    try { await workspace.save(command); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("保存失败，请重试。", "Could not save. Try again.")); }
    finally { setSaving(false); }
  }
  async function loadRetests() {
    if (read.current) return;
    const controller = new AbortController();
    read.current = controller;
    setReadingRetests(true); setError("");
    try { setRetests(await workspace.loadRetests(job, item, controller.signal)); }
    catch { if (!controller.signal.aborted) setError(t("暂时无法核对独立复测记录，请重试。", "Retest records could not be checked. Try again.")); }
    finally {
      read.current = null;
      if (!controller.signal.aborted) setReadingRetests(false);
    }
  }
  function record(link: RequirementEvidenceLink, history = false) {
    const state = history ? link.assessment : currentLinkState(link, sources);
    const material = link.sourceKind !== "independent-retest" && sources.find(s => s.experience.id === link.experienceId
      && s.claim.id === link.claimId && s.sourceVersion === link.sourceVersion);
    return <article className="rounded-lg border border-[var(--ui-border)] p-2">
      <strong>{link.sourceKind === "independent-retest"
        ? t("独立复测", "Independent retest") + " · " + labelOf(state === "withdrawn" ? labels.withdrawn : results[link.result])
        : t("工作材料", "Work evidence") + " · " + labelOf(labels[state]) + " · " + labelOf(roles[link.contribution])}</strong>
      {link.sourceKind === "independent-retest" ? <>
        <p>{link.sourceLabel}</p><blockquote>{link.changedCondition}</blockquote><p>{link.criterion}</p>
      </> : material ? <>
        <p>{pickLocale(material.experience.org, locale)} · {pickLocale(material.experience.projectName ?? material.experience.title, locale)}</p>
        <blockquote>{pickLocale(material.claim.text, locale)}</blockquote>
      </> : <blockquote>{link.sourceExcerpt ?? link.sourceLabel}</blockquote>}
      {history && <time dateTime={link.reviewedAt}>{new Date(link.reviewedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en")}</time>}
      {!history && link.assessment !== "withdrawn" && <button type="button" disabled={saving} className="studio-button ml-2"
        onClick={() => void save({ ...link, job, assessment: "withdrawn" })}>{t("撤回关联", "Withdraw link")}</button>}
    </article>;
  }
  return <>
    <blockquote>{item.originalQuote}</blockquote>
    <p role="status">{labelOf(suggestions[requirementEvidenceAdvice(links, sources)])}</p>
    {active.map(link => <div key={requirementSourceKey(link)}>{record(link)}</div>)}
    {sources.length > 0 && <label>{t("核对工作材料", "Review a work source")}<select className="block w-full" value={sourceKey} onChange={event => {
      setSourceKey(event.target.value); setContribution("implementation"); setError("");
    }}><option value="">{t("选择一条经历记录", "Select a source claim")}</option>
      {sources.map(s => {
        const key = requirementSourceKey({ experienceId: s.experience.id, claimId: s.claim.id });
        return <option key={key} value={key}>{pickLocale(s.experience.org, locale)} · {pickLocale(s.claim.text, locale)}</option>;
      })}
    </select></label>}
    {source && <><blockquote>{pickLocale(source.claim.text, locale)}</blockquote><small>{labelOf(labels[source.kind])}</small>
      {(source.kind === "personal-action" || source.kind === "self-report") && <><label>{t("这项工作中我负责", "My contribution")}<select className="block w-full" value={contribution} onChange={e => setContribution(e.target.value as typeof contribution)}>
        {Object.entries(roles).map(([role, label]) => <option value={role} key={role}>{labelOf(label)}</option>)}</select></label>
        <div className="flex flex-wrap gap-2">{(["partial", "supports"] as const).map(assessment => <button type="button" className="studio-button" key={assessment}
          disabled={saving || (assessment === "supports" && !canSupportRequirement(source, item.originalQuote, contribution))}
          onClick={() => void save({ job, itemId: item.id, quote: item.originalQuote, sourceVersion: source.sourceVersion,
            claimId: source.claim.id, experienceId: source.experience.id, assessment, contribution })}>{assessment === "partial" ? t("记录部分支持", "Record partial support") : t("确认支持这项要求", "Confirm support")}</button>)}</div>
      </>}
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="studio-button" disabled={readingRetests} onClick={() => void loadRetests()}>
        {readingRetests ? t("正在核对复测…", "Checking retests…") : t("查找独立复测", "Find independent retests")}
      </button>
      {onTrain && <button type="button" className="studio-button" onClick={() => onTrain(item.originalQuote, item.id)}>
        {t("为这条要求安排练习", "Practice this requirement")}
      </button>}
    </div>
    {retests?.length === 0 && <p>{t("这条要求暂无可关联的独立换情境复测。", "There is no eligible independent retest for this requirement yet.")}</p>}
    {retests?.map(retest => {
      const linked = active.some(link => link.sourceKind === "independent-retest" && link.kitId === retest.kitId
        && link.sourceVersion === retest.version && link.assessment !== "withdrawn");
      return <article key={retest.kitId} className="rounded-lg border border-[var(--ui-border)] p-2">
        <strong>{retest.title} · {labelOf(results[retest.result])}</strong><p>{retest.change.after}</p>
        <button type="button" className="studio-button" disabled={saving || linked} onClick={() => void save({
          job, itemId: item.id, quote: item.originalQuote, sourceKind: "independent-retest", kitId: retest.kitId, sourceVersion: retest.version,
          assessment: "partial", contribution: "other",
        })}>{linked ? t("已关联", "Linked") : t("关联这次独立复测", "Link this independent retest")}</button>
      </article>;
    })}
    {historical.length > 0 && <details><summary className="cursor-pointer">{t("查看这条要求的历史证据", "Review historical evidence for this requirement")}</summary>
      {historical.slice().reverse().map((link, i) => <div key={i}>{record(link, true)}</div>)}
    </details>}
    {error && <p role="alert">{error}</p>}
  </>;
}
