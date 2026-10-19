import { z } from "zod";
import { allowedJobUrl } from "../src/lib/jd-source";
import { PlatformVisibleOfficeDisclosureSchema, type PlatformVisibleOfficeDisclosure } from "@better-me/source-adapters/platform-detail-locations";
import { reviewedCardIdentity } from "@better-me/source-adapters/platform-job-identity";

/** Fixed count-only diagnostics. These describe parser roots, never job totals. */
export const SearchProjectionDiagnosticsSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["51JOB", "BOSS直聘", "猎聘", "LinkedIn"]),
  rawRoots: z.number().int().min(0).max(25_000),
  hiddenRoots: z.number().int().min(0).max(25_000),
  excludedRoots: z.number().int().min(0).max(25_000),
  incompleteRoots: z.number().int().min(0).max(25_000),
  otherRemovedRoots: z.number().int().min(0).max(25_000),
  projectedRoots: z.number().int().min(0).max(25_000),
  projectedRootsWithText: z.number().int().min(0).max(25_000),
}).strict().refine(value => value.rawRoots === value.hiddenRoots + value.excludedRoots + value.incompleteRoots + value.otherRemovedRoots + value.projectedRoots
  && value.projectedRootsWithText <= value.projectedRoots, "inconsistent-search-root-counts");
export type SearchProjectionDiagnostics = z.infer<typeof SearchProjectionDiagnosticsSchema>;

export type BrowserSnapshot = {
  html: string;
  url: string;
  title: string;
  oversized?: boolean;
  gate?: "login_required" | "verification_required";
  searchDiagnostics?: SearchProjectionDiagnostics;
  /** A separate native-visible disclosure; it never becomes part of the JD HTML. */
  visibleOfficeDisclosures?: PlatformVisibleOfficeDisclosure[];
  pageLoad?: {
    readyState: "loading" | "interactive" | "complete" | "unknown";
    content: "empty" | "visible_text" | "embedded_content" | "unknown";
    visibleFrames: number;
  };
};
export type SnapshotPosition = { url: string; navigation: number };
export type BrowserSnapshotValidation = {
  state: "ready" | "navigation_in_progress" | "failed" | "oversized";
  snapshot?: BrowserSnapshot;
};

/** The page can affect main-world evaluation. Accept neither its URL nor its HTML until the browser agrees. */
export function validateBrowserSnapshot(value: unknown, before: SnapshotPosition, after: SnapshotPosition): BrowserSnapshotValidation {
  if (before.url !== after.url || before.navigation !== after.navigation) return { state: "navigation_in_progress" };
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "failed" };
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.html !== "string" || typeof snapshot.url !== "string" || typeof snapshot.title !== "string"
      || snapshot.url !== before.url || !before.url
      || (snapshot.oversized !== undefined && typeof snapshot.oversized !== "boolean")
      || (snapshot.gate !== undefined && snapshot.gate !== "login_required" && snapshot.gate !== "verification_required")) return { state: "failed" };
    let pageLoad: BrowserSnapshot["pageLoad"];
    if (snapshot.pageLoad !== undefined) {
      if (!snapshot.pageLoad || typeof snapshot.pageLoad !== "object" || Array.isArray(snapshot.pageLoad)) return { state: "failed" };
      const load = snapshot.pageLoad as Record<string, unknown>;
      if (!["loading", "interactive", "complete", "unknown"].includes(load.readyState as string)
        || !["empty", "visible_text", "embedded_content", "unknown"].includes(load.content as string)
        || !Number.isInteger(load.visibleFrames) || (load.visibleFrames as number) < 0 || (load.visibleFrames as number) > 1000) return { state: "failed" };
      pageLoad = { readyState: load.readyState as NonNullable<BrowserSnapshot["pageLoad"]>["readyState"], content: load.content as NonNullable<BrowserSnapshot["pageLoad"]>["content"], visibleFrames: load.visibleFrames as number };
    }
    let searchDiagnostics: SearchProjectionDiagnostics | undefined;
    if (snapshot.searchDiagnostics !== undefined) {
      const diagnostic = SearchProjectionDiagnosticsSchema.safeParse(snapshot.searchDiagnostics);
      if (!diagnostic.success || allowedJobUrl(snapshot.url).platform !== diagnostic.data.platform) return { state: "failed" };
      searchDiagnostics = diagnostic.data;
    }
    let visibleOfficeDisclosures: PlatformVisibleOfficeDisclosure[] | undefined;
    if (snapshot.visibleOfficeDisclosures !== undefined) {
      const disclosure = z.array(PlatformVisibleOfficeDisclosureSchema).max(20).safeParse(snapshot.visibleOfficeDisclosures);
      if (!disclosure.success || !reviewedCardIdentity(snapshot.url, "liepin") || snapshot.gate !== undefined) return { state: "failed" };
      visibleOfficeDisclosures = disclosure.data;
    }
    if (snapshot.oversized || Buffer.byteLength(snapshot.html, "utf8") > 2 * 1024 * 1024) return { state: "oversized" };
    return {
      state: "ready",
      snapshot: {
        html: snapshot.html, url: snapshot.url, title: snapshot.title,
        ...(snapshot.oversized !== undefined ? { oversized: snapshot.oversized } : {}),
        ...(snapshot.gate !== undefined ? { gate: snapshot.gate } : {}),
        ...(pageLoad ? { pageLoad } : {}),
        ...(searchDiagnostics ? { searchDiagnostics } : {}),
        ...(visibleOfficeDisclosures ? { visibleOfficeDisclosures } : {}),
      },
    };
  } catch { return { state: "failed" }; }
}
