// These checks reject recognizable unsupported claims; passing is not semantic verification.
// Each covered span must fit in ONE exact quote. Joining two clipped quotes
// must not manufacture a number, and a cropped verb cannot change its subject.
function coverage(text: string, quotes: readonly string[]): Uint32Array {
  const ends = new Uint32Array(text.length + 1);
  for (const quote of new Set(quotes.filter(Boolean))) {
    for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
      ends[start] = Math.max(ends[start]!, start + quote.length);
    }
  }
  for (let i = 1; i < ends.length; i++) ends[i] = Math.max(ends[i]!, ends[i - 1]!);
  return ends;
}

const unit = /%|(?:毫秒|秒钟?|分钟|小时|个月|年|天|周|倍|万台|万次|万人|万条|万笔|万|亿|次|台|人|条|笔|个|组|套)|(?:thousand|million|billion)s?\b(?:[ \t]+(?:requests?|users?|invoices?|orders?|records?|devices?)\b)?|(?:percent(?:age)?|milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|years?|yrs?|times|users?|people|devices?|requests?|invoices?|orders?|records?|servers?|projects?|qps|tps|[kmgt]i?b)\b/i;
const quantity = new RegExp(String.raw`((?:(?<![\w.])[+−-])?\d+(?:[.,]\d+)*)(?:[ \t]*(${unit.source}))?`, "giu");
const aliases: Record<string, string> = { percent: "%", percentage: "%", millisecond: "ms", 毫秒: "ms", sec: "second", 秒: "second", 秒钟: "second", min: "minute", 分钟: "minute", 小时: "hour", 天: "day", 周: "week", 个月: "month", 年: "year", yr: "year" };
function quantities(text: string) {
  return Array.from(text.matchAll(quantity), match => {
    const amount = match[1]!.replace(/−/g, "-").replace(/^([+-]?\d{1,3})((?:,\d{3})+)(?=\.|$)/, (_, leading: string, groups: string) => leading + groups.replace(/,/g, ""));
    const rawUnit = (match[2] ?? "").toLowerCase().replace(/\s+/g, " ");
    const singular = rawUnit.replace(/(milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|years?|yrs?|users?|devices?|requests?|invoices?|orders?|records?|servers?|projects?)\b/g, s => s.replace(/s$/, ""));
    return { index: match.index, end: match.index + match[0].length, key: amount + ":" + (aliases[singular] ?? singular) };
  });
}

export function hasUncitedWritingNumber(draft: string, sources: readonly string[], quotes: readonly string[]): boolean {
  const requested = quantities(draft.normalize("NFKC"));
  if (!requested.length) return false;
  const cited = new Set<string>();
  for (const source of sources) {
    const normalized = source.normalize("NFKC");
    const ends = coverage(normalized, quotes.filter(q => source.includes(q)).map(q => q.normalize("NFKC")));
    for (const token of quantities(normalized)) if (ends[token.index]! >= token.end) cited.add(token.key);
  }
  return requested.some(token => !cited.has(token.key));
}

const release = /上线|投产|投用|投入(?:生产|使用)|\b(?:launched|went live|gone live|deployed to production|in production)\b/gi;
const stages = [
  /主导|牵头|带领|\b(?:led|lead|spearheaded)\b/gi,
  /独立(?:完成|开发|实现)|\b(?:single[- ]handedly|independently)\b/gi,
  release,
];
const implementation = [/实现|交付|部署|\b(?:implemented|delivered|deployed)\b/gi, release];
const uncertainBefore = /是否|能否|未声明|未确认|无法确认|不能确认|不确定|尚不清楚|计划|拟于|预计|有待|尚待|\b(?:whether|may|might|planned|proposed|pending|unknown|unconfirmed|not confirmed)\b/i;
const uncertainAfter = /^(?:[\s的]|状态|情况|时间|与否)*(?:未知|待定|待确认|尚待确认|不确定|未确认|不清楚|尚不清楚|方案|计划|前检查)|^\s*(?:(?:status|date|is|was|remains|still)\s+)*(?:unknown|pending|unconfirmed|unclear)\b/i;
const negativeBefore = /尚未|并未|未曾|没有|不是|并非|未(?:能|负责|参与)?(?:实际|正式|亲自)?$|\b(?:not|never|didn't|wasn't|hasn't|haven't)\b/i;
const owners = /团队|小组|同事|客户|供应商|我们|本人|我|\b(?:team|we|they|colleagues?|customers?|vendor|i)\b/gi;
const predicateJoin = /并且|并(?!未|非|不|无)|同时|\band\b/i;
const clauseBreak = /[。！？!?；;，,.\n]+|但是|然而|不过|但|\b(?:but|however)\b/gi;

function mentions(text: string, patterns: readonly RegExp[]) {
  const found: { group: number; start: number; end: number; polarity: "positive" | "negative" | "unknown"; otherOwner: boolean }[] = [];
  let start = 0;
  const visit = (end: number) => {
    const clause = text.slice(start, end);
    patterns.forEach((pattern, group) => {
      for (const match of clause.matchAll(pattern)) {
        const prefix = clause.slice(0, match.index);
        // “按计划上线” reports a release; “计划上线” only forecasts one.
        const local = (prefix.split(predicateJoin).at(-1) ?? prefix).replace(/按(?:照)?(?:原定|原|既定)?计划/gu, "");
        const suffix = clause.slice(match.index + match[0].length);
        const owner = Array.from(prefix.matchAll(owners)).at(-1)?.[0]?.toLowerCase();
        const polarity = uncertainBefore.test(local) || uncertainAfter.test(suffix) ? "unknown" : negativeBefore.test(local) ? "negative" : "positive";
        found.push({ group, start: start + match.index, end: start + match.index + match[0].length, polarity, otherOwner: Boolean(owner && !["本人", "我", "i"].includes(owner)) });
      }
    });
  };
  for (const separator of text.matchAll(clauseBreak)) { visit(separator.index); start = separator.index + separator[0].length; }
  visit(text.length);
  return found;
}

export function claimsWritingImplementation(draft: string): boolean {
  return mentions(draft, implementation).some(m => m.polarity === "positive");
}

export function hasUnbackedWritingScope(draft: string, sources: readonly string[], quotes: readonly string[]): boolean {
  const requested = mentions(draft, stages).filter(m => m.polarity !== "unknown");
  if (!requested.length) return false;
  const supported = sources.flatMap(source => {
    const ends = coverage(source, quotes);
    return mentions(source, stages).filter(m => ends[m.start]! >= m.end);
  });
  return requested.some(d => !supported.some(s => s.group === d.group && s.polarity === d.polarity && s.otherOwner === d.otherOwner));
}
