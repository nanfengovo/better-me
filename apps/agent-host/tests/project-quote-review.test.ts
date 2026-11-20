import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { UnderstandingEvidence } from "@better-me/agent-contracts";
import { buildProjectQuoteCatalog, verifyProjectQuoteReview } from "../src/kernel/project-quote-review.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// Model the broker's absolute UTF-16 offsets. The task receives only the selected portion of the file.
function material(path: string, full: string, prefix = ""): UnderstandingEvidence {
  assert.ok(full.startsWith(prefix));
  const startLine = prefix.split("\n").length;
  const excerpt = full.slice(prefix.length);
  return {
    id: "ev_" + digest("grant-warehouse:" + path + ":" + full + ":" + prefix.length).slice(0, 24),
    grantId: "grant-warehouse",
    path,
    hash: digest(full),
    startLine,
    endLine: startLine + excerpt.split("\n").length - 1,
    excerpt,
    collectedAt: timestamp,
    startOffset: prefix.length,
    endOffset: full.length,
    sourceLength: full.length,
  };
}

test("Host quotes selected lines in three synthetic project files and preserves source type, CRLF bytes and coordinates", () => {
  const codeLine = "// 仓储联调中，对重复请求按请求编号去重。";
  const replayLine = "仓储测试用 Redis 回放重复请求，核对去重分支。";
  const sideLine = "仓储轮岗整理了收货区货架图。";
  const prefix = "# 仓储回放 🧪\r\n";
  const codeFile = "// 仓储用例\r\n" + codeLine + "\r\n";
  const replayFile = prefix + "本段属于联调阶段。\r\n\r\n" + replayLine + "\r\n旁注：夹具编号。";
  const input = [
    material("src/dedup.ts", codeFile),
    material("checks/replay.md", replayFile, prefix),
    material("layout.md", sideLine),
  ];
  const catalog = buildProjectQuoteCatalog(input, "仓储重复请求 去重 Redis 回放");
  const first = catalog.find((row) => row.evidence.excerpt === codeLine)!;
  const second = catalog.find((row) => row.evidence.excerpt === replayLine)!;
  assert.ok(first && second);
  assert.equal(new Set(catalog.map((row) => row.id)).size, catalog.length);
  assert.ok(catalog.every((row) => row.evidence.excerpt.trim().length > 0));
  const inference = "去重可能减少重复处理。";
  const unknown = "上线后的实际收益仍未知。";
  const review = verifyProjectQuoteReview(catalog, {
    kind: "quote_review",
    facts: [first.id, second.id],
    inferences: [{ text: inference, basis: [first.id] }],
    unknowns: [unknown],
  });
  const claims = review.reply.understanding.claims;
  const code = claims.find((claim) => claim.kind === "source")!;
  const doc = claims.find((claim) => claim.kind === "documentation")!;
  const inferred = claims.find((claim) => claim.kind === "inference")!;
  const uncertain = claims.find((claim) => claim.kind === "unknown")!;
  assert.ok(code.text.includes(codeLine) && doc.text.includes(replayLine));
  assert.deepEqual(code.evidenceIds, [first.evidence.id]);
  assert.deepEqual(doc.evidenceIds, [second.evidence.id]);
  assert.deepEqual(inferred.evidenceIds, [first.evidence.id]);
  assert.equal(inferred.text, inference);
  assert.deepEqual(uncertain.evidenceIds, []);
  assert.equal(uncertain.text, unknown);
  assert.ok(!JSON.stringify(review).includes(sideLine));
  for (const [receipt, full, line, expectedLine] of [
    [first.evidence, codeFile, codeLine, 2],
    [second.evidence, replayFile, replayLine, 4],
  ] as const) {
    assert.ok(review.evidence.some((evidence) => evidence.id === receipt.id));
    assert.equal(receipt.hash, digest(full));
    assert.equal(receipt.startLine, expectedLine);
    assert.equal(receipt.endLine, expectedLine);
    assert.equal(receipt.startOffset, full.indexOf(line));
    assert.equal(receipt.endOffset, receipt.startOffset! + line.length);
    assert.equal(receipt.sourceLength, full.length);
    assert.deepEqual(
      Buffer.from(full.slice(receipt.startOffset, receipt.endOffset)),
      Buffer.from(receipt.excerpt),
    );
  }
});

