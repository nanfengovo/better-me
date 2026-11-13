import { useState } from "react";
import { z } from "zod";
import { TrustHash, TrustId, type TrustRequest } from "./CareerTrustPanel.contracts";
import { TrustActivity, TrustHashDetail, toggleTrustValue, useTrustAction } from "./CareerTrustPanel.shared";

const SourceVersion = z.object({ id: TrustId, revision: z.number().int().nonnegative(), hash: TrustHash });
const PublicDiagram = z.object({ nodes: z.array(z.object({ id: TrustId, label: z.string() })).max(80),
  edges: z.array(z.object({ from: TrustId, to: TrustId, label: z.string() })).max(160) });
const Catalog = z.object({ source: SourceVersion.extend({ title: z.string(), nodes: z.array(z.object({ id: TrustId, label: z.string() })).max(80),
  edges: z.array(z.object({ id: TrustId, from: TrustId, to: TrustId, label: z.string() })).max(160) }).nullable(),
  publications: z.array(z.object({ id: TrustId, hash: TrustHash, statement: z.string() })), limitations: z.array(z.string()) });
const Preview = z.object({ previewId: TrustId, previewHash: TrustHash, expiresAt: z.string().datetime(), source: SourceVersion,
  publicContent: z.object({ design: z.string(), diagram: PublicDiagram, limitations: z.string() }),
  redactions: z.array(z.object({ category: z.string(), count: z.number().int().nonnegative() })) });
const Confirmed = z.object({ publication: z.object({ id: TrustId, hash: TrustHash, revision: z.number().int().nonnegative() }).passthrough(),
  adopted: z.literal(false), published: z.literal(false) });
type Field = "title" | "node.label" | "edge.label";

/** This stages an explicitly reviewed design projection. Publishing a capsule
 * and issuing a capability remain separate existing workflows. */
