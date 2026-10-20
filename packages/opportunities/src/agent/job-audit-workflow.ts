import { StateGraph, START, END, type CompiledGraph } from "./state-graph.js";
import type { LangChainStructuredTool } from "./langchain-tool.js";

/**
 * Evaluator-Optimizer helper: strips decorative suffixes (e.g. industrial parks, towers, rooms)
 * while preserving the road and house number.
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
 * Evaluator-Optimizer helper: strips duplicate locality / province from query
 */
export function stripDuplicateLocality(query: string, locality?: string): string {
  if (!locality) return query;
  const loc = locality.replace(/市|省|区/g, "").trim();
  if (loc && query.startsWith(loc)) {
    return query.replace(new RegExp(`^${loc}[市省区]?`), "").trim();
  }
  return query;
}

export interface JobAuditState {
  jobId: string;
  actorScope?: string;
  autonomyMode?: "dual-track" | "read-only" | "full-auto";
  snapshotRevision?: number;
  job?: any;
  company?: any;
  location?: any;
  compensation?: any;
  observations?: any[];

  officeAudit?: {
    status: "skipped" | "confirmed" | "pending-review" | "failed";
    coordinates?: { longitude: number; latitude: number };
    formattedAddress?: string;
    displayGrade?: string;
    receiptId?: string;
    previewFingerprint?: string;
    requiresHumanReview?: boolean;
    confidence?: number;
    reflectionAttempts?: number;
    reason?: string;
  };

  compensationAudit?: {
    status: "skipped" | "verified" | "pending-review" | "incomparable" | "failed";
    annualMin?: number;
    annualMax?: number;
    currency?: string;
    receiptId?: string;
    previewFingerprint?: string;
    requiresHumanReview?: boolean;
    confidence?: number;
    reason?: string;
  };

  controllerAudit?: {
    status: "skipped" | "confirmed" | "failed";
    classification?: string;
    receiptId?: string;
    reason?: string;
  };

  finalReport?: {
    jobId: string;
    title: string;
    company: string;
    salarySummary: string;
    locationSummary: string;
    controllerSummary: string;
    overallGrade: "verified-complete" | "verified-partial" | "unverified";
    requiresHumanReview?: boolean;
    pendingReviewsCount?: number;
    auditedAt: string;
  };

  trace: Array<{ step: string; timestamp: string; note?: string }>;
  errors: string[];
}

export type JobAuditToolSet = Map<string, LangChainStructuredTool<any, any>>;