test("a short selection handle resolves only against the catalog for this call", () => {
  const catalogFor = (line: string) => buildProjectQuoteCatalog([material("notes.md", line)], "项目记录");
  const previous = catalogFor("甲项目记录回放边界。");
  const current = catalogFor("乙项目记录入库凭据。");
  assert.equal(previous.length, 1);
  assert.equal(current.length, 1);
  assert.equal(previous[0]!.id, current[0]!.id);
  const review = verifyProjectQuoteReview(current, {
    kind: "quote_review",
    facts: [previous[0]!.id],
    inferences: [],
    unknowns: [],
  });
  assert.equal(review.evidence[0]!.hash, current[0]!.evidence.hash);
  assert.equal(review.evidence[0]!.excerpt, current[0]!.evidence.excerpt);
  assert.ok(!JSON.stringify(review).includes(previous[0]!.evidence.excerpt));
  assert.throws(() =>
    verifyProjectQuoteReview(current, {
      kind: "quote_review",
      facts: [previous[0]!.evidence.id],
      inferences: [],
      unknowns: [],
    }),
  );
});

test("quote review rejects missing or blank handles, unselected inference bases and empty answers", () => {
  const catalog = buildProjectQuoteCatalog(
    [material("one.md", "去重依据为请求编号。"), material("two.md", "回放使用 Redis。")],
    "去重 Redis 回放",
  );
  const [selected, unselected] = catalog;
  assert.ok(selected && unselected);
  const raw = { kind: "quote_review", facts: [selected.id], inferences: [], unknowns: [] };
  for (const facts of [["q9999"], ["  "], []]) {
    assert.throws(() => verifyProjectQuoteReview(catalog, { ...raw, facts }));
  }
  for (const basis of [["q9999"], [unselected.id], []]) {
    assert.throws(() =>
      verifyProjectQuoteReview(catalog, { ...raw, inferences: [{ text: "可能改善重试处理。", basis }] }),
    );
  }
  assert.throws(() => verifyProjectQuoteReview(catalog, { ...raw, facts: [], unknowns: ["  "] }));
  const noMaterials = verifyProjectQuoteReview([], {
    kind: "quote_review",
    facts: [],
    inferences: [],
    unknowns: ["上线量化收益未知。"],
  });
  assert.deepEqual(noMaterials.evidence, []);
  assert.deepEqual(
    noMaterials.reply.understanding.claims.map((c) => c.kind),
    ["unknown"],
  );
});

test("quotation mode requires an affirmative request for original wording", async () => {
  const { asksForProjectQuotes } = await import("../src/kernel/project-quote-review.ts");
  assert.ok(asksForProjectQuotes("请在记录中定位第二项工作的原句。"));
  assert.ok(asksForProjectQuotes("请引用项目材料。"));
  assert.ok(asksForProjectQuotes("Please quote the relevant lines."));
  assert.equal(asksForProjectQuotes("请保留原句，接着讨论其它边界。"),false);
  assert.equal(asksForProjectQuotes("无需提供原句，只解释架构。"),false);
});

test("explicitly requested low-ranked files survive the quote catalog limit; missing coverage is recorded", () => {
  const full = Array.from({length:36},(_,index)=>`缓存回放测试 Redis 重复请求 ${index}。`).join("\n");
  const records = [material("frequent.md",full),material("rare.md","仅在本地验证。")];
  const catalog = buildProjectQuoteCatalog(records,"缓存回放测试 Redis 重复请求",["frequent.md","rare.md"]);
  assert.equal(catalog.length,24);
  const rare = catalog.find(row=>row.evidence.path==="rare.md");
  assert.ok(rare);
  const result = verifyProjectQuoteReview(catalog,{
    kind:"quote_review", facts:[rare.id,rare.id],
    inferences:[{text:"测试范围可能仅限本地环境。",basis:[rare.id,rare.id]},{text:"测试范围可能仅限本地环境。",basis:[rare.id]}],
    unknowns:[],
  },["absent.md","absent.md"]);
  assert.deepEqual(result.evidence.map(row=>row.excerpt),["仅在本地验证。"]);
  assert.equal(result.reply.understanding.claims.filter(claim=>claim.kind==="inference").length,1);
  assert.equal(result.reply.understanding.unknowns.length,1);
  assert.match(result.reply.understanding.unknowns[0]!,/absent\.md/);
});
