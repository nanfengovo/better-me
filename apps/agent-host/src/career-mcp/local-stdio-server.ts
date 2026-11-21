import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  alignJdWithResume,
  checkRewriteFactPreservation,
  createDefaultResumeView,
  decomposeJdText,
  projectResume,
  safeParseFactBase,
  type FactBase,
  type LocalizedString,
} from "@better-me/core";

export interface LocalCareerMcpOptions {
  /** Path to a BetterMe JSON backup (`BetterMeDocument`) or standalone `FactBase` JSON file. */
  resumeFilePath?: string;
  /** Path to an exported BetterMe Opportunity Library JSON file. */
  opportunitiesFilePath?: string;
  /** Optional directory where `save_tailored_draft` stores reviewed drafts (never mutates master files). */
  draftsDir?: string;
  /** Keep contact PII (`email`, `phone`, `links`) redacted by default, matching Dossier's connector safety. */
  includeContact?: boolean;
  /** Optional in-memory loaders for testing without touching disk. */
  loadFactBase?: () => Promise<FactBase | null>;
  loadOpportunities?: () => Promise<LocalOpportunityRecord[]>;
}

export interface LocalOpportunityRecord {
  id: string;
  company: string;
  title: string;
  description?: string;
  market?: string;
  workMode?: string;
  status?: string;
  salaryText?: string;
  sourceUrl?: string;
  applicationUrl?: string;
  sourcePlatform?: string;
  location?: { country?: string; region?: string; city?: string };
  application?: { stage?: string; submittedAt?: string; nextAction?: string };
}

function localizedText(value: LocalizedString | undefined, locale: "zh" | "en"): string {
  if (!value) return "";
  return locale === "en" ? value.en?.trim() || value.zh : value.zh || value.en?.trim() || "";
}

