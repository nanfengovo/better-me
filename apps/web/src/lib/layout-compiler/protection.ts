export type ProtectedTextKind = "number-unit" | "entity" | "negation" | "qualifier" | "attribution" | "evidence-reference";
export interface ProtectedTextSpan { text: string; kind: ProtectedTextKind }
export interface TextProtectionResult {
  accepted: boolean;
  violations: { kind: ProtectedTextKind | "ordering"; text: string; detail: string }[];
}

const automaticPatterns: { kind: ProtectedTextKind; expression: RegExp }[] = [
  { kind: "number-unit", expression: /[+-]?\d+(?:[.,]\d+)*(?:[ \t]*(?:[a-zA-Zµμ]+(?:\/[a-zA-Z]+)?|[%％]|(?:亿|万|千|百)?(?:人民币|美元|欧元|日元|港元|元|小时|分钟|毫秒|微秒|纳秒|公里|千米|厘米|毫米|字节|并发|年月日|年|月|日|天|周|秒|次|个|行|人|台|项|倍|页)|[亿万千百十]))?/gu },
  { kind: "number-unit", expression: /[零〇一二两三四五六七八九十百千万亿]+(?:余|多)?(?:小时|分钟|毫秒|年|月|日|天|周|秒|次|个|行|人|台|项|倍|级)/gu },
  { kind: "evidence-reference", expression: /\[[^\]\n]{1,160}\]\([^)\n]{1,512}\)|https?:\/\/[^\s<>]+|(?:fact|claim|receipt|evidence):[a-zA-Z0-9._:/#-]+/giu },
  { kind: "entity", expression: /`[^`\n]+`/gu },
  { kind: "negation", expression: /(?:尚未|并非|没有|不是|不能|不得|不曾|未曾|未|无|不)|\b(?:not|never|without|neither|no)\b/giu },
  { kind: "qualifier", expression: /(?:不超过|至少|至多|仅限|仅|只|大约|约|预计|可能|计划|待验证|尚待|部分|全部|独立|协同)|\b(?:only|approximately|about|estimated|planned|may|might|partially|up\s+to|at\s+least|at\s+most)\b/giu },
  { kind: "attribution", expression: /(?:主导|牵头|参与|协助|负责|设计|实现|维护|团队|本人|个人)|\b(?:led|lead|owned|assisted|contributed|designed|implemented|maintained|team|personally)\b/giu },
];

function occurrences(text: string, token: string): number[] {
  if (!token) return [];
  const starts: number[] = [];
  for (let index = text.indexOf(token); index !== -1; index = text.indexOf(token, index + token.length)) starts.push(index);
  return starts;
}

/**
 * Conservative lexical gate, not a semantic equivalence certificate. The caller
 * must also provide its authorized entity/reference inventory and an independent
 * semantic verifier. Passing this gate never authorizes adopting changed text.
 */
export function checkTextProtection(before: string, after: string, supplied: readonly ProtectedTextSpan[] = []): TextProtectionResult {
  const spans: ProtectedTextSpan[] = [...supplied];
  for (const pattern of automaticPatterns) {
    for (const match of before.matchAll(new RegExp(pattern.expression))) spans.push({ kind: pattern.kind, text: match[0] });
    // Added claims are as unsafe as removed claims: inspect both sides.
    for (const match of after.matchAll(new RegExp(pattern.expression))) spans.push({ kind: pattern.kind, text: match[0] });
  }
  const unique = [...new Map(spans.map(span => [`${span.kind}:${span.text}`, span])).values()];
  const violations: TextProtectionResult["violations"] = [];
  for (const span of unique) {
    if (!span.text || occurrences(before, span.text).length !== occurrences(after, span.text).length) {
      violations.push({ ...span, detail: "A protected number, unit, entity, negation, qualifier, attribution or evidence reference changed" });
    }
  }
  // Keep relative associations such as 'did not lead A; assisted B'. An inventory
  // containing A and B exposes rearranged negation/ownership even if token counts match.
  const sequence = (text: string) => unique.flatMap(span => occurrences(text, span.text).map(start => ({ ...span, start })))
    .sort((left, right) => left.start - right.start || right.text.length - left.text.length || left.kind.localeCompare(right.kind))
    .map(span => `${span.kind}:${span.text}`).join("\u0000");
  if (sequence(before) !== sequence(after)) violations.push({ kind: "ordering", text: "", detail: "Protected markers changed order or association" });
  return { accepted: violations.length === 0, violations };
}
