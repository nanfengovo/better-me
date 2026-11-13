import { createHash } from "node:crypto";
import type { PrivacySource } from "./types.js";

export const privacyDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const textDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const privacySourceSnapshotHash = (sources: readonly PrivacySource[]): string => privacyDigest(sources.map(source => ({
  id: source.id, revision: source.revision, classification: source.classification, kind: source.kind, hash: textDigest(source.text),
})).sort((a, b) => a.id.localeCompare(b.id)));

const secret = /-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret|connection[_-]?strings?)["']?\s*[=:]\s*(?:["'][^"'\n]+["']|[^\s;,}"']+)|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s/@]+@|\b(?:ghp_|github_pat_|AKIA)[A-Za-z0-9_]{12,}/i;
// All filesystem-like absolute paths are private by default, not merely /Users.
// URL paths are not preceded by these delimiters and are handled by consent.
const privatePath = /(?:^|[\s"'`(=:])(?:\/(?!\/)[A-Za-z0-9_.-]+(?:\/[^\s"'`<>]*)?|[A-Za-z]:[\\/][^\s"'`<>]*|\\\\[^\s\\]+\\[^\s]*)/i;
const rawDiff = /(?:^|\n)(?:diff --git |@@\s+-\d|\+\+\+\s|---\s|[+-](?:import|export|const|let|function|class)\s)/;
const rawCode = /(?:^|\n)\s*(?:(?:import|export)\s+(?:\{|\*|default|const|class|function)|(?:const|let|var)\s+[\w$]+\s*=|(?:async\s+)?function\s*[\w$]*\s*\(|class\s+\w+\s*(?:extends[^\n]+)?\{|(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],?]+\s+\w+\s*\([^\n]*\)\s*\{)|=>\s*\{|```(?:[a-z]+)?/i;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phone = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;

/** Conservative screening plus exact preview approval; not a complete DLP proof. */
export function disclosureViolations(text: string): string[] {
  return [secret.test(text) && "credential", privatePath.test(text) && "private_path", rawDiff.test(text) && "raw_diff", rawCode.test(text) && "raw_code"]
    .filter((value): value is string => typeof value === "string");
}

export function redactDisclosureText(text: string, privateTerms: readonly string[]): { text: string; redactions: { category: string; count: number }[] } {
  const counts = new Map<string, number>();
  const add = (category: string) => counts.set(category, (counts.get(category) ?? 0) + 1);
  let result = text.replace(email, () => { add("email"); return "[REDACTED_EMAIL]"; })
    .replace(phone, () => { add("phone"); return "[REDACTED_PHONE]"; });
  for (const term of [...privateTerms].sort((a, b) => b.length - a.length)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), () => { add("private_term"); return "[REDACTED_PRIVATE]"; });
  }
  return { text: result, redactions: [...counts].map(([category, count]) => ({ category, count })) };
}

/** Known local-only source lines are an additional canary check, not a semantic
 * non-interference claim. They are never included in a cloud prompt or audit. */
export function containsLocalOnlyExcerpt(text: string, sources: readonly PrivacySource[]): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  return sources.filter(source => source.classification === "local_only").some(source =>
    source.text.split(/\r?\n/).map(line => line.trim().toLowerCase().replace(/\s+/g, " ")).some(line => line.length >= 12 && normalized.includes(line)));
}
