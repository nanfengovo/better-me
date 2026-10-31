export type WorkingConditionClaim = {
  kind: "weekly-rest" | "hours-per-day" | "work-mode" | "overtime";
  value: string;
  quote: string;
  sourceUrl?: string;
  observedAt?: string;
  origin: "card-excerpt" | "job-text";
  verification: "source-stated";
};

/** Conservative literal claims only. No inference from employer names, 955 lists or missing fields. */
export function extractWorkingConditions(text: string, context: Pick<WorkingConditionClaim, "origin" | "sourceUrl" | "observedAt">): WorkingConditionClaim[] {
  const claims: WorkingConditionClaim[] = [];
  const add = (kind: WorkingConditionClaim["kind"], value: string, quote: string) => {
    if (!claims.some(claim => claim.kind === kind && claim.value === value)) claims.push({ ...context, kind, value, quote, verification: "source-stated" });
  };
  for (const raw of text.slice(0, 100_000).split(/[。；;\n，,]+/u)) {
    const quote = raw.trim();
    if (!quote || quote.length > 240) continue;
    // Do not turn negation, speculation, questions or a historical policy into a positive promise.
    if (/[?？]|不保证|不能保证|并非|不是|不提供|不支持|不实行|不居家|不远程|不能远程|无法远程|不能居家|无法居家|不混合|非全远程|不需要|无需值班|不值班|不轮班|不允许|取消|曾经|以前|可能|视情况|待确认|待核实|例如|举例|not\b|previously|may\b|might\b|no\s+(?:fully|100%|remote|hybrid|work from)/iu.test(quote)) continue;
    if (/双休|周末双休|weekends? off/iu.test(quote) && !/非双休|无双休|不双休/u.test(quote)) add("weekly-rest", "双休", quote);
    if (/大小周/u.test(quote)) add("weekly-rest", "大小周", quote);
    if (/单休/u.test(quote) && !/非单休|不单休/u.test(quote)) add("weekly-rest", "单休", quote);
    const hours = quote.match(/(?:每天|每日|日工作|日工时|工作日每天)\s*(\d{1,2}(?:\.\d+)?)\s*(?:个)?小时/u)
      ?? quote.match(/(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per|a|\/)\s*day/iu);
    if (hours && Number(hours[1]) > 0 && Number(hours[1]) <= 24) add("hours-per-day", `日工时${hours[1]}小时`, quote);
    if (/混合办公|hybrid (?:work|working)/iu.test(quote)) add("work-mode", "混合办公", quote);
    if (/全远程|完全远程|fully remote|100% remote/iu.test(quote)) add("work-mode", "全远程", quote);
    else if (/居家办公|可远程办公|work from home/iu.test(quote) && !/不可|不能|无法|非远程/u.test(quote)) add("work-mode", "可居家／远程", quote);
    if (/无需加班|无加班要求|不要求加班|不加班|no overtime/iu.test(quote)) add("overtime", "无加班要求", quote);
    else if (/需要加班|需加班|轮班|值班|on.call/iu.test(quote)) add("overtime", "加班／值班声明", quote);
  }
  return claims;
}
