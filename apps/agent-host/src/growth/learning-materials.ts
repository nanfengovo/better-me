import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LearningImportSchema,
  LearningMaterialSchema,
  type LearningCitation,
  type LearningMaterial,
  type LearningPage,
} from "@better-me/agent-contracts";
import { learningFail } from "./learning-store.js";
import { extractLearningPdf } from "./learning-pdf.js";

export const learningHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const learningFingerprint = (value: unknown) =>
  learningHash(JSON.stringify(value));
export function documentRecord(
  database: DatabaseSync,
  id: string,
): LearningMaterial {
  const row = database.prepare("SELECT body FROM documents WHERE id=?").get(id);
  if (!row) learningFail("learning_material_not_found", 404);
  return LearningMaterialSchema.parse(JSON.parse(String(row.body)));
}
export function materialView(material: LearningMaterial): LearningMaterial {
  return material.revoked
    ? { ...material, pages: [] }
    : structuredClone(material);
}
export function materialBytes(database: DatabaseSync, id: string) {
  const material = documentRecord(database, id);
  if (material.revoked) learningFail("learning_material_revoked", 403);
  const row = database
    .prepare("SELECT bytes FROM documents WHERE id=?")
    .get(id)!;
  const bytes = row.bytes;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== material.bytes ||
    learningHash(bytes) !== material.hash
  )
    learningFail("learning_material_integrity_failed", 503);
  return { material, bytes };
}
export function selectedPassage(
  database: DatabaseSync,
  citation: LearningCitation,
) {
  const material = documentRecord(database, citation.materialId);
  if (material.revoked || material.revision !== citation.materialRevision)
    learningFail("learning_material_revoked", 403);
  if (material.hash !== citation.materialHash)
    learningFail("learning_material_version_conflict");
  const page = material.pages.find((item) => item.number === citation.page);
  const block = page?.blocks.find((item) => item.id === citation.blockId);
  if (
    !page ||
    page.status !== "text" ||
    !block ||
    block.hash !== citation.textHash ||
    learningHash(block.text) !== block.hash
  )
    learningFail("learning_passage_requires_review", 422);
  // Check original bytes too. A metadata row never stands in for an intact original.
  materialBytes(database, material.id);
  return { material, page, block };
}

export async function importLearningMaterial(
  database: DatabaseSync,
  ownerId: string,
  raw: unknown,
) {
  const input = LearningImportSchema.parse(raw),
    fingerprint = learningFingerprint(input),
    key = `import:${input.requestId}`;
  const previous = database
    .prepare("SELECT fingerprint,result FROM operations WHERE id=?")
    .get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      learningFail("learning_idempotency_conflict");
    return materialView(documentRecord(database, String(previous.result)));
  }
  if (
    Number(database.prepare("SELECT count(*) AS n FROM operations").get()!.n) >=
    2048
  )
    learningFail("learning_command_capacity", 413);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.base64,
    )
  )
    learningFail("learning_invalid_base64", 422);
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024)
    learningFail("learning_material_size_limit", 413);
  const fileHash = learningHash(bytes),
    id = `lm_${learningHash(`${ownerId}:${fileHash}`)}`;
  const existing = database
    .prepare("SELECT body FROM documents WHERE id=?")
    .get(id);
  let material: LearningMaterial;
  if (existing)
    material = LearningMaterialSchema.parse(JSON.parse(String(existing.body)));
  else {
    const size = database
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(length(bytes)),0) AS bytes FROM documents",
      )
      .get()!;
    if (
      Number(size.count) >= 64 ||
      Number(size.bytes) + bytes.length > 128 * 1024 * 1024
    )
      learningFail("learning_library_capacity", 413);
    let pages: LearningPage[];
    if (input.mediaType === "application/pdf") {
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        learningFail("learning_invalid_pdf", 422);
      pages = await extractLearningPdf(bytes);
    } else {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        learningFail("learning_text_utf8_required", 422);
      }
      if (!text.trim() || text.includes("\0") || text.length > 200000)
        learningFail("learning_invalid_text", 422);
      const paragraphs = text.split(/\n\s*\n/).filter((value) => value.trim());
      if (
        paragraphs.length > 300 ||
        paragraphs.some((value) => value.length > 16000)
      )
        learningFail("learning_passage_size_limit", 413);
      pages = [
        {
          number: 1,
          width: 80,
          height: Math.max(1, paragraphs.length),
          coordinateSystem: "text_lines_top_left",
          status: "text",
          blocks: paragraphs.map((text, index) => ({
            id: `b${index + 1}`,
            text,
            hash: learningHash(text),
          })),
        },
      ];
    }
    material = LearningMaterialSchema.parse({
      id,
      ownerId,
      name: input.name,
      mediaType: input.mediaType,
      hash: fileHash,
      bytes: bytes.length,
      importedAt: new Date().toISOString(),
      parser:
        input.mediaType === "application/pdf"
          ? "pdfjs-6-per-page-v1"
          : "utf8-paragraphs-v1",
      pages,
      revoked: false,
      revision: 1,
      modelConsent: false,
    });
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!existing)
      database
        .prepare("INSERT INTO documents VALUES(?,?,?)")
        .run(id, JSON.stringify(material), bytes);
    database
      .prepare("INSERT INTO operations VALUES(?,?,?)")
      .run(key, fingerprint, id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return materialView(material);
}