async function readFactBaseFromDisk(filePath?: string): Promise<FactBase | null> {
  if (!filePath) return null;
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const candidate =
    parsed && typeof parsed === "object" && "factBase" in parsed
      ? (parsed as { factBase: unknown }).factBase
      : parsed;
  const validated = safeParseFactBase(candidate);
  if (!validated.success) {
    throw new Error(`Invalid BetterMe FactBase JSON at ${path.basename(filePath)}: ${validated.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return validated.data;
}

async function readOpportunitiesFromDisk(filePath?: string): Promise<LocalOpportunityRecord[]> {
  if (!filePath) return [];
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown[] }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : [];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "unknown",
      company: typeof row.company === "string" ? row.company : "",
      title: typeof row.title === "string" ? row.title : "",
      description: typeof row.description === "string" ? row.description : undefined,
      market: typeof row.market === "string" ? row.market : undefined,
      workMode: typeof row.workMode === "string" ? row.workMode : undefined,
      status: typeof row.status === "string" ? row.status : undefined,
      salaryText: typeof row.salaryText === "string" ? row.salaryText : undefined,
      sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : undefined,
      applicationUrl: typeof row.applicationUrl === "string" ? row.applicationUrl : undefined,
      sourcePlatform: typeof row.sourcePlatform === "string" ? row.sourcePlatform : undefined,
      location:
        row.location && typeof row.location === "object"
          ? {
              country: typeof (row.location as Record<string, unknown>).country === "string" ? ((row.location as Record<string, unknown>).country as string) : undefined,
              region: typeof (row.location as Record<string, unknown>).region === "string" ? ((row.location as Record<string, unknown>).region as string) : undefined,
              city: typeof (row.location as Record<string, unknown>).city === "string" ? ((row.location as Record<string, unknown>).city as string) : undefined,
            }
          : undefined,
      application:
        row.application && typeof row.application === "object"
          ? {
              stage: typeof (row.application as Record<string, unknown>).stage === "string" ? ((row.application as Record<string, unknown>).stage as string) : undefined,
              submittedAt: typeof (row.application as Record<string, unknown>).submittedAt === "string" ? ((row.application as Record<string, unknown>).submittedAt as string) : undefined,
              nextAction: typeof (row.application as Record<string, unknown>).nextAction === "string" ? ((row.application as Record<string, unknown>).nextAction as string) : undefined,
            }
          : undefined,
    }));
}

function sanitizeOpportunity(job: LocalOpportunityRecord, includeDescription: boolean) {
  const place = [job.location?.country, job.location?.region, job.location?.city].filter(Boolean).join(" · ") || undefined;
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    stage: job.application?.stage ?? "saved",
    market: job.market ?? "unknown",
    workMode: job.workMode ?? "unknown",
    status: job.status ?? "unknown",
    location: place,
    salary: job.salaryText || undefined,
    sourcePlatform: job.sourcePlatform || undefined,
    url: job.applicationUrl || job.sourceUrl || undefined,
    nextAction: job.application?.nextAction || undefined,
    ...(includeDescription && job.description ? { description: job.description.slice(0, 4000) } : {}),
  };
}

function buildFactBaseSummary(factBase: FactBase, locale: "zh" | "en", includeContact: boolean) {
  const skills = [...new Set(factBase.experiences.flatMap((exp) => exp.techStack))];
  return {
    updatedAt: factBase.updatedAt,
    locale,
    privacy: {
      contactRedacted: !includeContact,
      zeroFabricationRule: "Only cite verified claims from this FactBase; unverified metrics are excluded and missing requirements must be reported as gaps.",
    },
    profile: {
      displayName: includeContact ? localizedText(factBase.profile.displayName, locale) : "[redacted]",
      headline: localizedText(factBase.profile.headline, locale) || undefined,
      yearsOfExperience: factBase.profile.yearsOfExperience,
      education: localizedText(factBase.profile.education, locale) || undefined,
      location: localizedText(factBase.profile.location, locale) || undefined,
      targetRoles: factBase.profile.targetRoles.map((role) => localizedText(role, locale)).filter(Boolean),
      traits: factBase.profile.traits,
      ...(includeContact
        ? {
            email: factBase.profile.email,
            phone: factBase.profile.phone,
            links: factBase.profile.links,
          }
        : {}),
    },
    skills,
    experiences: factBase.experiences.map((exp) => ({
      id: exp.id,
      type: exp.type,
      org: localizedText(exp.org, locale),
      title: localizedText(exp.title, locale),
      start: exp.start,
      end: exp.end ?? "present",
      techStack: exp.techStack,
      claimCount: exp.claims.length,
      verifiedMetricCount: exp.claims.filter((c) => c.metric?.confirmed === true).length,
    })),
  };
}

const textResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
});

const errorResult = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/**
 * Local stdio MCP Server for Claude Desktop, Cursor, and Antigravity.
 *
 * Security & privacy invariants (aligned with BetterMe & Dossier):
 * - 100% local, zero outbound network, zero shell execution.
 * - Redacts personal contact details (`email`, `phone`, `avatarUrl`, private notes) by default.
 * - Never mutates the master FactBase or Opportunity Library; `save_tailored_draft` writes
 *   isolated draft JSON files with an automatic `_novel_numbers` fact-preservation audit.
 * - Never sends applications or emails.
 */
export function createLocalCareerMcpServer(options: LocalCareerMcpOptions = {}): McpServer {
  const includeContact = Boolean(options.includeContact);
  const loadFactBase = options.loadFactBase ?? (() => readFactBaseFromDisk(options.resumeFilePath));
  const loadOpportunities = options.loadOpportunities ?? (() => readOpportunitiesFromDisk(options.opportunitiesFilePath));

  const server = new McpServer(
    { name: "betterme-local-mcp", version: "1.3.0" },
    { enforceStrictCapabilities: true },
  );

  // ── 1. get_fact_base_summary ──
  server.registerTool(
    "get_fact_base_summary",
    {
      description:
        "Read an anonymized summary of the user's BetterMe FactBase (headline, target roles, skills, and experience overview). Contact PII is redacted by default.",
      inputSchema: z.object({
        locale: z.enum(["zh", "en"]).default("zh"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ locale }) => {
      try {
        const factBase = await loadFactBase();
        if (!factBase) {
          return errorResult("No BetterMe resume JSON configured. Export a JSON backup in BetterMe and pass --resume <path> or BETTERME_RESUME_FILE.");
        }
        return textResult(buildFactBaseSummary(factBase, locale, includeContact));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to read FactBase.");
      }
    },
  );

  // ── 2. list_verified_claims ──
  server.registerTool(
    "list_verified_claims",
    {
      description:
        "List structured experience claims from the user's FactBase. Unconfirmed metrics are never surfaced as verified metrics.",
      inputSchema: z.object({
        locale: z.enum(["zh", "en"]).default("zh"),
        experienceId: z.string().max(160).optional(),
        query: z.string().max(200).optional(),
        verifiedMetricsOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(40),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ locale, experienceId, query, verifiedMetricsOnly, limit }) => {
      try {
        const factBase = await loadFactBase();
        if (!factBase) return errorResult("No BetterMe resume JSON configured.");

        const q = query?.trim().toLowerCase();
        const items = factBase.experiences
          .filter((exp) => !experienceId || exp.id === experienceId)
          .flatMap((exp) =>
            exp.claims
              .filter((claim) => !verifiedMetricsOnly || claim.metric?.confirmed === true)
              .map((claim) => {
                const text = localizedText(claim.text, locale);
                return {
                  experienceId: exp.id,
                  org: localizedText(exp.org, locale),
                  title: localizedText(exp.title, locale),
                  period: `${exp.start} ~ ${exp.end ?? "present"}`,
                  claimId: claim.id,
                  kind: claim.kind,
                  text,
                  tags: claim.tags,
                  metric: claim.metric?.confirmed
                    ? {
                        value: claim.metric.value,
                        unit: claim.metric.unit,
                        baseline: claim.metric.baseline,
                        causal: claim.metric.causal,
                        confirmed: true,
                      }
                    : claim.metric
                      ? { confirmed: false, note: "Unverified metric withheld by zero-fabrication guard." }
                      : undefined,
                };
              }),
          )
          .filter((row) => {
            if (!q) return true;
            const hay = `${row.org} ${row.title} ${row.text} ${row.tags.join(" ")}`.toLowerCase();
            return hay.includes(q);
          });

        return textResult({
          total: items.length,
          returned: Math.min(items.length, limit),
          claims: items.slice(0, limit),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list claims.");
      }
    },
  );

  // ── 3. list_opportunities ──
  server.registerTool(
    "list_opportunities",
    {
      description:
        "List saved opportunities from the user's local BetterMe Opportunity Library (redacting private notes and personal contacts).",
      inputSchema: z.object({
        stage: z.string().max(40).optional(),
        market: z.enum(["all", "domestic", "overseas", "unknown"]).default("all"),
        search: z.string().max(200).optional(),
        includeDescription: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(20),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ stage, market, search, includeDescription, limit }) => {
      try {
        const jobs = await loadOpportunities();
        const q = search?.trim().toLowerCase();
        const filtered = jobs.filter((job) => {
          if (stage && (job.application?.stage ?? "saved") !== stage) return false;
          if (market !== "all" && (job.market ?? "unknown") !== market) return false;
          if (q) {
            const hay = `${job.company} ${job.title} ${job.description ?? ""} ${job.location?.city ?? ""}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        return textResult({
          total: filtered.length,
          returned: Math.min(filtered.length, limit),
          opportunities: filtered.slice(0, limit).map((job) => sanitizeOpportunity(job, includeDescription)),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to read opportunities.");
      }
    },
  );

  // ── 4. check_rewrite_grounding ──
  server.registerTool(
    "check_rewrite_grounding",
    {
      description:
        "Run BetterMe's deterministic Rewrite Fact-Preservation Guard (_novel_numbers) on a candidate resume bullet to detect fabricated metrics or numbers absent from the original source.",
      inputSchema: z.object({
        sourceText: z.string().min(1).max(8000),
        candidateText: z.string().min(1).max(8000),
        additionalFactTexts: z.array(z.string().max(4000)).max(20).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ sourceText, candidateText, additionalFactTexts }) => {
      const report = checkRewriteFactPreservation({ sourceText, candidateText, additionalFactTexts });
      return textResult(report);
    },
  );

  // ── 5. score_resume_against_jd ──
  server.registerTool(
    "score_resume_against_jd",
    {
      description:
        "Deterministically align a target job description against the user's verified BetterMe FactBase. Reports grounded strengths and honest requirement gaps without fabricating skills.",
      inputSchema: z.object({
        jdText: z.string().min(20).max(24000),
        title: z.string().max(200).optional(),
        company: z.string().max(200).optional(),
        locale: z.enum(["zh", "en"]).default("zh"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ jdText, title, company, locale }) => {
      try {
        const factBase = await loadFactBase();
        if (!factBase) return errorResult("No BetterMe resume JSON configured.");
        const view = { ...createDefaultResumeView(factBase), locale };
        const projected = projectResume(factBase, view);
        const decomposed = decomposeJdText(jdText, { title, company });
        const alignment = alignJdWithResume(decomposed, projected);

        return textResult({
          role: { title: title || decomposed.title || undefined, company: company || decomposed.company || undefined },
          readinessNote: "Deterministic alignment against verified FactBase claims only; missing skills remain honest gaps.",
          alignment,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to align JD with FactBase.");
      }
    },
  );

  // ── 6. save_tailored_draft ──
  server.registerTool(
    "save_tailored_draft",
    {
      description:
        "Save a tailored resume draft to the isolated drafts directory for human review in BetterMe. Never mutates the master FactBase, never sends applications, and runs the _novel_numbers fact-preservation guard on every bullet.",
      inputSchema: z.object({
        targetCompany: z.string().min(1).max(160),
        targetRole: z.string().min(1).max(200),
        summary: z.string().max(4000).optional(),
        bullets: z.array(z.object({
          sourceClaimId: z.string().max(160).optional(),
          sourceText: z.string().min(1).max(4000),
          proposedText: z.string().min(1).max(4000),
        }).strict()).min(1).max(60),
        gaps: z.array(z.string().max(500)).max(30).default([]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ targetCompany, targetRole, summary, bullets, gaps }) => {
      if (!options.draftsDir) {
        return errorResult("Draft saving is disabled because no drafts directory was configured. Pass --drafts-dir <dir> or BETTERME_DRAFTS_DIR to enable isolated draft output.");
      }
      try {
        const auditedBullets = bullets.map((item) => ({
          ...item,
          grounding: checkRewriteFactPreservation({
            sourceText: item.sourceText,
            candidateText: item.proposedText,
          }),
        }));
        const flaggedCount = auditedBullets.filter((b) => !b.grounding.ok).length;

        const safeSlug = `${targetCompany}-${targetRole}`
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64) || "draft";
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `draft-${safeSlug}-${timestamp}.json`;
        const resolvedDir = path.resolve(options.draftsDir);
        const fullPath = path.join(resolvedDir, fileName);
        if (!fullPath.startsWith(resolvedDir + path.sep)) {
          return errorResult("Refused to write outside configured drafts directory.");
        }

        await mkdir(resolvedDir, { recursive: true });
        const draftPayload = {
          schema: "betterme-tailored-draft/v1",
          status: "pending_human_review",
          createdAt: new Date().toISOString(),
          targetCompany,
          targetRole,
          summary,
          bullets: auditedBullets,
          gaps,
          factPreservation: {
            allGrounded: flaggedCount === 0,
            flaggedBulletCount: flaggedCount,
          },
        };
        await writeFile(fullPath, `${JSON.stringify(draftPayload, null, 2)}\n`, "utf8");

        return textResult({
          saved: true,
          fileName,
          status: "pending_human_review",
          allGrounded: flaggedCount === 0,
          flaggedBulletCount: flaggedCount,
          note:
            flaggedCount > 0
              ? `${flaggedCount} bullet(s) introduced novel numbers not in their sourceText and are flagged for mandatory human review.`
              : "All bullets passed numeric grounding checks. Saved for human review without mutating the master FactBase.",
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to save tailored draft.");
      }
    },
  );

  // ── MCP Resources ──
  server.registerResource(
    "factbase_summary",
    "betterme://factbase/summary",
    {
      title: "BetterMe FactBase Summary",
      description: "Anonymized summary of the user's verified career FactBase.",
      mimeType: "application/json",
    },
    async () => {
      const factBase = await loadFactBase();
      const body = factBase
        ? buildFactBaseSummary(factBase, "zh", includeContact)
        : { configured: false, hint: "Pass --resume <path> or BETTERME_RESUME_FILE." };
      return {
        contents: [{ uri: "betterme://factbase/summary", mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
      };
    },
  );

  server.registerResource(
    "opportunities_summary",
    "betterme://opportunities/summary",
    {
      title: "BetterMe Opportunity Library Summary",
      description: "Sanitized summary of saved job opportunities (without private notes or contacts).",
      mimeType: "application/json",
    },
    async () => {
      const jobs = await loadOpportunities();
      const body = {
        total: jobs.length,
        opportunities: jobs.slice(0, 50).map((job) => sanitizeOpportunity(job, false)),
      };
      return {
        contents: [{ uri: "betterme://opportunities/summary", mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
      };
    },
  );

  return server;
}
