import { PrivacyError } from "./types.js";
import { textDigest } from "./content-guard.js";

export type JsonRepair = { kind: "bom" | "transport_fence" | "trailing_comma"; beforeHash: string; afterHash: string };
function stripTrailingCommas(value: string): string {
  let string = false, escaped = false, output = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (string) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') string = true;
    if (character === "," && /^[\s]*[}\]]/.test(value.slice(index + 1))) continue;
    output += character;
  }
  return output;
}

/** Only bounded transport/syntax repairs. Never invent missing braces, values,
 * citations or facts; no model retry and no single-quote/eval fallback. */
export function parseLocalJson(raw: string, options: { maxBytes?: number; maxRepairs?: number } = {}): { value: unknown; repairs: JsonRepair[]; inputHash: string } {
  const maxBytes = options.maxBytes ?? 64_000, maxRepairs = options.maxRepairs ?? 2;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000 || !Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) throw new PrivacyError("invalid_json_repair_budget");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > maxBytes) throw new PrivacyError("local_output_limit");
  const inputHash = textDigest(raw), repairs: JsonRepair[] = [];
  // String.trim() also removes BOM, which would silently hide a repair.
  let current = raw.replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, "");
  const parse = () => { try { return { ok: true as const, value: JSON.parse(current) as unknown }; } catch { return { ok: false as const }; } };
  let result = parse();
  if (result.ok) return { value: result.value, repairs, inputHash };
  const transforms: [JsonRepair["kind"], (value: string) => string][] = [
    ["bom", value => value.replace(/^\uFEFF/, "")],
    ["transport_fence", value => /^```(?:json)?\s*\n[\s\S]*\n```$/i.test(value) ? value.replace(/^```(?:json)?\s*\n/i, "").replace(/\n```$/, "").trim() : value],
    ["trailing_comma", stripTrailingCommas],
  ];
  for (const [kind, transform] of transforms) {
    const next = transform(current);
    if (next === current) continue;
    if (repairs.length >= maxRepairs) throw new PrivacyError("json_repair_budget_exhausted");
    repairs.push({ kind, beforeHash: textDigest(current), afterHash: textDigest(next) });
    current = next; result = parse();
    if (result.ok) return { value: result.value, repairs, inputHash };
  }
  throw new PrivacyError("invalid_local_json");
}
