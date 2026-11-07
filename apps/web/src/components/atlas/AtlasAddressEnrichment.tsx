/** @jsxRuntime automatic */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSearch, Loader2, MapPin, X } from "lucide-react";
import type { AddressEnrichmentPlan, AddressEnrichmentPlanItem, AtlasDataset, JobLocation, OfficeAddressCandidatesResult } from "@better-me/opportunities";
import { PlatformDetailLocationsSchema, reviewedCardIdentity, type ImportDetailLocationsInput, type PlatformDetailLocations,
  type CompanyCareerDiscoveryResult, type SourceFieldEvidence, type SourceRecordLocation } from "@better-me/source-adapters/browser-contracts";
import { extractJdLink } from "../../lib/jd-import";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasAddressEnrichment.css";

const OfficeConfirmation = lazy(() => import("./AtlasOfficeAddressConfirmation").then(module => ({ default: module.AtlasOfficeAddressConfirmation })));

export type AtlasAddressEnrichmentProps = {
  endpoint: string; token: string; data: AtlasDataset; jobIds: string[];
  onSnapshot(snapshot: AtlasDataset): void; onClose(): void;
  onOfficeSnapshot?(snapshot: AtlasDataset, location: JobLocation, jobId: string): void;
  onReviewJob(jobId: string): void; onReviewOffice(jobId: string, locationId: string): void;
};
type Capture = { jobId: string; listingId: string; value: PlatformDetailLocations };
type OfficialEvidence = { listingId: string; url: string; observedAt: string; locations: SourceRecordLocation[]; evidence: SourceFieldEvidence[] };
type Row = { item: AddressEnrichmentPlanItem; status: "waiting" | "reading" | "done" | "skipped" | "error" | "cancelled";
  messages: string[]; captures: Capture[]; addresses: OfficeAddressCandidatesResult[]; company?: CompanyCareerDiscoveryResult;
  official?: OfficialEvidence[]; savedCaptureKeys?: string[]; savedLocationIds?: string[] };
type Checkpoint = { rows: Row[]; capture: Capture; request: { input: ImportDetailLocationsInput; key: string };
  locationIds: string[]; receipt?: { revision: number } };
// Uncertain writes remain recoverable for the exact connection and result scope in this page.
// Credentials, source addresses and command bodies are never written to browser storage.
const recovery = new Map<string, Checkpoint>();
const TERMINAL = new Set(["stale-version", "invalid-input", "source-changed", "idempotency-conflict", "not-authorized", "not-found"]);
const keyFor = (value: Capture) => `${value.jobId}:${value.listingId}`;
const rowStatus = { waiting: "等待", reading: "正在读取", done: "已读取", skipped: "已跳过", error: "部分失败", cancelled: "已取消" };

export function AtlasAddressEnrichment(props: AtlasAddressEnrichmentProps) {
  const jobIds = [...new Set(props.jobIds)].slice(0, 50);
  const scope = JSON.stringify([props.endpoint, props.token, [...jobIds].sort()]);
  return <EnrichmentSession key={scope} {...props} jobIds={jobIds} scope={scope} loadedJobs={new Set(props.jobIds).size} />;
}

