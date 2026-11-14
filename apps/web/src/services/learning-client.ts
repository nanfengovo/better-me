import { z } from "zod";
import {
  LearningMaterialSchema,
  LearningPathSchema,
  LearningCitationSchema,
  LearningBlockSchema,
  LearningCommandSchema,
  TranslationBackendSchema,
  TranslationJobSchema,
  TranslationCreateSchema,
  TranslationReviewSchema,
  type TranslationCreate,
  type TranslationJob,
  type LearningMaterial,
  type LearningCitation,
  type LearningCommand,
} from "@better-me/agent-contracts";
import {
  agentOrigin,
  captureIdentityLease,
  IdentityBoundaryError,
  ownedFetch,
} from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

export function createLearningClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
) {
  async function response(
    suffix: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const lease = captureIdentityLease();
    lease.assert();
    if (!lease.ownerId)
      throw new Error("请先登录 BetterMe，再读取本人学习记录。");
    const result = await ownedFetch(
      `${(options.baseUrl ?? agentOrigin()).replace(/\/$/, "")}/api/v1/agent/growth/learning${suffix}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error", // A 307 must never forward owner material or a one-job credential.
        signal: AbortSignal.any([
          lease.signal,
          AbortSignal.timeout(45_000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      options.fetch ?? globalThis.fetch,
    );
    lease.assert();
    if (!result.ok) {
      const error = await result.json().catch(() => undefined);
      lease.assert();
      throw new Error(error?.error ?? `学习请求失败（HTTP ${result.status}）`);
    }
    return { result, lease };
  }
  async function json<T>(
    suffix: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const { result, lease } = await response(suffix, body, signal);
    const value = schema.parse(await result.json());
    lease.assert();
    return { value, ownerId: lease.ownerId };
  }
  function own<T extends { ownerId: string }>(
    value: T,
    ownerId: string | undefined,
  ) {
    if (value.ownerId !== ownerId) throw new IdentityBoundaryError();
    return value;
  }
  async function materials(signal?: AbortSignal) {
    const { value, ownerId } = await json(
      "/materials",
      z.object({ materials: z.array(LearningMaterialSchema) }).strict(),
      undefined,
      signal,
    );
    return value.materials.map((material) => own(material, ownerId));
  }
  async function material(id: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/materials/${encodeURIComponent(id)}`,
      z.object({ material: LearningMaterialSchema }).strict(),
      undefined,
      signal,
    );
    if (value.material.id !== id) throw new Error("资料标识不匹配");
    return own(value.material, ownerId);
  }
  async function importMaterial(
    file: File,
    requestId: string,
    signal?: AbortSignal,
  ) {
    const selectedBy = captureIdentityLease();
    selectedBy.assert();
    signal?.throwIfAborted();
    if (!file.size || file.size > 8 * 1024 * 1024)
      throw new Error("请选择不超过 8 MiB 的 PDF 或 UTF-8 文本。");
    const mediaType = /\.pdf$/i.test(file.name)
      ? "application/pdf"
      : /\.txt$/i.test(file.name)
        ? "text/plain"
        : undefined;
    if (!mediaType)
      throw new Error("本轮支持 PDF 和 UTF-8 .txt；没有修改简历导入器。");
    if (file.name.length > 180)
      throw new Error("文件名最多 180 字符，请重命名后再选。");
    const buffer = new Uint8Array(await file.arrayBuffer());
    selectedBy.assert();
    signal?.throwIfAborted();
    let encoded = "";
    for (let offset = 0; offset < buffer.length; offset += 8192)
      encoded += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
    selectedBy.assert();
    const { value, ownerId } = await json(
      "/materials",
      z.object({ material: LearningMaterialSchema }).strict(),
      {
        requestId,
        consent: true,
        name: file.name,
        mediaType,
        base64: btoa(encoded),
      },
      signal,
    );
    return own(value.material, ownerId);
  }
  async function bytes(material: LearningMaterial, signal?: AbortSignal) {
    const selectedBy = captureIdentityLease();
    selectedBy.assert();
    own(material, selectedBy.ownerId);
    const { result, lease } = await response(
      `/materials/${encodeURIComponent(material.id)}/bytes`,
      undefined,
      signal,
    );
    const bytes = new Uint8Array(await result.arrayBuffer());
    lease.assert();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    lease.assert();
    if (
      bytes.length !== material.bytes ||
      digest !== material.hash ||
      result.headers.get("X-Content-SHA256") !== digest ||
      result.headers.get("Content-Type") !== material.mediaType
    )
      throw new Error("原件字节、类型或哈希不一致，未展示。");
    return bytes;
  }
  async function passage(citation: LearningCitation, signal?: AbortSignal) {
    const suffix = `/materials/${encodeURIComponent(citation.materialId)}/passages/${citation.page}/${encodeURIComponent(citation.blockId)}`;
    const { value, ownerId } = await json(
      suffix,
      z
        .object({
          ownerId: z.string(),
          citation: LearningCitationSchema,
          block: LearningBlockSchema,
        })
        .strict(),
      undefined,
      signal,
    );
    own(value, ownerId);
    if (
      JSON.stringify(value.citation) !==
      JSON.stringify(LearningCitationSchema.parse(citation))
    )
      throw new Error("选段版本或权限已变化");
    return value.block;
  }
  async function paths(signal?: AbortSignal) {
    const { value, ownerId } = await json(
      "/paths",
      z.object({ paths: z.array(LearningPathSchema) }).strict(),
      undefined,
      signal,
    );
    return value.paths.map((path) => own(path, ownerId));
  }
  async function get(id: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/paths/${encodeURIComponent(id)}`,
      z.object({ path: LearningPathSchema }).strict(),
      undefined,
      signal,
    );
    if (value.path.id !== id) throw new Error("学习目标标识不匹配");
    return own(value.path, ownerId);
  }
  async function create(
    input: {
      requestId: string;
      consent: true;
      title: string;
      weeklyHours: number;
    },
    signal?: AbortSignal,
  ) {
    const { value, ownerId } = await json(
      "/paths",
      z.object({ path: LearningPathSchema }).strict(),
      input,
      signal,
    );
    return own(value.path, ownerId);
  }
  async function command(
    id: string,
    input: LearningCommand,
    signal?: AbortSignal,
  ) {
    const { value, ownerId } = await json(
      `/paths/${encodeURIComponent(id)}/commands`,
      z.object({ path: LearningPathSchema }).strict(),
      LearningCommandSchema.parse(input),
      signal,
    );
    if (value.path.id !== id) throw new Error("学习目标标识不匹配");
    return own(value.path, ownerId);
  }
  async function revoke(id: string, requestId: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/materials/${encodeURIComponent(id)}/revoke`,
      z.object({ material: LearningMaterialSchema }).strict(),
      { requestId, consent: true },
      signal,
    );
    return own(value.material, ownerId);
  }
  async function translationBackend(signal?: AbortSignal,location:"local"|"cloud"="local") {
    const { value } = await json(
      location==="cloud"?"/translations/backend/cloud":"/translations/backend",
      z.object({ backend: TranslationBackendSchema }).strict(),
      undefined,
      signal,
    );
    return value.backend;
  }
  async function translations(signal?: AbortSignal) {
    const { value, ownerId } = await json(
      "/translations",
      z.object({ jobs: z.array(TranslationJobSchema).max(24) }).strict(),
      undefined,
      signal,
    );
    return value.jobs.map((job) => own(job, ownerId));
  }
  async function translation(id: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/translations/${encodeURIComponent(id)}`,
      z.object({ job: TranslationJobSchema }).strict(),
      undefined,
      signal,
    );
    if (value.job.id !== id) throw new Error("译稿作业编号不匹配");
    return own(value.job, ownerId);
  }
  async function translationByRequest(id: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/translations/requests/${encodeURIComponent(id)}`,
      z.object({ job: TranslationJobSchema }).strict(),
      undefined,
      signal,
    );
    if (value.job.request.requestId !== id)
      throw new Error("原翻译请求编号不匹配");
    return own(value.job, ownerId);
  }
  async function createTranslation(
    input: TranslationCreate,
    signal?: AbortSignal,
    credential?: string,
  ) {
    const request = TranslationCreateSchema.parse(input);
    if(request.cloudGrant){
      const target=new URL(options.baseUrl??agentOrigin(),globalThis.location?.origin);
      if(!credential||target.username||target.password||!(target.protocol==="https:"||
        (target.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(target.hostname))))
        throw new Error("云端翻译需要在本人已认证的 HTTPS 或本机回环 Host 中单次授权。");
    }else if(credential)throw Error("本机作业不接收云密钥。");
    const { value, ownerId } = await json(
      "/translations",
      z.object({ job: TranslationJobSchema }).strict(),
      request.cloudGrant?{request,credential}:request,
      signal,
    );
    if (JSON.stringify(value.job.request) !== JSON.stringify(request))
      throw new Error("翻译作业没有绑定所选原件和后端");
    return own(value.job, ownerId);
  }
  async function cancelTranslation(id: string, signal?: AbortSignal) {
    const { value, ownerId } = await json(
      `/translations/${encodeURIComponent(id)}/cancel`,
      z.object({ job: TranslationJobSchema }).strict(),
      { consent: true },
      signal,
    );
    if (value.job.id !== id) throw new Error("停止回执的作业编号不匹配");
    return own(value.job, ownerId);
  }
  async function reviewTranslation(
    id: string,
    input: z.infer<typeof TranslationReviewSchema>,
    signal?: AbortSignal,
  ) {
    const { value, ownerId } = await json(
      `/translations/${encodeURIComponent(id)}/review`,
      z.object({ job: TranslationJobSchema }).strict(),
      TranslationReviewSchema.parse(input),
      signal,
    );
    if (value.job.id !== id) throw new Error("审阅回执的作业编号不匹配");
    return own(value.job, ownerId);
  }
  async function translationBytes(
    job: TranslationJob,
    kind: "mono" | "dual",
    signal?: AbortSignal,
  ) {
    own(job, captureIdentityLease().ownerId);
    const artifact = job.artifacts.find((item) => item.kind === kind);
    if (!artifact || job.state === "source_revoked")
      throw new Error("译稿未生成或资料已撤权");
    const { result, lease } = await response(
      `/translations/${encodeURIComponent(job.id)}/artifacts/${kind}`,
      undefined,
      signal,
    );
    if (
      result.headers.get("Content-Type") !== "application/pdf" ||
      result.headers.get("X-Content-SHA256") !== artifact.hash
    )
      throw new Error("译稿类型或哈希不一致");
    const reader = result.body?.getReader();
    if (!reader) throw new Error("译稿字节不可用");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        lease.assert();
        if (part.done) break;
        total += part.value.length;
        if (total > artifact.bytes) throw new Error("译稿字节超过原回执上限");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    lease.assert();
    if (
      total !== artifact.bytes ||
      digest !== artifact.hash ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    )
      throw new Error("译稿字节、长度或哈希不一致");
    return bytes;
  }
  return {
    materials,
    material,
    importMaterial,
    bytes,
    passage,
    paths,
    get,
    create,
    command,
    revoke,
    translationBackend,
    translations,
    translation,
    translationByRequest,
    createTranslation,
    cancelTranslation,
    reviewTranslation,
    translationBytes,
  };
}
export type LearningClient = ReturnType<typeof createLearningClient>;
export const defaultLearningClient = createLearningClient();
