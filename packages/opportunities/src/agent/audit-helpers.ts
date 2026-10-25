/**
 * audit-helpers.ts — Pure address-normalisation helpers for the job audit workflow.
 *
 * These functions have no side-effects and no external dependencies.
 * They are used by the job-audit graph nodes in apps/agent-host.
 */

/**
 * Evaluator-Optimizer helper: strips decorative suffixes (e.g. industrial parks,
 * towers, rooms) while preserving the road and house number.
 */
export function stripAddressDecorations(raw: string): string {
  let text = raw.trim();
  // Strip brackets: (A座), （3号楼）
  text = text.replace(/[\(（][^\)）]*[\)）]/g, " ").trim();
  // Strip room/floor suffixes: 301室, 5层, 12楼, A座, 1号楼, etc.
  text = text.replace(/\s*\d+[-号]?[楼层室栋座]/g, " ").trim();
  text = text.replace(/\s*[A-Za-z0-9]+[座栋单元]/g, " ").trim();
  // Strip park/building suffixes if road+number is present
  const roadMatch = text.match(/([^\d\s,，]{2,15}[路街道巷弄道]\s*\d+[-至到]?\d*号?)/);
  if (roadMatch) {
    return roadMatch[1]!.trim();
  }
  return text;
}

/**
 * Evaluator-Optimizer helper: strips duplicate locality / province from query.
 */
export function stripDuplicateLocality(query: string, locality?: string): string {
  if (!locality) return query;
  const loc = locality.replace(/市|省|区/g, "").trim();
  if (loc && query.startsWith(loc)) {
    return query.replace(new RegExp(`^${loc}[市省区]?`), "").trim();
  }
  return query;
}

/**
 * Compute geocoding confidence from a building candidate.
 * Returns 0–1; ≥ 0.95 is considered high-confidence for auto-confirm.
 */
export function computeGeoConfidence(candidate: {
  proposal?: {
    streetAddress?: string;
    formattedAddress?: string;
    coordinateMeaning?: string;
  };
}): number {
  const hasRoadNumber = /\d+号?/.test(
    candidate.proposal?.streetAddress ?? candidate.proposal?.formattedAddress ?? ""
  );
  const isBuildingLevel =
    candidate.proposal?.coordinateMeaning === "building" ||
    candidate.proposal?.coordinateMeaning === "site";
  return isBuildingLevel && hasRoadNumber ? 0.98 : isBuildingLevel ? 0.85 : 0.60;
}