function EnrichmentSession({ endpoint, token, data, jobIds, scope, loadedJobs, onSnapshot, onClose, onOfficeSnapshot, onReviewJob, onReviewOffice }: AtlasAddressEnrichmentProps & { scope: string; loadedJobs: number }) {
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [restored] = useState(() => recovery.get(scope));
  const [rows, setRows] = useState<Row[]>(restored?.rows ?? []);
  const [plan, setPlan] = useState<AddressEnrichmentPlan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Checkpoint | undefined>(restored);
  const [busy, setBusy] = useState<"read" | "write" | undefined>();
  const [officeReview, setOfficeReview] = useState<{ jobId: string; locationId: string; snapshot: AtlasDataset }>();
  const [stale, setStale] = useState(false), [error, setError] = useState("");
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const active = useRef<{ controller: AbortController; kind: "read" | "write" } | undefined>(undefined);
  const closed = useRef(false), knownRevision = useRef(data.revision);
  const latest = useRef({ revision: data.revision, onSnapshot, onClose, onOfficeSnapshot });
  latest.current.onSnapshot = onSnapshot; latest.current.onClose = onClose; latest.current.onOfficeSnapshot = onOfficeSnapshot;
  const officeRef = useRef(officeReview); officeRef.current = officeReview;
  const snapshotRef = useRef(data);
  const initialRevision = useRef(data.revision);
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; active.current?.controller.abort(); active.current = undefined; };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || closed.current) return;
      event.preventDefault();
      if (officeRef.current) { officeRef.current = undefined; setOfficeReview(undefined); return; }
      closed.current = true; active.current?.controller.abort(); latest.current.onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    latest.current.revision = data.revision;
    if (data.revision >= snapshotRef.current.revision) snapshotRef.current = data;
    if (data.revision === knownRevision.current) return;
    active.current?.controller.abort(); setStale(true); setSelected([]);
    setOfficeReview(undefined);
    setError("索引版本已改变，已停止旧版读取。请重新读取本批岗位；待确认写入仍可核对原回执。");
  }, [data]);
  const alive = (signal: AbortSignal) => { signal.throwIfAborted(); if (closed.current || active.current?.controller.signal !== signal) throw new Error("本批岗位核对已关闭。"); };
  function update(jobId: string, change: (row: Row) => Row) {
    const next = rowsRef.current.map(row => row.item.jobId === jobId ? change(row) : row);
    rowsRef.current = next; setRows(next);
  }
  async function run(kind: "read" | "write", work: (signal: AbortSignal) => Promise<void>) {
    if (active.current || closed.current) return;
    const controller = new AbortController(); active.current = { controller, kind }; setBusy(kind); setError("");
    const timer = setTimeout(() => controller.abort(), kind === "read" ? 120_000 : 90_000);
    try { await work(controller.signal); }
    catch (problem) { if (!closed.current) setError(controller.signal.aborted ? "已停止本轮等待，已完成的结果保留；已提交的保存请使用原请求核对回执。" : problem instanceof Error ? problem.message : "本轮读取未完成。"); }
    finally {
      clearTimeout(timer);
      if (active.current?.controller === controller) active.current = undefined;
      if (!closed.current) {
        setBusy(undefined);
        const next = rowsRef.current.map(row => ["reading", "waiting"].includes(row.status) ? { ...row, status: "cancelled" as const } : row);
        rowsRef.current = next; setRows(next);
      }
    }
  }
  function read() { return run("read", async signal => {
    if (pending || !jobIds.length) return;
    const revision = latest.current.revision; knownRevision.current = revision; setStale(false); setSelected([]);
    const nextPlan = await client.planAddressEnrichment({ jobIds, expectedRevision: revision }, { signal }); alive(signal);
    if (nextPlan.snapshotRevision !== latest.current.revision) throw new Error("计划版本已过期，请重新读取。");
    setPlan(nextPlan);
    const nextRows: Row[] = nextPlan.items.map(item => ({ item, status: "waiting", messages: [], captures: [], addresses: [] }));
    rowsRef.current = nextRows; setRows(nextRows);
    const companies = new Map<string, Promise<CompanyCareerDiscoveryResult>>();
    let cursor = 0;
    async function readRow(item: AddressEnrichmentPlanItem) {
      alive(signal); update(item.jobId, row => ({ ...row, status: "reading" }));
      if (item.status === "office-ready" || item.status === "remote-only") {
        update(item.jobId, row => ({ ...row, status: "skipped", messages: [item.status === "remote-only" ? "远程资格不作为办公地点。" : "已有有效办公位置，本轮不重复外读。"] })); return;
      }
      const captures: Capture[] = [], addresses: OfficeAddressCandidatesResult[] = [], official: OfficialEvidence[] = [], messages: string[] = [];
      let company: CompanyCareerDiscoveryResult | undefined, failures = 0;
      for (const target of item.sourceStreetTargets.slice(0, 2)) {
        alive(signal);
        try {
          const source = target.sourceLocation;
          const result = await client.officeAddressCandidates({ jobId: item.jobId, locationId: target.locationId, expectedRevision: revision,
            query: source.streetAddress!, ...(source.city ? { locality: source.city } : {}), ...(source.postalCode ? { postalCode: source.postalCode } : {}) }, { signal });
          alive(signal); addresses.push(result);
          messages.push(result.candidates.length ? `找到 ${result.candidates.length} 个地址候选，需本人核对。` : result.configured ? "地址来源未找到匹配，保留原精度。" : "地址查询服务未配置，可继续人工核对。");
        } catch (problem) { alive(signal); failures++; messages.push(problem instanceof Error ? problem.message : "街址候选读取失败。"); }
      }
      for (const target of item.exactPlatformTargets.slice(0, 2)) {
        alive(signal);
        try {
          const result = await extractJdLink(target.url, signal); alive(signal);
          const parsed = PlatformDetailLocationsSchema.safeParse(result.detailLocations);
          const expected = reviewedCardIdentity(target.url, target.provider), actual = parsed.success && reviewedCardIdentity(parsed.data.url, target.provider);
          if (result.provenance.edited || !parsed.success || parsed.data.workMode === "remote" || parsed.data.provider !== target.provider
            || !expected || !actual || expected.id !== actual.id || !parsed.data.locations.some(location => location.streetAddress)) {
            messages.push(`${target.label} 未披露可用的同岗位街道地址，可逐岗打开原文核对。`); continue;
          }
          captures.push({ jobId: item.jobId, listingId: target.listingId, value: parsed.data });
          messages.push(`${target.label} 已读取地址证据，等待本人选择保存；尚未生成坐标。`);
        } catch (problem) { alive(signal); failures++; messages.push(problem instanceof Error ? problem.message : "原岗位详情读取失败。"); }
      }
      if (!item.sourceStreetTargets.length && !captures.length) for (const target of item.ownedOfficialTargets.slice(0, 2)) {
        alive(signal);
        const listing = snapshotRef.current.listings.find(entry => entry.id === target.listingId && entry.canonicalJobId === item.jobId
          && entry.sourceId === target.sourceId && entry.canonicalUrl === target.url);
        if (!listing?.sourceRecordId) { messages.push("官网来源缺少同岗位原始编号，未将同名岗位地址合入。"); continue; }
        try {
          const result = await client.preview(target.sourceId, { scope: { roles: item.title.length <= 300 ? [item.title] : [],
            regions: [], companyNames: item.companyName.length <= 300 ? [item.companyName] : [] }, maxRecords: 50 }, { signal }); alive(signal);
          const matches = result.page.records.filter(record => record.entityType === "job-posting" && record.sourceRecordId === listing.sourceRecordId);
          if (matches.length !== 1 || matches[0]!.workMode === "remote" || matches[0]!.url !== listing.canonicalUrl) {
            messages.push("本次官网读取未返回唯一同编号、同链接的非远程岗位，保留原精度。"); continue;
          }
          const record = matches[0]!, locations = record.locations.filter(location => location.streetAddress);
          if (locations.length) {
            official.push({ listingId: listing.id, url: record.url!, observedAt: result.page.observedAt, locations, evidence: record.evidence });
            messages.push("官网返回同岗位街址线索，需打开原文核对；未保存或生成办公坐标。");
          } else messages.push("官网同岗位尚未披露街道地址，保留原精度。");
          messages.push(...result.page.warnings.slice(0, 3));
        } catch (problem) { alive(signal); failures++; messages.push(problem instanceof Error ? problem.message : "原官网岗位读取失败。"); }
      }
      if (!item.sourceStreetTargets.length && !captures.length && !official.length) {
        alive(signal);
        const companyKey = item.companyName.normalize("NFKC").trim().toLocaleLowerCase();
        let request = companies.get(companyKey);
        if (!request && item.companyName.length <= 240) { request = client.discoverCompany(undefined, { companyName: item.companyName, limit: 5, maxPages: 2 }, { signal }); companies.set(companyKey, request); }
        try {
          if (request) { company = await request; alive(signal); messages.push("企业招聘入口仅作为待核实线索，不能作为当前岗位办公地址。"); }
          else messages.push("企业名称超过入口工具的查询长度，请逐岗核对原文。");
        }
        catch (problem) { alive(signal); failures++; messages.push(problem instanceof Error ? problem.message : "企业招聘入口查询失败。"); }
      }
      if (item.sourceStreetTargets.length > 2 || item.exactPlatformTargets.length > 2) messages.push("本轮每岗最多读取 2 个街址和 2 个平台详情，其余可逐岗核对。");
      if (item.ownedOfficialTargets.length > 2) messages.push("本轮每岗最多读取 2 个官网来源，其余可逐岗核对。");
      update(item.jobId, row => ({ ...row, status: failures ? "error" : "done", captures, addresses, official, company, messages }));
    }
    await Promise.all(Array.from({ length: Math.min(2, nextRows.length) }, async () => {
      while (cursor < nextRows.length) { alive(signal); const item = nextRows[cursor++]!.item; await readRow(item); }
    }));
  }); }
  async function publish(snapshot: AtlasDataset, minimum: number, signal: AbortSignal) {
    alive(signal);
    if (snapshot.revision < Math.max(latest.current.revision, minimum)) throw new Error("尚未读到已保存或当前索引版本，请重新核对回执。");
    knownRevision.current = snapshot.revision; latest.current.revision = snapshot.revision; snapshotRef.current = snapshot; latest.current.onSnapshot(snapshot);
  }
  async function executeCheckpoint(checkpoint: Checkpoint, signal: AbortSignal) {
    let current = checkpoint;
    if (!current.receipt) {
      let receipt;
      try { receipt = await client.importDetailLocations(current.request.input, { signal, idempotencyKey: current.request.key }); }
      catch (problem) {
        if (problem instanceof AtlasSourceServiceError && TERMINAL.has(problem.code)) {
          recovery.delete(scope);
          if (!closed.current) { setPending(undefined); setSelected([]); setStale(true); }
        }
        throw problem;
      }
      current = { ...current, receipt: { revision: receipt.revision } };
      recovery.set(scope, current); if (!closed.current) setPending(current);
    }
    alive(signal);
    const snapshot = await client.snapshot({ signal }); await publish(snapshot, current.receipt!.revision, signal); alive(signal);
    const listing = snapshot.listings.find(entry => entry.id === current.capture.listingId && entry.canonicalJobId === current.capture.jobId);
    const ids = (listing?.locationIds ?? []).filter(id => current.locationIds.includes(id));
    update(current.capture.jobId, row => ({ ...row,
      savedCaptureKeys: [...new Set([...(row.savedCaptureKeys ?? []), keyFor(current.capture)])],
      savedLocationIds: [...new Set([...(row.savedLocationIds ?? []), ...ids])],
      messages: [...row.messages, `来源地点已保存，索引版本 ${current.receipt!.revision}。办公位置以当前核对记录为准。`] }));
    recovery.delete(scope); setPending(undefined); setSelected(prior => prior.filter(key => key !== keyFor(current.capture)));
  }
  function save() { return run("write", async signal => {
    if (pending) { await executeCheckpoint(pending, signal); return; }
    if (stale) return;
    const captures = rowsRef.current.flatMap(row => row.captures.filter(capture => !row.savedCaptureKeys?.includes(keyFor(capture)))).filter(capture => selected.includes(keyFor(capture)));
    for (const capture of captures) {
      alive(signal);
      const snapshot = await client.snapshot({ signal }); alive(signal);
      if (snapshot.revision !== knownRevision.current) {
        setStale(true); setSelected([]);
        throw new Error("索引版本已改变，原地址选择已清除；请重新读取本批岗位。");
      }
      const preview = await client.previewDetailLocations({ jobId: capture.jobId, listingId: capture.listingId, capture: capture.value, expectedRevision: snapshot.revision }, { signal }); alive(signal);
      const checkpoint: Checkpoint = { rows: rowsRef.current, capture, locationIds: preview.newLocations.map(location => location.id), request: { input: { jobId: capture.jobId, listingId: capture.listingId, capture: capture.value,
        expectedRevision: preview.expectedRevision, previewFingerprint: preview.previewFingerprint, reviewed: true }, key: `address-batch-${crypto.randomUUID()}` } };
      recovery.set(scope, checkpoint); setPending(checkpoint);
      await executeCheckpoint(checkpoint, signal);
    }
  }); }
  function reviewOffice(jobId: string, locationId: string) {
    if (busy || pending || stale) return;
    const snapshot = snapshotRef.current;
    if (snapshot.jobs.some(job => job.id === jobId && job.locationIds.includes(locationId)) && snapshot.locations.some(location => location.id === locationId)) {
      setOfficeReview({ jobId, locationId, snapshot });
    } else onReviewOffice(jobId, locationId);
  }
  const officeLocation = officeReview?.snapshot.locations.find(location => location.id === officeReview.locationId);
  if (officeReview && officeLocation) return <section className="atlas-address-enrichment atlas-enrichment-office" aria-label="批量核对岗位办公地点">
    <button type="button" onClick={() => setOfficeReview(undefined)}>返回批量结果</button>
    <Suspense fallback={<p role="status"><Loader2 size={14} className="animate-spin" />正在打开办公地址核对</p>}><OfficeConfirmation
      endpoint={endpoint} token={token} jobId={officeReview.jobId} location={officeLocation} revision={officeReview.snapshot.revision}
      onClose={() => setOfficeReview(undefined)} onSnapshot={snapshot => {
        if (closed.current || snapshot.revision < Math.max(latest.current.revision, officeReview.snapshot.revision)) return;
        const location = snapshot.locations.find(value => value.id === officeReview.locationId);
        const original = officeReview.snapshot.locations.find(value => value.id === officeReview.locationId);
        const savedOffice = snapshot.revision > officeReview.snapshot.revision && location?.kind === "office" && !!location.coordinates
          && ["address", "manual"].includes(location.precision) && location.evidence.length > 0
          && location.officeResolution?.method === "manual-user-confirmation" && location.officeResolution.originalLocationId === location.id
          && location.officeResolution.decisionId !== original?.officeResolution?.decisionId
          && snapshot.jobs.some(job => job.id === officeReview.jobId && job.locationIds.includes(location.id));
        knownRevision.current = snapshot.revision; latest.current.revision = snapshot.revision; snapshotRef.current = snapshot;
        setStale(true); setSelected([]); setOfficeReview(prior => prior ? { ...prior, snapshot } : undefined);
        latest.current.onSnapshot(snapshot);
        if (savedOffice && !closed.current) latest.current.onOfficeSnapshot?.(snapshot, location, officeReview.jobId);
      }} /></Suspense>
  </section>;
  const completed = rows.filter(row => !["waiting", "reading"].includes(row.status)).length;
  return <section className="atlas-address-enrichment" aria-label="批量核对岗位办公地点" aria-busy={!!busy}>
    <header><div><span>OFFICE ADDRESS REVIEW</span><h2>补全岗位办公地点</h2></div><button type="button" aria-label="关闭批量地址核对" onClick={() => { closed.current = true; active.current?.controller.abort(); onClose(); }}><X size={17} /></button></header>
    <p>本次范围：当前已加载 {loadedJobs} 岗，选择前 {jobIds.length} 岗，单批最多 50 岗。{loadedJobs > 50 && "其余岗位未加入本批。"}以索引版本 {plan?.snapshotRevision ?? initialRevision.current} 的原岗位及地点为依据。</p>
    <p className="atlas-enrichment-boundary">点击读取后，来源披露的街道、城市和邮编会发送给已配置的地址服务；同时读取同岗位公开详情。缺少街址时，使用岗位标题和企业名称查询原官网来源，再按公司去重查询招聘入口。并发最多 2 岗。地址候选、官网入口均需核对，不自动保存或生成办公坐标。</p>
    <div className="atlas-enrichment-actions"><button type="button" disabled={!!busy || !!pending || !jobIds.length} onClick={() => void read()}><FileSearch size={15} />读取所选岗位的办公地点</button>{busy && <button type="button" onClick={() => active.current?.controller.abort()}>{busy === "read" ? "取消本轮读取" : "停止等待保存"}</button>}</div>
    {!!rows.length && <p role="status">已处理 {completed} / {rows.length} 岗{busy === "read" && <Loader2 size={14} className="animate-spin" />}{stale && " · 原计划已过期"}</p>}
    {plan?.warnings.map(warning => <p className="atlas-enrichment-warning" key={warning}>{warning}</p>)}
    <div className="atlas-enrichment-rows">{rows.map(row => <article key={row.item.jobId} data-job-id={row.item.jobId}>
      <div className="atlas-enrichment-row-heading"><strong>{row.item.title}</strong><span data-status={row.status}>{row.status === "reading" && <Loader2 size={12} className="animate-spin" />}{rowStatus[row.status]}</span></div><small>{row.item.companyName}</small>
      {row.messages.map((message, index) => <p key={index}>{message}</p>)}
      {row.item.warnings.map(warning => <p key={warning} className="atlas-enrichment-warning">{warning}</p>)}
      {row.captures.map(capture => <label className="atlas-enrichment-capture" key={capture.listingId}><input type="checkbox" disabled={!!busy || !!pending || stale || !!row.savedCaptureKeys?.includes(keyFor(capture))} checked={selected.includes(keyFor(capture))} onChange={event => setSelected(prior => event.target.checked ? [...prior, keyFor(capture)] : prior.filter(key => key !== keyFor(capture)))} /><span>{row.savedCaptureKeys?.includes(keyFor(capture)) ? "来源地点已保存" : "我已核对该岗位及地址出处，选择保存来源地点"}<small>{capture.value.locations.map(location => location.streetAddress ?? location.raw).join(" / ")}</small><a href={capture.value.url} target="_blank" rel="noopener noreferrer">核对原岗位</a><details><summary>地址原文证据</summary>{capture.value.locations.map((location, index) => <pre key={index}>{location.evidence.quote}</pre>)}</details></span></label>)}
      {row.addresses.map(result => <div key={result.locationId} className="atlas-enrichment-candidates"><strong>办公地址候选 · 尚未采用</strong>{result.candidates.map(candidate => <p key={candidate.id}>{candidate.proposal.formattedAddress}<small>{candidate.attribution} · 待核实</small><a href={candidate.evidenceUrl} target="_blank" rel="noopener noreferrer">核对候选出处</a></p>)}{result.warnings.map(warning => <p key={warning}>{warning}</p>)}<button type="button" disabled={!!busy || !!pending || stale} onClick={() => reviewOffice(row.item.jobId, result.locationId)}><MapPin size={13} />核对具体办公点</button></div>)}
      {(row.savedLocationIds ?? row.item.currentOffice.map(location => location.id)).map(id => <button key={id} type="button" disabled={!!busy || !!pending || stale} onClick={() => reviewOffice(row.item.jobId, id)}><MapPin size={13} />核对具体办公点</button>)}
      {row.official?.map(result => <div key={result.listingId} className="atlas-enrichment-company"><strong>官网同岗位街址线索 · 待核对</strong>
        {result.locations.map((location, index) => <p key={index}>{location.streetAddress}<small>{[location.countryCode, location.region, location.city, location.postalCode].filter(Boolean).join(" · ")}</small></p>)}
        <small>读取时间：{result.observedAt} · 尚未保存或定位</small><a href={result.url} target="_blank" rel="noopener noreferrer">核对官网同岗位原文</a>
        {!!result.evidence.length && <details><summary>官网字段出处</summary>{result.evidence.map((evidence, index) => <p key={index}>{evidence.field} · {evidence.selector}<small>{evidence.quote}</small><a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">查看出处</a></p>)}</details>}
      </div>)}
      {row.company && <div className="atlas-enrichment-company"><strong>企业招聘入口 · 关联待核实</strong>{[...new Set([...row.company.matchedSources.flatMap(source => source.entryUrl ? [source.entryUrl] : []), ...row.company.candidates.map(candidate => candidate.candidate.homeUrl)])].map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} · 招聘入口线索</a>)}{row.company.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>此处未确认同一岗位或办公地址。</p></div>}
      {row.item.ownedOfficialTargets.map(target => <a key={target.listingId} href={target.url} target="_blank" rel="noopener noreferrer">{target.label} · 原官网岗位</a>)}
      <button type="button" disabled={!!busy} onClick={() => onReviewJob(row.item.jobId)}>打开原岗位继续核对</button>
    </article>)}</div>
    {(selected.length > 0 || pending) && <div className="atlas-enrichment-save"><p>{pending ? pending.receipt ? "地点已保存，需重新读取索引确认。" : "本次保存结果待确认；关闭后重新打开相同范围，可用原请求核对回执。页面刷新前请完成核对。" : `已选择 ${selected.length} 份同岗位地址证据。仅保存来源地址，不采用候选坐标或官网线索。`}</p><button type="button" disabled={!!busy} onClick={() => void save()}><Check size={14} />{pending ? pending.receipt ? "重新读取已保存索引" : "核对本次保存回执" : "确认保存选中来源地址"}</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