export function CareerTrustDiagramPublication({ contextId, request, onConfirmed }: {
  contextId: string; request: TrustRequest; onConfirmed(): Promise<void>;
}) {
  const action = useTrustAction(request);
  const [catalog, setCatalog] = useState<z.infer<typeof Catalog>>(), [publicationId, setPublicationId] = useState("");
  const [nodeIds, setNodeIds] = useState<string[]>([]), [edgeIds, setEdgeIds] = useState<string[]>([]);
  const [fields, setFields] = useState<Field[]>(["node.label"]), [privateTerms, setPrivateTerms] = useState("");
  const [preview, setPreview] = useState<z.infer<typeof Preview>>(), [consent, setConsent] = useState(false), [notice, setNotice] = useState(""), [attempted, setAttempted] = useState(false);
  const clear = () => { setPreview(undefined); setConsent(false); setNotice(""); setAttempted(false); };
  async function load() {
    clear();
    const result = await action.run("读取本次已保存白板与审阅记录", "/architecture/publication/catalog", { contextId }, Catalog);
    if (result) { setCatalog(result); setPublicationId(""); setNodeIds([]); setEdgeIds([]); setFields(["node.label"]); }
  }
  async function prepare() {
    const source = catalog?.source, publication = catalog?.publications.find(item => item.id === publicationId);
    if (!source || !publication || !nodeIds.length) return;
    clear();
    const result = await action.run("编译所选图示的公开字段预览", "/architecture/publication/preview", { contextId, publicationId,
      expectedPublicationHash: publication.hash, source: { id: source.id, revision: source.revision, hash: source.hash }, nodeIds, edgeIds, fields,
      privateTerms: privateTerms.split(/\n/).map(value => value.trim()).filter(Boolean), consent: true }, Preview);
    if (result && result.source.id === source.id && result.source.revision === source.revision && result.source.hash === source.hash) setPreview(result);
  }
  async function confirm() {
    if (!preview || !consent || attempted) return;
    setAttempted(true);
    const result = await action.run("冻结已审阅的设计图示", "/architecture/publication/confirm", { contextId, previewId: preview.previewId,
      expectedPreviewHash: preview.previewHash, confirmed: true, consent: true, idempotencyKey: crypto.randomUUID() }, Confirmed);
    if (result) {
      setPreview(undefined); setConsent(false); setPublicationId("");
      setNotice("已新增冻结的图示审阅记录，原记录未覆盖。请在上方刷新后明确选择新记录及“设计取舍”“已批准架构图”，再走独立胶囊预览与发布；尚未公开或签发访问。");
      await onConfirmed();
    }
  }
  const source = catalog?.source;
  return <section className="ctr-review" aria-label="架构图独立公开审阅"><h4>可选 · 审阅已保存白板的公开图示</h4>
    <p>只读取本次范围内明确保存的版本。节点与连线是设计声明，不证明已经实现、上线、个人作者身份或防护效果；不公开源码、备注、路径、故障记录或问答。</p>
    <button type="button" disabled={!!action.busy} onClick={() => void load()}>读取本次可公开图示与关联陈述</button>
    <TrustActivity action={action} />
    {catalog && <>{catalog.limitations.map((text, index) => <p key={index} className="ctr-empty">{text}</p>)}
      {!source ? <p className="ctr-empty">本次范围尚无已保存白板；请先到面试白板明确保存，不会自动创建示例图。</p> : <>
        <p>已保存白板：{source.title} · 版本 {source.revision}</p><TrustHashDetail values={{ "白板精确版本": source.hash }} />
        {!catalog.publications.length ? <p className="ctr-empty">本次范围尚无经独立审阅的可公开陈述。请先完成抗压测试及本人贡献审阅。</p> : <>
          <label>关联本次已审阅陈述<select value={publicationId} disabled={!!action.busy} onChange={event => { setPublicationId(event.target.value); clear(); }}><option value="">不自动选择</option>{catalog.publications.map(item => <option key={item.id} value={item.id}>{item.statement.slice(0, 120)}</option>)}</select></label>
          <fieldset disabled={!!action.busy}><legend>明确选择公开节点</legend>{source.nodes.map(node => <label className="ctr-check" key={node.id}><input type="checkbox" checked={nodeIds.includes(node.id)} onChange={() => {
            const selected = toggleTrustValue(nodeIds, node.id); setNodeIds(selected); setEdgeIds(previous => previous.filter(id => { const edge = source.edges.find(item => item.id === id); return !!edge && selected.includes(edge.from) && selected.includes(edge.to); })); clear();
          }} />节点：{node.label}</label>)}</fieldset>
          <fieldset disabled={!!action.busy}><legend>明确选择公开连线</legend>{source.edges.length ? source.edges.map(edge => <label className="ctr-check" key={edge.id}><input type="checkbox" checked={edgeIds.includes(edge.id)} disabled={!nodeIds.includes(edge.from) || !nodeIds.includes(edge.to)} onChange={() => { setEdgeIds(toggleTrustValue(edgeIds, edge.id)); clear(); }} />连线：{source.nodes.find(node => node.id === edge.from)?.label} → {source.nodes.find(node => node.id === edge.to)?.label} · {edge.label || "无标签"}</label>) : <p>该版本没有连线；不推断依赖。</p>}</fieldset>
          <fieldset disabled={!!action.busy}><legend>允许公开的字段</legend><label className="ctr-check"><input type="checkbox" checked disabled />节点名称（必选）</label>{([['title', '白板标题'], ['edge.label', '连线标签']] as const).map(([field, label]) => <label className="ctr-check" key={field}><input type="checkbox" checked={fields.includes(field)} onChange={() => { setFields(previous => toggleTrustValue(previous, field) as Field[]); clear(); }} />{label}</label>)}</fieldset>
          <label>图示需脱敏的内部名称（每行一项）<textarea rows={2} maxLength={6000} value={privateTerms} disabled={!!action.busy} onChange={event => { setPrivateTerms(event.target.value); clear(); }} /></label>
          <button type="button" disabled={!!action.busy || !publicationId || !nodeIds.length || privateTerms.split(/\n/).some(value => value.trim().length === 1)} onClick={() => void prepare()}>预览所选图示的公开字段</button>
        </>}
      </>}
    </>}
    {preview && <div className="ctr-review"><h5>仅以下内容可进入公开候选记录</h5><p>{preview.publicContent.design}</p><p>{preview.publicContent.limitations}</p>
      <ul>{preview.publicContent.diagram.nodes.map(node => <li key={node.id}>{node.label}</li>)}</ul>{preview.publicContent.diagram.edges.map((edge, index) => <p key={index}>{preview.publicContent.diagram.nodes.find(node => node.id === edge.from)?.label} → {preview.publicContent.diagram.nodes.find(node => node.id === edge.to)?.label}{edge.label ? `：${edge.label}` : ""}</p>)}
      {preview.redactions.length > 0 && <p>本预览执行了 {preview.redactions.reduce((count, item) => count + item.count, 0)} 处脱敏，请逐项复核。</p>}
      <p>预览到期：{new Date(preview.expiresAt).toLocaleString("zh-CN")}</p><TrustHashDetail values={{ "公开图示预览": preview.previewHash, "所选白板版本": preview.source.hash }} />
      <label className="ctr-check"><input type="checkbox" disabled={!!action.busy} checked={consent} onChange={event => setConsent(event.target.checked)} />我已核对上述脱敏节点、连线和设计限定，仅同意冻结为公开候选；不授权发布、源码披露或事实晋级。</label>
      <button type="button" disabled={!!action.busy || !consent || attempted} onClick={() => void confirm()}>确认冻结这些公开图示字段</button>
      {attempted && <p>本预览已发出冻结请求；结果不明确时先重新读取审阅记录，不直接重复提交。</p>}
    </div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