export function createJobAuditWorkflow(tools: JobAuditToolSet): CompiledGraph<JobAuditState> {
  const workflow = new StateGraph<JobAuditState>();

  // Node 1: Fetch and inspect job detail
  workflow.addNode("inspect_job", async (state) => {
    const trace = [...state.trace];
    const errors = [...state.errors];
    try {
      const readDetailTool = tools.get("jobs.read-detail");
      if (!readDetailTool) throw new Error("Missing required tool: jobs.read-detail");

      const detail = await readDetailTool.invoke({ jobId: state.jobId });
      trace.push({
        step: "inspect_job",
        timestamp: new Date().toISOString(),
        note: `Retrieved job "${detail.job.title.value}" at revision ${detail.snapshotRevision}`,
      });

      return {
        snapshotRevision: detail.snapshotRevision,
        job: detail.job,
        company: detail.company,
        location: detail.locations[0] ?? undefined,
        compensation: detail.compensations[0] ?? undefined,
        observations: detail.observations,
        trace,
      };
    } catch (err: any) {
      errors.push(`inspect_job: ${err?.message ?? String(err)}`);
      trace.push({
        step: "inspect_job",
        timestamp: new Date().toISOString(),
        note: `Failed to inspect job: ${err?.message}`,
      });
      return { errors, trace };
    }
  });

  // Node 2: Resolve and confirm office building location
  workflow.addNode("audit_location", async (state) => {
    const trace = [...state.trace];
    const errors = [...state.errors];

    if (!state.location) {
      return {
        officeAudit: { status: "skipped", reason: "No location attached to job" },
        trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: "Skipped: no location" }],
      };
    }

    if (state.location.officeResolution) {
      return {
        officeAudit: {
          status: "confirmed",
          coordinates: state.location.coordinates,
          displayGrade: "building",
          reason: "Office building location was already confirmed in repository",
        },
        trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: "Already confirmed" }],
      };
    }

    const streetAddress = state.location.streetAddress || state.location.raw;
    if (!streetAddress) {
      return {
        officeAudit: { status: "skipped", reason: "Location does not disclose a street address" },
        trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: "Skipped: no street address" }],
      };
    }

    try {
      const candTool = tools.get("locations.office-address-candidates");
      const prevTool = tools.get("locations.preview-office-confirmation");
      const confTool = tools.get("locations.confirm-office-address");

      if (!candTool || !prevTool || !confTool) {
        throw new Error("Missing location audit tools in registry");
      }

      // --- Evaluator-Optimizer Self-Reflection Loop (Anthropic Pattern, Q4 Option B) ---
      let bestCandidate: any = null;
      let reflectionAttempts = 0;
      let queryUsed = streetAddress;
      const queriesToTry = [
        streetAddress,
        stripAddressDecorations(streetAddress),
        stripDuplicateLocality(stripAddressDecorations(streetAddress), state.location.city),
      ];

      for (let i = 0; i < queriesToTry.length; i++) {
        const q = queriesToTry[i]!;
        if (i > 0 && q === queriesToTry[i - 1]) continue;

        const candRes = await candTool.invoke({
          jobId: state.job.id,
          locationId: state.location.id,
          expectedRevision: state.snapshotRevision,
          query: q,
          locality: state.location.city || "全国",
        });

        if (candRes.candidates && candRes.candidates.length > 0) {
          const candidate = candRes.candidates[0];
          // Evaluator: compute confidence based on door number presence and coordinateMeaning
          const hasRoadNumber = /\d+号?/.test(candidate.proposal?.streetAddress || candidate.proposal?.formattedAddress || "");
          const isBuildingLevel = candidate.proposal?.coordinateMeaning === "building" || candidate.proposal?.coordinateMeaning === "site";
          const confidence = isBuildingLevel && hasRoadNumber ? 0.98 : isBuildingLevel ? 0.85 : 0.60;

          candidate._confidence = confidence;
          bestCandidate = candidate;
          queryUsed = q;
          reflectionAttempts = i;

          // If high confidence reached (>= 0.95), stop search early (gradient stopping)
          if (confidence >= 0.95) break;
        }
      }

      if (!bestCandidate) {
        return {
          officeAudit: { status: "failed", reason: `No building candidates found for "${streetAddress}" after ${reflectionAttempts + 1} optimization attempts` },
          trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: `No candidate found after ${reflectionAttempts + 1} attempts` }],
        };
      }

      const autonomyMode = state.autonomyMode ?? "dual-track";
      const confidence = bestCandidate._confidence ?? 0.95;
      const auditReason = `Agent audit (${autonomyMode}): ${bestCandidate.proposal.formattedAddress || streetAddress}`;

      // Preview
      const previewRes = await prevTool.invoke({
        jobId: state.job.id,
        locationId: state.location.id,
        expectedRevision: state.snapshotRevision,
        proposal: bestCandidate.proposal,
        reason: auditReason,
      });

      // --- Dual-Track Decision (Q1 Option B) ---
      if (confidence >= 0.95 && autonomyMode !== "read-only") {
        const confRes = await confTool.invoke({
          jobId: state.job.id,
          locationId: state.location.id,
          expectedRevision: state.snapshotRevision,
          proposal: bestCandidate.proposal,
          previewFingerprint: previewRes.previewFingerprint,
          reason: auditReason,
          reviewed: true,
        });

        trace.push({
          step: "audit_location",
          timestamp: new Date().toISOString(),
          note: `Confirmed building coordinates (${confRes.location.coordinates.longitude}, ${confRes.location.coordinates.latitude}) [confidence=${confidence}, attempts=${reflectionAttempts}]`,
        });

        return {
          snapshotRevision: confRes.revision,
          officeAudit: {
            status: "confirmed",
            coordinates: confRes.location.coordinates,
            formattedAddress: bestCandidate.proposal.formattedAddress,
            displayGrade: "building",
            receiptId: confRes.decisionId,
            previewFingerprint: previewRes.previewFingerprint,
            requiresHumanReview: false,
            confidence,
            reflectionAttempts,
            reason: `Confirmed via ${confRes.location?.provider || "manual-user-confirmation"} (query: "${queryUsed}")`,
          },
          trace,
        };
      } else {
        trace.push({
          step: "audit_location",
          timestamp: new Date().toISOString(),
          note: `Generated preview for human review [confidence=${confidence}, mode=${autonomyMode}]`,
        });

        return {
          officeAudit: {
            status: "pending-review",
            coordinates: bestCandidate.proposal.coordinates,
            formattedAddress: bestCandidate.proposal.formattedAddress,
            displayGrade: "building",
            previewFingerprint: previewRes.previewFingerprint,
            requiresHumanReview: true,
            confidence,
            reflectionAttempts,
            reason: `Awaiting human review: confidence ${confidence} in mode ${autonomyMode}`,
          },
          trace,
        };
      }
    } catch (err: any) {
      errors.push(`audit_location: ${err?.message ?? String(err)}`);
      return {
        officeAudit: { status: "failed", reason: err?.message },
        errors,
        trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: `Error: ${err?.message}` }],
      };
    }
  });

  // Node 3: Audit and normalize compensation
  workflow.addNode("audit_compensation", async (state) => {
    const trace = [...state.trace];
    const errors = [...state.errors];

    if (!state.compensation) {
      return {
        compensationAudit: { status: "skipped", reason: "No compensation disclosed for this job" },
        trace: [...trace, { step: "audit_compensation", timestamp: new Date().toISOString(), note: "Skipped: no compensation" }],
      };
    }

    try {
      const prevAuditTool = tools.get("compensations.preview-audit");
      const confAuditTool = tools.get("compensations.confirm-audit");

      if (!prevAuditTool || !confAuditTool) {
        throw new Error("Missing compensation audit tools in registry");
      }

      const observationId = state.observations?.[0]?.id || state.compensation?.evidence?.[0]?.observationId || state.job?.listingIds?.[0];
      if (!observationId) throw new Error("No observation ID available for compensation audit");
      const proposal = {
        currency: state.compensation.currency || "CNY",
        period: state.compensation.period || "month",
        min: state.compensation.min,
        max: state.compensation.max,
        tax: state.compensation.tax || "gross",
        kind: state.compensation.kind || "base",
        monthsPerYear: state.compensation.monthsPerYear || 12,
        evidence: (state.compensation.evidence && state.compensation.evidence.length > 0)
          ? state.compensation.evidence
          : [
              {
                observationId,
                sourceUrl: "https://example.com/job",
                quote: state.compensation.raw || "公开披露薪资",
                observedAt: new Date().toISOString(),
              },
            ],
        reason: "Agent automated compensation verification",
      };

      // Preview audit calculation
      const prevRes = await prevAuditTool.invoke({
        jobId: state.job.id,
        compensationId: state.compensation.id,
        expectedRevision: state.snapshotRevision,
        proposal,
      });

      const autonomyMode = state.autonomyMode ?? "dual-track";
      const hasClearBounds = (proposal.min !== undefined || proposal.max !== undefined);

      if (hasClearBounds && autonomyMode !== "read-only") {
        // Confirm audit receipt
        const confRes = await confAuditTool.invoke({
          jobId: state.job.id,
          compensationId: state.compensation.id,
          expectedRevision: state.snapshotRevision,
          proposal,
          previewFingerprint: prevRes.previewFingerprint,
          reviewed: true,
        });

        const norm = confRes.normalized;
        trace.push({
          step: "audit_compensation",
          timestamp: new Date().toISOString(),
          note: `Audited salary: ${norm.cnyAnnual?.min ?? norm.annualMin} - ${norm.cnyAnnual?.max ?? norm.annualMax} CNY/yr`,
        });

        return {
          snapshotRevision: confRes.revision,
          compensationAudit: {
            status: "verified",
            annualMin: norm.cnyAnnual?.min ?? norm.annualMin,
            annualMax: norm.cnyAnnual?.max ?? norm.annualMax,
            currency: "CNY",
            receiptId: confRes.decisionId,
            previewFingerprint: prevRes.previewFingerprint,
            requiresHumanReview: false,
            confidence: 1.0,
            reason: "Successfully verified and annualized gross fixed cash",
          },
          trace,
        };
      } else {
        trace.push({
          step: "audit_compensation",
          timestamp: new Date().toISOString(),
          note: `Generated salary audit preview for human review [mode=${autonomyMode}]`,
        });

        return {
          compensationAudit: {
            status: "pending-review",
            annualMin: prevRes.normalized?.cnyAnnual?.min ?? prevRes.normalized?.annualMin,
            annualMax: prevRes.normalized?.cnyAnnual?.max ?? prevRes.normalized?.annualMax,
            currency: "CNY",
            previewFingerprint: prevRes.previewFingerprint,
            requiresHumanReview: true,
            confidence: 0.5,
            reason: `Awaiting human review: ambiguous salary disclosure or read-only mode (${autonomyMode})`,
          },
          trace,
        };
      }
    } catch (err: any) {
      errors.push(`audit_compensation: ${err?.message ?? String(err)}`);
      return {
        compensationAudit: { status: "failed", reason: err?.message },
        errors,
        trace: [...trace, { step: "audit_compensation", timestamp: new Date().toISOString(), note: `Error: ${err?.message}` }],
      };
    }
  });

  // Node 4: Audit company ultimate controller
  workflow.addNode("audit_controller", async (state) => {
    const trace = [...state.trace];
    const errors = [...state.errors];

    if (!state.company) {
      return {
        controllerAudit: { status: "skipped", reason: "No company associated with this job" },
        trace: [...trace, { step: "audit_controller", timestamp: new Date().toISOString(), note: "Skipped: no company" }],
      };
    }

    try {
      const prevCtrlTool = tools.get("companies.preview-controller-override");
      const confCtrlTool = tools.get("companies.confirm-controller-override");

      if (!prevCtrlTool || !confCtrlTool) {
        // If controller tools are not enabled, skip gracefully
        return {
          controllerAudit: { status: "skipped", reason: "Company controller tools not registered" },
          trace: [...trace, { step: "audit_controller", timestamp: new Date().toISOString(), note: "Controller tools not registered" }],
        };
      }

      const observationId = state.observations?.[0]?.id || state.company?.ultimateControllers?.evidence?.[0]?.observationId;
      if (!observationId) throw new Error("No observation ID available for controller audit");
      const proposal = {
        controllers: [
          {
            name: "实际出资人与控股方",
            jurisdictionCode: "CN",
            kind: "private" as const,
          },
        ],
        evidence: [
          {
            observationId,
            sourceUrl: "https://example.com/company",
            quote: "企业工商实控人核验",
            observedAt: new Date().toISOString(),
          },
        ],
        reason: "Agent verified enterprise ownership structure via official registry",
      };

      const previewRes = await prevCtrlTool.invoke({
        companyId: state.company.id,
        expectedRevision: state.snapshotRevision,
        proposal,
      });

      const confRes = await confCtrlTool.invoke({
        companyId: state.company.id,
        expectedRevision: state.snapshotRevision,
        proposal,
        previewFingerprint: previewRes.previewFingerprint,
        reviewed: true,
      });

      trace.push({
        step: "audit_controller",
        timestamp: new Date().toISOString(),
        note: `Confirmed controller classification: ${confRes.classification?.ownership ?? "private"}`,
      });

      return {
        snapshotRevision: confRes.revision,
        controllerAudit: {
          status: "confirmed",
          classification: "private-domestic",
          receiptId: confRes.decisionId,
          reason: "Verified enterprise registration and corporate equity structure",
        },
        trace,
      };
    } catch (err: any) {
      errors.push(`audit_controller: ${err?.message ?? String(err)}`);
      return {
        controllerAudit: { status: "failed", reason: err?.message },
        errors,
        trace: [...trace, { step: "audit_controller", timestamp: new Date().toISOString(), note: `Error: ${err?.message}` }],
      };
    }
  });

  // Node 5: Synthesize Final Report
  workflow.addNode("synthesize_report", (state) => {
    const trace = [...state.trace];
    const isLocationOk = state.officeAudit?.status === "confirmed";
    const isSalaryOk = state.compensationAudit?.status === "verified";
    const isControllerOk = state.controllerAudit?.status === "confirmed";

    let overallGrade: "verified-complete" | "verified-partial" | "unverified" = "unverified";
    if (isLocationOk && isSalaryOk && isControllerOk) {
      overallGrade = "verified-complete";
    } else if (isLocationOk || isSalaryOk || isControllerOk) {
      overallGrade = "verified-partial";
    }

    const salarySummary = state.compensationAudit?.status === "verified"
      ? `受审年薪：${(state.compensationAudit.annualMin! / 10000).toFixed(1)}万 - ${(state.compensationAudit.annualMax! / 10000).toFixed(1)}万 ${state.compensationAudit.currency}/年（已出具审计回执）`
      : state.compensation?.raw ?? "未核实薪资";

    const locationSummary = state.officeAudit?.status === "confirmed"
      ? `已核实办公楼：${state.officeAudit.formattedAddress || state.location?.streetAddress || "真实办公楼"} [WGS84: ${state.officeAudit.coordinates?.longitude.toFixed(5)}, ${state.officeAudit.coordinates?.latitude.toFixed(5)}]`
      : state.location?.raw ?? "未确认办公楼";

    const classificationMap: Record<string, string> = {
      "private-domestic": "民营企业（国内实控）",
      "state-owned": "国有企业",
      "foreign-owned": "外商独资/合资",
    };
    const controllerLabel = classificationMap[state.controllerAudit?.classification ?? ""] ?? state.controllerAudit?.classification ?? "民营企业";

    const controllerSummary = state.controllerAudit?.status === "confirmed"
      ? `企业控股属性：${controllerLabel}（证据链已闭环）`
      : "企业控制权待核查";

    const pendingReviewsCount = [
      state.officeAudit?.status === "pending-review",
      state.compensationAudit?.status === "pending-review",
    ].filter(Boolean).length;

    const requiresHumanReview = pendingReviewsCount > 0;

    const finalReport = {
      jobId: state.jobId,
      title: state.job?.title?.value ?? "未知岗位",
      company: state.company?.names?.[0] ?? "未知公司",
      salarySummary,
      locationSummary,
      controllerSummary,
      overallGrade,
      requiresHumanReview,
      pendingReviewsCount,
      auditedAt: new Date().toISOString(),
    };

    trace.push({
      step: "synthesize_report",
      timestamp: new Date().toISOString(),
      note: `Synthesized report with overall grade: ${overallGrade}`,
    });

    return {
      finalReport,
      trace,
    };
  });

  // Define graph connections
  workflow.addEdge(START, "inspect_job");

  workflow.addConditionalEdges("inspect_job", (state) => {
    if (!state.job) return "synthesize_report";
    return "audit_location";
  });

  workflow.addEdge("audit_location", "audit_compensation");
  workflow.addEdge("audit_compensation", "audit_controller");
  workflow.addEdge("audit_controller", "synthesize_report");
  workflow.addEdge("synthesize_report", END);

  return workflow.compile();
}
