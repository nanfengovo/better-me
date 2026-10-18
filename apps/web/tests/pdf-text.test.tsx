import assert from "node:assert/strict";
import test from "node:test";
import { reflowPdfText, type PdfTextItem } from "../src/lib/pdf-text.ts";

function item(str: string, x: number, y: number, width: number, height = 10): PdfTextItem {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

test("PDF adjacent Chinese headings, date fragments and English ligatures do not gain spaces", () => {
  const text = reflowPdfText([
    item("教育", 40, 700, 28, 14), item("背景", 68.02, 700, 28, 14),
    item("20", 40, 675, 17.3, 14), item("21", 57.28, 675, 17.3, 14), item(".09", 74.6, 675, 18, 14),
    item("Agent Work", 40, 650, 55), item("fl", 95, 650, 6), item("ow", 101, 650, 12),
  ]);
  assert.equal(text, "教育背景\n2021.09\nAgent Workflow");
});

test("PDF visible gaps and explicit whitespace still separate words and contact fields", () => {
  assert.equal(reflowPdfText([
    item("SQL", 40, 700, 18), item("Server", 61, 700, 30),
    item("电话：", 40, 675, 30), item("10000000000", 90, 675, 65),
    item("Hello", 40, 650, 25), item(" ", 65, 650, 0, 0), item("world", 65, 650, 25),
  ]), "SQL Server\n电话： 10000000000\nHello world");
});

test("PDF small baseline drift groups a company, role and date in one row", () => {
  assert.equal(reflowPdfText([
    item("示例单位", 24, 390, 60, 12),
    item("开发工程师", 138, 390, 50, 9.75),
    item("2023.01-至今", 490, 390.75, 70, 9.75),
  ]), "示例单位 开发工程师 2023.01-至今");
});

test("PDF distinct nearby baselines do not merge or interleave text", () => {
  assert.equal(reflowPdfText([
    item("上行右侧", 200, 700, 40), item("下行左侧", 40, 694, 40), item("上行左侧", 40, 700, 40),
  ]), "上行左侧 上行右侧\n下行左侧");
});

test("PDF overlaid section headings remain separate and retain source order", () => {
  assert.equal(reflowPdfText([
    item("•", 61, 314, 4, 10), item("技能末条", 79, 314, 150, 12),
    item("工作经历", 43, 316.28, 56, 14),
    item("下一段", 50, 290, 50, 12),
  ]), "• 技能末条\n工作经历\n下一段");
});

test("PDF persistent columns read the whole sidebar before the right body", () => {
  const items: PdfTextItem[] = [];
  for (let row = 0; row < 10; row++) {
    items.push(item(`正文${row}`, 235, 800 - row * 20, 320));
    items.push(item(`侧栏${row}`, 35, 700 - row * 20, 180));
  }
  const text = reflowPdfText(items);
  assert.equal(text, [
    Array.from({ length: 10 }, (_, row) => `侧栏${row}`).join("\n"),
    Array.from({ length: 10 }, (_, row) => `正文${row}`).join("\n"),
  ].join("\n\n"));
  assert.equal(text.replace(/\s/gu, "").length, items.map((entry) => entry.str).join("").length);
});

test("PDF contact columns above a full-width body do not split the whole page", () => {
  const items: PdfTextItem[] = [
    item("姓名：示例", 40, 800, 100), item("城市：示例市", 260, 800, 110),
    item("电话：10000000000", 40, 780, 150), item("学历：本科", 260, 780, 100),
    ...Array.from({ length: 12 }, (_, row) => item(`完整正文${row}`, 40, 740 - row * 20, 500)),
  ];
  assert.equal(reflowPdfText(items), [
    "姓名：示例 城市：示例市", "电话：10000000000 学历：本科",
    ...Array.from({ length: 12 }, (_, row) => `完整正文${row}`),
  ].join("\n"));
});

test("PDF punctuation kerning, original text and empty pages preserve content", () => {
  const items = [item("框架", 40, 700, 24, 12), item("（", 60, 700, 12, 12), item("OOP", 72, 700, 22, 12), item("）", 94, 700, 12, 12)];
  assert.equal(reflowPdfText(items), "框架（OOP）");
  assert.equal(reflowPdfText([]), "");
  assert.equal(reflowPdfText([{ str: "", hasEOL: true }, { str: "  " }]), "");
});
