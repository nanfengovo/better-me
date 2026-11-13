import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { TrustRuntime, TrustHash, TrustId, type TrustRequest } from "./CareerTrustPanel.contracts";
import { TrustActivity, TrustHashDetail, useTrustAction } from "./CareerTrustPanel.shared";
import "./CareerPrivacyLocalPanel.css";

const Choice = z.object({ operationId: TrustId, evidenceId: TrustId });
const Catalog = z.object({ contextId: TrustId, revision: z.number().int().nonnegative(), sources: z.array(Choice.extend({ sourceId: TrustId, path: z.string(), startLine: z.number().int(), endLine: z.number().int(), sourceHash: TrustHash, excerptHash: TrustHash, classification: z.literal("local_only") })),
  selected: z.array(Choice), privateTermCount: z.number().int(), embeddingRuntime: TrustRuntime.optional(), maxSearchCalls: z.number().int(), brokerAvailable: z.boolean(), limitations: z.array(z.string()) });
const Models = z.object({ runtimes: z.array(TrustRuntime), noCloudFallback: z.literal(true) });
const Search = z.object({ operation: z.object({ id: TrustId, phase: z.enum(["running", "completed", "stopped", "cancelled"]), queryHash: TrustHash, sourceSnapshotHash: TrustHash,
  runtimeFingerprint: TrustHash, stoppedCode: z.string().optional(), results: z.array(z.object({ sourceId: TrustId, similarity: z.number().finite().min(-1).max(1) })).optional() }).passthrough(),
  usedCalls: z.number().int(), trust: z.literal("local_similarity_not_fact_verification"), adopted: z.literal(false), limitations: z.array(z.string()) });
const key = (choice: z.infer<typeof Choice>) => `${choice.operationId}:${choice.evidenceId}`;

/** Source choices contain original opaque references, never a new root/path or
 * uploaded code. Raw excerpts/vectors do not enter React state or API results. */
