import { z } from "zod";
import { StudioJobSchema, type StudioJobRequirementSchema } from "@better-me/agent-contracts/career-studio";

type Requirement = z.infer<typeof StudioJobRequirementSchema>;
export interface CareerJobObservationDraft {
  companyKey: string; roleKey: string; locationKey: string; departmentKey: string;
  detailedRequirements: boolean; requirements: Requirement[];
  comparableSalary: boolean; salaryMin: string; salaryMax: string; salaryCurrency: string; salaryDisclosedAt: string;
  refreshTimes: string;
}
export const emptyCareerJobObservation = (): CareerJobObservationDraft => ({ companyKey: "", roleKey: "", locationKey: "", departmentKey: "",
  detailedRequirements: false, requirements: [], comparableSalary: false, salaryMin: "", salaryMax: "", salaryCurrency: "", salaryDisclosedAt: "", refreshTimes: "" });
const patchSchema = StudioJobSchema.pick({ companyKey: true, roleKey: true, locationKey: true, departmentKey: true, requirements: true, comparableSalary: true, refreshTimes: true });
const timestamp = (value: string) => { if (!/\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim()) || !Number.isFinite(Date.parse(value))) throw new Error("观察时间须明确包含时区，例如 2026-11-09T08:00:00+08:00。"); return new Date(value).toISOString(); };
const amount = (value: string) => { if (!/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("年基本工资须填写非负数值，不从月薪、奖金或文本猜算。"); return Number(value); };
/** User-reviewed selection metadata, not an independent platform receipt. The
 * Host binds salary/refresh/requirements to the hash of this frozen source. */
export function parseCareerJobObservation(draft: CareerJobObservationDraft, skills: readonly string[]) {
  return patchSchema.parse({ companyKey: draft.companyKey.trim() || null, roleKey: draft.roleKey.trim() || null, locationKey: draft.locationKey.trim() || null, departmentKey: draft.departmentKey.trim() || null,
    ...(draft.detailedRequirements ? { requirements: skills.map(skillId => draft.requirements.find(r => r.skillId === skillId) ?? { skillId, weight: 1, hard: false, knowledge: "unknown", contribution: "any" }) } : {}),
    ...(draft.comparableSalary ? { comparableSalary: { min: amount(draft.salaryMin), max: amount(draft.salaryMax), currency: draft.salaryCurrency.trim().toUpperCase(), period: "annual", tax: "gross", kind: "base", disclosedAt: timestamp(draft.salaryDisclosedAt) } } : {}),
    refreshTimes: [...new Set(draft.refreshTimes.split(/\r?\n/).map(v => v.trim()).filter(Boolean).map(timestamp))],
  });
}
export function CareerJobObservationEditor({ value, skills, onChange }: { value: CareerJobObservationDraft; skills: readonly string[]; onChange(value: CareerJobObservationDraft): void }) {
  const update = (patch: Partial<CareerJobObservationDraft>) => onChange({ ...value, ...patch });
  const requirement = (skillId: string): Requirement => value.requirements.find(r => r.skillId === skillId) ?? { skillId, weight: 1, hard: false, knowledge: "unknown", contribution: "any" };
  const changeRequirement = (skillId: string, patch: Partial<Requirement>) => update({ requirements: [...value.requirements.filter(r => r.skillId !== skillId), { ...requirement(skillId), ...patch }] });
  return <details className="cs-job-observation"><summary>核对岗位分组、硬门槛与薪资口径（可选，缺失保留未知）</summary>
    <p>分组编号须逐项核对；公司、职能、办公地编号全部相同才可建议跨来源归并。不要把同名公司、不同部门或同城不同岗位强行归并。以下是本人选择的来源观察，不是平台独立认证。</p>
    <div className="cs-form-grid"><label>公司分组编号<input value={value.companyKey} onChange={e => update({ companyKey: e.target.value })} placeholder="例如 company-acme" /></label><label>同岗职能编号<input value={value.roleKey} onChange={e => update({ roleKey: e.target.value })} placeholder="例如 backend-agent" /></label><label>办公地点分组编号（不是地图坐标）<input value={value.locationKey} onChange={e => update({ locationKey: e.target.value })} placeholder="例如 office-shanghai-1" /></label><label>部门编号（可选）<input value={value.departmentKey} onChange={e => update({ departmentKey: e.target.value })} /></label></div>
    <label className="cs-check"><input type="checkbox" checked={value.detailedRequirements} onChange={e => update({ detailedRequirements: e.target.checked })} />逐项核对以上技能的门槛、权重与实现要求（未核对项保持未知）</label>
    {value.detailedRequirements && skills.map(skillId => { const row = requirement(skillId); return <fieldset key={skillId}><legend>{skillId}</legend><div className="cs-form-grid"><label>是否由JD明确要求<select value={row.knowledge} onChange={e => changeRequirement(skillId, { knowledge: e.target.value as Requirement["knowledge"] })}><option value="unknown">未核对 / 未知</option><option value="known">原文明确要求</option></select></label><label>重要性权重<input type="number" min="1" max="100" value={row.weight} onChange={e => changeRequirement(skillId, { weight: Number(e.target.value) })} /></label><label>贡献类型要求<select value={row.contribution} onChange={e => changeRequirement(skillId, { contribution: e.target.value as Requirement["contribution"] })}><option value="any">原文未区分</option><option value="implementation">要求实际实现</option><option value="design">要求设计经历</option></select></label><label className="cs-check"><input type="checkbox" checked={row.hard} onChange={e => changeRequirement(skillId, { hard: e.target.checked })} />JD明确列为硬门槛</label></div></fieldset>; })}
    <label className="cs-check"><input type="checkbox" checked={value.comparableSalary} onChange={e => update({ comparableSalary: e.target.checked })} />我已核对该来源明确披露同币种、税前、年度基本工资，不含奖金/股权（否则请勿勾选）</label>
    {value.comparableSalary && <div className="cs-form-grid"><label>年度基本工资下限<input inputMode="decimal" value={value.salaryMin} onChange={e => update({ salaryMin: e.target.value })} /></label><label>年度基本工资上限<input inputMode="decimal" value={value.salaryMax} onChange={e => update({ salaryMax: e.target.value })} /></label><label>币种（ISO三字码）<input value={value.salaryCurrency} onChange={e => update({ salaryCurrency: e.target.value })} placeholder="CNY" /></label><label>来源披露时间（包含时区）<input value={value.salaryDisclosedAt} onChange={e => update({ salaryDisclosedAt: e.target.value })} placeholder="2026-11-09T08:00:00+08:00" /></label></div>}
    <label>有来源支持的实际刷新观察时间（每行一条，包含时区；未知留空）<textarea value={value.refreshTimes} onChange={e => update({ refreshTimes: e.target.value })} placeholder="请勿把采集时间或刷新页面动作当成岗位刷新" maxLength={40_000} /></label>
  </details>;
}
