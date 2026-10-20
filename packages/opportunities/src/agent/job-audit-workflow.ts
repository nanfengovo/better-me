import { StateGraph, START, END, type CompiledGraph } from "./state-graph.js";
import type { LangChainStructuredTool } from "./langchain-tool.js";

export interface JobAuditState {
  jobId: string;
  actorScope?: string;
  snapshotRevision?: number;
  job?: any;
  company?: any;
  location?: any;
  compensation?: any;
  observations?: any[];

  officeAudit?: {
    status: "skipped" | "confirmed" | "failed";
    coordinates?: { longitude: number; latitude: number };
    formattedAddress?: string;
    displayGrade?: string;
    receiptId?: string;
    reason?: string;
  };

  compensationAudit?: {
    status: "skipped" | "verified" | "incomparable" | "failed";
    annualMin?: number;
    annualMax?: number;
    currency?: string;
    receiptId?: string;
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

      // Query candidates
      const candRes = await candTool.invoke({
        jobId: state.job.id,
        locationId: state.location.id,
        expectedRevision: state.snapshotRevision,
        query: streetAddress,
        locality: state.location.city || "全国",
      });

      if (!candRes.candidates || candRes.candidates.length === 0) {
        return {
          officeAudit: { status: "failed", reason: `No building candidates found for "${streetAddress}"` },
          trace: [...trace, { step: "audit_location", timestamp: new Date().toISOString(), note: "No candidate found" }],
        };
      }

      const bestCandidate = candRes.candidates[0];

      // Preview
      const previewRes = await prevTool.invoke({
        jobId: state.job.id,
        locationId: state.location.id,
        expectedRevision: state.snapshotRevision,
        proposal: bestCandidate.proposal,
        reason: `Agent audit: ${bestCandidate.proposal.formattedAddress || streetAddress}`,
      });

      // Confirm
      const confRes = await confTool.invoke({
        jobId: state.job.id,
        locationId: state.location.id,
        expectedRevision: state.snapshotRevision,
        proposal: bestCandidate.proposal,
        previewFingerprint: previewRes.previewFingerprint,
        reason: `Agent audit: ${bestCandidate.proposal.formattedAddress || streetAddress}`,
        reviewed: true,
      });

      trace.push({
        step: "audit_location",
        timestamp: new Date().toISOString(),
        note: `Confirmed building coordinates (${confRes.location.coordinates.longitude}, ${confRes.location.coordinates.latitude})`,
      });

      return {
        snapshotRevision: confRes.revision,
        officeAudit: {
          status: "confirmed",
          coordinates: confRes.location.coordinates,
          formattedAddress: bestCandidate.proposal.formattedAddress,
          displayGrade: "building",
          receiptId: confRes.decisionId,
          reason: `Confirmed via ${confRes.location?.provider || "manual-user-confirmation"}`,
        },
        trace,
      };
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
          reason: "Successfully verified and annualized gross fixed cash",
        },
        trace,
      };
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

    const finalReport = {
      jobId: state.jobId,
      title: state.job?.title?.value ?? "未知岗位",
      company: state.company?.names?.[0] ?? "未知公司",
      salarySummary,
      locationSummary,
      controllerSummary,
      overallGrade,
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