export function CareerPrivacyLocalPanel({ contextId, request, onConfigured, onScopeDraftChanged }: { contextId: string; request: TrustRequest; onConfigured(): void; onScopeDraftChanged?(dirty: boolean): void }) {
  const action = useTrustAction(request), control = useTrustAction(request), alive = useRef(true);
  const [catalog, setCatalog] = useState<z.infer<typeof Catalog>>(), [models, setModels] = useState<z.infer<typeof Models>>(), [selected, setSelected] = useState<string[]>([]),
    [terms, setTerms] = useState(""), [embedding, setEmbedding] = useState(""), [budget, setBudget] = useState(4), [consent, setConsent] = useState(false), [embeddingConsent, setEmbeddingConsent] = useState(false),
    [dirty, setDirty] = useState(false), [query, setQuery] = useState(""), [searchConsent, setSearchConsent] = useState(false), [operationId, setOperationId] = useState(""), [result, setResult] = useState<z.infer<typeof Search>>(), [error, setError] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const modify = () => { setDirty(true); onScopeDraftChanged?.(true); setConsent(false); setEmbeddingConsent(false); setSearchConsent(false); setResult(undefined); setError(""); };
  function accept(value: z.infer<typeof Catalog>) { setCatalog(value); setSelected(value.selected.map(key)); setEmbedding(value.embeddingRuntime ? `${value.embeddingRuntime.model}:${value.embeddingRuntime.modelDigest}` : ""); setBudget(value.maxSearchCalls); setDirty(false); onScopeDraftChanged?.(false); setConsent(false); setEmbeddingConsent(false); setSearchConsent(false); setResult(undefined); setOperationId(""); }
  async function load() {
    const value = await action.run("读取原授权源码目录（不读取新路径）", "/privacy/local/catalog", { contextId }, Catalog);
    if (!value) return; accept(value); setTerms("");
    const installed = await action.run("读取已安装本地模型清单（不下载）", "/runtimes", undefined, Models);
    if (installed) setModels(installed);
  }
  async function configure() {
    setError(""); const privateTerms = terms.split(/\r?\n/).map(term => term.trim()).filter(Boolean), runtime = models?.runtimes.find(model => `${model.model}:${model.modelDigest}` === embedding);
    if (privateTerms.length > 50 || privateTerms.some(term => term.length < 2 || term.length > 200)) { setError("私有名称每行2–200字，最多50条；不会自动猜测或读取名单。"); return; }
    if (!catalog || selected.length > 8 || (embedding && !runtime)) { setError("最多选择8个原授权片段；Embedding 必须来自显式读取的本地清单。"); return; }
    const value = await action.run("复验原范围并保存本次隐私授权", "/privacy/local/configure", { contextId, expectedRevision: catalog.revision,
      selections: catalog.sources.filter(item => selected.includes(key(item))).map(({ operationId, evidenceId }) => ({ operationId, evidenceId })), privateTerms, maxSearchCalls: budget, consent: true,
      ...(runtime ? { embeddingRuntime: runtime, embeddingConsent: true } : {}) }, Catalog);
    if (value) { accept(value); onConfigured(); }
  }
  async function search() {
    if (!catalog || dirty || !catalog.embeddingRuntime) return;
    const operation = crypto.randomUUID(); setOperationId(operation); setResult(undefined);
    const value = await action.run("仅在锁定本地 Embedding 模型检索", "/privacy/local/search", { contextId, operationId: operation, expectedRevision: catalog.revision, query: query.trim(), topK: 5, consent: true }, Search);
    if (alive.current) { if (value) setResult(value); setOperationId(""); setSearchConsent(false); }
  }
  async function cancel() {
    action.cancel(); const value = await control.run("取消本地检索并拒绝晚结果", "/privacy/local/cancel", { contextId, operationId }, Search);
    if (value) { setResult(value); setOperationId(""); setSearchConsent(false); }
  }
  const busy = !!action.busy || !!control.busy;
  return <section className="career-privacy-local" aria-label="私有源码与本地检索授权"><header><h4>0 · 私有源码只留本机</h4><button type="button" disabled={busy} onClick={() => void load()}>读取已完成审查的源码范围</button></header>
    <p>只能复用已完成委员会的原 grant、原文件、原行号。这里不能输入新路径、扩大范围或把源码升级为可生成云摘要的资料。检索结果只表示片段相似度，不证明事实。</p><TrustActivity action={control} />{!operationId && <TrustActivity action={action} />}
    {error && <p role="alert" className="ctr-warning">{error}</p>}
    {catalog && <><fieldset disabled={busy}><legend>显式选择仅本地片段（最多8项）</legend>{!catalog.brokerAvailable && <p role="alert">Host 未配置原 EvidenceBroker，不能采用源码选择。</p>}{!catalog.sources.length && <p>没有可复用的已完成源码审查。请先完成委员会源码流程；自述或未完成报告不能冒充源码授权。</p>}
      {catalog.sources.map(source => <label className="cpl-source" key={key(source)}><input type="checkbox" checked={selected.includes(key(source))} onChange={() => { modify(); setSelected(value => value.includes(key(source)) ? value.filter(item => item !== key(source)) : [...value, key(source)]); }} /><span>{source.path} · L{source.startLine}–L{source.endLine} · 仅本地<small>上次完整文件 SHA：{source.sourceHash}</small></span></label>)}
      <label>显式私有名称（每行一条，不自动猜测）<textarea rows={3} value={terms} maxLength={11000} placeholder="例如：公司内部代号、本人不愿披露的项目名称" onChange={event => { modify(); setTerms(event.target.value); }} /></label>
      <p>已保存 {catalog.privateTermCount} 条；重新保存会以本框替换。留空表示明确清空，不代表系统已识别所有 PII。</p>
      <label>独立本地 Embedding 模型<select value={embedding} onChange={event => { modify(); setEmbedding(event.target.value); }}><option value="">未配置：本地向量检索不可用</option>{models?.runtimes.map(model => <option key={`${model.model}:${model.modelDigest}`} value={`${model.model}:${model.modelDigest}`}>{model.model} · {model.modelDigest.slice(0, 12)}</option>)}</select></label>
      <p>清单只证明本机已安装及权重版本，不能证明模型支持 Embedding。请选择自己确认支持向量的模型；不支持时停止，不下载、不回退，不把生成结果当向量。</p>
      <label>本次授权最多向量调用数<input type="number" min={1} max={8} value={budget} onChange={event => { modify(); setBudget(Number(event.target.value)); }} /></label>
      <label className="ctr-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我授权复验以上原范围，并确认私有名称规则的替换；源码永远仅本地。</label>
      {embedding && <label className="ctr-check"><input type="checkbox" checked={embeddingConsent} onChange={event => setEmbeddingConsent(event.target.checked)} />单独授权此精确本地模型处理所选源码向量；不向云端发送源码、查询或向量。</label>}
      <button type="button" disabled={!consent || selected.length > 8 || !Number.isSafeInteger(budget) || budget < 1 || budget > 8 || (!!selected.length && !catalog.brokerAvailable) || (!!embedding && !embeddingConsent)} onClick={() => void configure()}>复验并保存本次隐私范围</button></fieldset>
      {!catalog.embeddingRuntime && <p role="status" className="ctr-warning">Embedding 未配置：本地向量检索不可用；已批准的简历陈述摘要流程仍可单独使用。</p>}
      <fieldset disabled={busy || dirty || !catalog.embeddingRuntime || !catalog.selected.length}><legend>本地检索（独立调用授权）</legend><label>仅本地的检索问题<input value={query} maxLength={2000} onChange={event => { setQuery(event.target.value); setSearchConsent(false); setResult(undefined); }} /></label><label className="ctr-check"><input type="checkbox" checked={searchConsent} onChange={event => setSearchConsent(event.target.checked)} />仅本次调用：向上述锁定本地模型发送问题与已选源码片段。</label><button type="button" disabled={!query.trim() || !searchConsent || dirty} onClick={() => void search()}>执行一次本地向量检索</button></fieldset>
      {dirty && <p role="status">选择已修改：先重新确认保存，再检索或生成新的披露草稿。</p>}{operationId && <p role="status">本地检索执行中… <button type="button" onClick={() => void cancel()}>取消检索并停止接纳晚结果</button></p>}
      {result && <div className="ctr-review"><h4>本地结果：{result.operation.phase}</h4><p>已使用 {result.usedCalls} 次；未写入事实。</p>{result.operation.stoppedCode && <code>{result.operation.stoppedCode}</code>}{result.operation.results?.map(hit => { const source = catalog.sources.find(item => item.sourceId === hit.sourceId); return <p key={hit.sourceId}>{source ? `${source.path} L${source.startLine}–L${source.endLine}` : hit.sourceId} · 相似度 {hit.similarity.toFixed(4)}（非事实置信度）</p>; })}<TrustHashDetail values={{ "源码快照摘要": result.operation.sourceSnapshotHash, "查询摘要（不保存原查询）": result.operation.queryHash, "精确本地运行时": result.operation.runtimeFingerprint }} />{result.limitations.map(text => <p key={text}>{text}</p>)}</div>}
    </>}
  </section>;
}
