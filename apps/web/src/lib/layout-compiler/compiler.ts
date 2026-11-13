import { diagnoseLayout } from "./diagnostics";
import { checkTextProtection, type ProtectedTextSpan } from "./protection";
import {
  sameLayoutScope, type LayoutDiagnosis, type LayoutDiagnosticOptions, type LayoutMeasurement,
  type LayoutRenderBinding, type LayoutReport, type LayoutScope, type LayoutSource,
} from "./types";

export interface LayoutText {
  anchor: string;
  text: string;
  /** Authorized proper names, technical entities, ownership phrases and source links. */
  protectedSpans?: readonly ProtectedTextSpan[];
}

export interface LayoutParameters {
  marginMm?: number;
  bodyFontPt?: number;
  lineHeight?: number;
  sectionGapMm?: number;
  bulletGapMm?: number;
}

export interface LayoutInput {
  scope: LayoutScope;
  texts: readonly LayoutText[];
  parameters?: Readonly<LayoutParameters>;
}

/** A patch against the immutable input, not a mutation of the current resume. */
export interface LayoutCandidate {
  id: string;
  baseScope: LayoutScope;
  replacements: readonly { anchor: string; before: string; after: string }[];
  parameters?: Readonly<LayoutParameters>;
  explanation?: string;
}

export const REQUIRED_SEMANTIC_CHECKS = [
  "numbers-units", "entities", "negation", "qualifiers", "attribution", "evidence-references", "meaning",
] as const;
export type SemanticCheck = typeof REQUIRED_SEMANTIC_CHECKS[number];

export interface LayoutSemanticVerdict {
  verdict: "equivalent" | "not-equivalent" | "unknown";
  method: "independent-rules" | "independent-review" | "human-review" | "model-self-review";
  verifierId: string;
  candidateId: string;
  candidateFingerprint: string;
  scope: LayoutScope;
  checks: readonly SemanticCheck[];
  detail: string;
}

export interface LayoutCompilerAdapters {
  /** Must render in isolation. It must not save/adopt a candidate or alter the live editor. */
  render(candidate: LayoutCandidate, signal: AbortSignal, binding: Readonly<LayoutRenderBinding>): Promise<LayoutMeasurement>;
  rewrite(request: {
    input: LayoutInput; current: LayoutCandidate; report: LayoutDiagnosis;
    iteration: number; maxCandidates: number;
  }, signal: AbortSignal): Promise<readonly LayoutCandidate[]>;
  /** A generator's own 'equivalent' assertion is deliberately insufficient. */
  verifySemantics?(request: { input: LayoutInput; candidate: LayoutCandidate }, signal: AbortSignal): Promise<LayoutSemanticVerdict>;
  getCurrentScope(): LayoutScope;
}

export interface LayoutCompilerOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  maxCandidatesPerIteration?: number;
  maxTotalCandidates?: number;
  maxDurationMs?: number;
  maxCandidateCharacters?: number;
  diagnostics?: LayoutDiagnosticOptions;
  /** DOM and final-file penalties cannot be compared as interchangeable evidence. */
  requiredSource?: LayoutSource;
}

export interface LayoutCompileEvent {
  iteration: number;
  candidateId?: string;
  kind: "rendered" | "rejected" | "selected" | "unavailable" | "duplicate";
  reason: string;
}

export interface LayoutProposal {
  candidate: LayoutCandidate;
  report: LayoutDiagnosis;
  semanticVerdict?: LayoutSemanticVerdict;
  requiresConfirmation: true;
  /** One renderer's geometry cannot check both PDF and DOCX, links, and visual quality. */
  needsSeparateFinalFileChecks: boolean;
}

export interface LayoutCompileResult {
  status: "proposed" | "unchanged" | "nonconvergent" | "unavailable" | "cancelled" | "stale" | "failed";
  reason: string;
  scope: LayoutScope;
  requiresConfirmation: true;
  baseline?: LayoutReport;
  proposal?: LayoutProposal;
  iterations: number;
  renderedCandidates: number;
  events: LayoutCompileEvent[];
}

class Interrupted extends Error {
  constructor(readonly reason: "cancelled" | "stale" | "timeout", message: string) { super(message); }
}

const bounds = {
  marginMm: [12, 28], bodyFontPt: [9, 14], lineHeight: [1, 2], sectionGapMm: [0, 12], bulletGapMm: [0, 6],
} as const;

function validateParameters(parameters: Readonly<LayoutParameters> | undefined): string | undefined {
  if (!parameters) return undefined;
  for (const [key, value] of Object.entries(parameters)) {
    if (!(key in bounds)) return `Unsupported layout parameter: ${key}`;
    const [minimum, maximum] = bounds[key as keyof typeof bounds];
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return `Layout parameter outside readability bounds: ${key}`;
  }
  return undefined;
}

export function layoutCandidateFingerprint(candidate: LayoutCandidate): string {
  return JSON.stringify({
    replacements: [...candidate.replacements].map(item => [item.anchor, item.before, item.after]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    parameters: Object.entries(candidate.parameters ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  });
}

export function validateLayoutCandidate(input: LayoutInput, candidate: LayoutCandidate, characterLimit = 48000): string | undefined {
  if (!candidate.id.trim() || candidate.id.length > 160 || !sameLayoutScope(input.scope, candidate.baseScope)) return "Candidate belongs to another input version or has no bounded ID";
  const parametersError = validateParameters(input.parameters?.bodyFontPt === 8 && candidate.parameters?.bodyFontPt === 8
    ? { ...candidate.parameters, bodyFontPt: 9 } : candidate.parameters);
  if (parametersError) return parametersError;
  const seen = new Set<string>();
  let characters = 0;
  for (const replacement of candidate.replacements) {
    const original = input.texts.find(text => text.anchor === replacement.anchor);
    characters += replacement.after.length;
    if (!original || seen.has(replacement.anchor) || original.text !== replacement.before || !replacement.after.trim()) {
      return "Candidate removed, duplicated or invented an anchor, changed the base text, or emptied content";
    }
    seen.add(replacement.anchor);
    const protection = checkTextProtection(replacement.before, replacement.after, original.protectedSpans);
    if (!protection.accepted) return `Protected content changed at ${replacement.anchor}: ${protection.violations.map(violation => violation.kind).join(", ")}`;
  }
  if (characters > characterLimit) return "Candidate exceeded the text budget";
  return undefined;
}

export function isAcceptableLayoutSemanticVerdict(verdict: LayoutSemanticVerdict, input: LayoutInput, candidate: LayoutCandidate) {
  return verdict.verdict === "equivalent" && ["independent-rules", "independent-review", "human-review"].includes(verdict.method)
    && verdict.verifierId.trim().length > 0 && verdict.candidateId === candidate.id
    && verdict.candidateFingerprint === layoutCandidateFingerprint(candidate)
    && sameLayoutScope(verdict.scope, input.scope)
    && REQUIRED_SEMANTIC_CHECKS.every(check => verdict.checks.includes(check));
}

function cloneInput(input: LayoutInput): LayoutInput {
  return {
    scope: { ...input.scope },
    texts: input.texts.map(text => ({ ...text, protectedSpans: text.protectedSpans?.map(span => ({ ...span })) })),
    parameters: input.parameters ? { ...input.parameters } : undefined,
  };
}

function cloneCandidate(candidate: LayoutCandidate): LayoutCandidate {
  return { ...candidate, baseScope: { ...candidate.baseScope }, replacements: candidate.replacements.map(item => ({ ...item })), parameters: candidate.parameters ? { ...candidate.parameters } : undefined };
}

function cloneDiagnosis(report: LayoutDiagnosis): LayoutDiagnosis {
  return { ...report, scope: { ...report.scope }, issues: report.issues.map(issue => ({ ...issue, metrics: { ...issue.metrics } })),
    pages: report.pages.map(page => ({ ...page })), limitations: [...report.limitations] };
}

/**
 * Bounded proposal compiler. No resume setters or persistence APIs are accepted.
 * Semantic gates are conservative evidence, not proof; the returned patch always
 * needs an explicit, version-checked user adoption in the owning Workspace.
 */
export async function compileLayoutProposals(originalInput: LayoutInput, adapters: LayoutCompilerAdapters,
  options: LayoutCompilerOptions = {}): Promise<LayoutCompileResult> {
  const input = cloneInput(originalInput);
  const events: LayoutCompileEvent[] = [];
  const controller = new AbortController();
  const maxIterations = Math.min(10, Math.max(0, Math.floor(options.maxIterations ?? 3)));
  const perIteration = Math.min(10, Math.max(1, Math.floor(options.maxCandidatesPerIteration ?? 3)));
  const totalBudget = Math.min(50, Math.max(1, Math.floor(options.maxTotalCandidates ?? 9)));
  const duration = Math.min(60000, Math.max(1, options.maxDurationMs ?? 10000));
  const deadline = Date.now() + duration;
  let iterations = 0, renderedCandidates = 0, consideredCandidates = 0;
  let baseline: LayoutReport | undefined;
  let proposal: LayoutProposal | undefined;
  const finish = (status: LayoutCompileResult["status"], reason: string): LayoutCompileResult => ({
    status, reason, scope: input.scope, requiresConfirmation: true, baseline,
    // Stale/cancelled results must never expose an actionable late proposal.
    proposal: status === "stale" || status === "cancelled" ? undefined : proposal,
    iterations, renderedCandidates, events,
  });
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const check = () => {
    if (options.signal?.aborted) throw new Interrupted("cancelled", "Layout compilation was cancelled");
    if (!sameLayoutScope(input.scope, adapters.getCurrentScope())) throw new Interrupted("stale", "The selected input, owner or session changed");
    if (Date.now() >= deadline) throw new Interrupted("timeout", "Layout compilation reached its deadline");
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let done = false;
    const finishWait = (error?: unknown, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finishWait(new Interrupted("cancelled", "Layout compilation was cancelled"));
    const timer = setTimeout(() => {
      controller.abort();
      finishWait(new Interrupted("timeout", "An Adapter exceeded the layout deadline"));
    }, Math.max(1, deadline - Date.now()));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    promise.then(value => finishWait(undefined, value), error => finishWait(error));
  });

  try {
    check();
    if (input.texts.length > 1000 || new Set(input.texts.map(text => text.anchor)).size !== input.texts.length
      || input.texts.some(text => !text.anchor || !text.text.trim())) return finish("failed", "Input anchors must be unique, nonempty and bounded");
    // Existing views permit 8pt. Keep measuring that original without allowing a
    // generator to shrink a candidate below this compiler's 9pt readability floor.
    const initialParameterError = validateParameters(input.parameters?.bodyFontPt === 8 ? { ...input.parameters, bodyFontPt: 9 } : input.parameters);
    if (initialParameterError) return finish("failed", initialParameterError);
    const initial: LayoutCandidate = { id: "layout-baseline", baseScope: input.scope, replacements: [], parameters: input.parameters };
    const initialBinding = { candidateId: initial.id, fingerprint: layoutCandidateFingerprint(initial) };
    const measurement = await wait(adapters.render(cloneCandidate(initial), controller.signal, { ...initialBinding }));
    check();
    renderedCandidates++;
    if (!sameLayoutScope(measurement.scope, input.scope)) throw new Interrupted("stale", "Renderer returned another input version");
    baseline = diagnoseLayout(measurement, options.diagnostics);
    if (baseline.status === "unavailable") return finish("unavailable", baseline.detail);
    if (measurement.status === "measured" && (measurement.renderBinding?.candidateId !== initialBinding.candidateId
      || measurement.renderBinding?.fingerprint !== initialBinding.fingerprint)) return finish("unavailable", "Renderer did not bind geometry to this candidate payload");
    if (options.requiredSource && baseline.source !== options.requiredSource) return finish("unavailable", "Renderer did not supply the requested evidence source");
    if (measurement.status === "measured" && measurement.finalEvidence?.bodyTextCheck.status === "mismatch") return finish("unavailable", "The final file failed its body-text integrity check");
    events.push({ iteration: 0, candidateId: initial.id, kind: "rendered", reason: `Baseline penalty: ${baseline.penalty}` });
    if (baseline.penalty === 0) return finish("unchanged", "No configured layout issue was measured; final-file and visual checks remain separate");
    let current = initial;
    let report = baseline;
    const seen = new Set([layoutCandidateFingerprint(initial)]);
    for (let iteration = 1; iteration <= maxIterations && consideredCandidates < totalBudget; iteration++) {
      check();
      iterations = iteration;
      const allowance = Math.min(perIteration, totalBudget - consideredCandidates);
      const candidates = await wait(adapters.rewrite({ input: cloneInput(input), current: cloneCandidate(current), report: cloneDiagnosis(report), iteration, maxCandidates: allowance }, controller.signal));
      check();
      if (!Array.isArray(candidates)) return finish("failed", "The rewriting Adapter did not return candidate data");
      if (!candidates.length) return finish("nonconvergent", "The rewriting Adapter supplied no more candidates");
      if (candidates.length > allowance) events.push({ iteration, kind: "rejected", reason: "Candidates beyond the remaining budget were not evaluated" });
      for (const suppliedCandidate of candidates.slice(0, allowance)) {
        check();
        consideredCandidates++;
        const candidate = cloneCandidate(suppliedCandidate);
        const error = validateLayoutCandidate(input, candidate, options.maxCandidateCharacters ?? 48000);
        if (error) { events.push({ iteration, candidateId: candidate.id, kind: "rejected", reason: error }); continue; }
        const key = layoutCandidateFingerprint(candidate);
        if (seen.has(key)) { events.push({ iteration, candidateId: candidate.id, kind: "duplicate", reason: "Repeated candidate content was not rendered again" }); continue; }
        seen.add(key);
        let semanticVerdict: LayoutSemanticVerdict | undefined;
        const textChanged = candidate.replacements.some(replacement => replacement.before !== replacement.after);
        if (textChanged) {
          if (!adapters.verifySemantics) { events.push({ iteration, candidateId: candidate.id, kind: "rejected", reason: "Changed wording requires an independent semantic verifier and later human confirmation" }); continue; }
          semanticVerdict = await wait(adapters.verifySemantics({ input: cloneInput(input), candidate: cloneCandidate(candidate) }, controller.signal));
          check();
          if (!isAcceptableLayoutSemanticVerdict(semanticVerdict, input, candidate)) { events.push({ iteration, candidateId: candidate.id, kind: "rejected", reason: "Semantic verification was unknown, negative, incomplete, stale or model self-review" }); continue; }
        }
        let candidateMeasurement: LayoutMeasurement;
        const binding = { candidateId: candidate.id, fingerprint: key };
        try { candidateMeasurement = await wait(adapters.render(cloneCandidate(candidate), controller.signal, { ...binding })); }
        catch (renderError) {
          if (renderError instanceof Interrupted) throw renderError;
          check();
          events.push({ iteration, candidateId: candidate.id, kind: "unavailable", reason: "The candidate renderer failed; no geometry was inferred" });
          continue;
        }
        check();
        renderedCandidates++;
        if (!sameLayoutScope(candidateMeasurement.scope, input.scope)) throw new Interrupted("stale", "Renderer returned another input version");
        const candidateReport = diagnoseLayout(candidateMeasurement, options.diagnostics);
        if (candidateReport.status === "unavailable") { events.push({ iteration, candidateId: candidate.id, kind: "unavailable", reason: candidateReport.detail }); continue; }
        if (candidateMeasurement.status === "measured" && (candidateMeasurement.renderBinding?.candidateId !== binding.candidateId
          || candidateMeasurement.renderBinding?.fingerprint !== binding.fingerprint)) {
          events.push({ iteration, candidateId: candidate.id, kind: "rejected", reason: "Renderer returned geometry for a different candidate payload" }); continue;
        }
        if (candidateReport.source !== baseline.source || (candidateMeasurement.status === "measured" && candidateMeasurement.finalEvidence?.bodyTextCheck.status === "mismatch")) {
          events.push({ iteration, candidateId: candidate.id, kind: "rejected", reason: "Candidate evidence source changed or final body-text integrity failed" }); continue;
        }
        events.push({ iteration, candidateId: candidate.id, kind: "rendered", reason: `Candidate penalty: ${candidateReport.penalty}` });
        if (candidateReport.penalty < report.penalty) {
          current = candidate;
          report = candidateReport;
          proposal = { candidate, report, semanticVerdict, requiresConfirmation: true, needsSeparateFinalFileChecks: true };
          events.push({ iteration, candidateId: candidate.id, kind: "selected", reason: "The measured penalty decreased; this is still only a proposal" });
        }
        if (report.penalty === 0) { check(); return finish("proposed", "A candidate resolved the configured measured issues; explicit adoption and separate output checks are still required"); }
      }
    }
    check();
    return finish("nonconvergent", "The bounded iteration or candidate budget ended before all configured issues resolved");
  } catch (error) {
    controller.abort();
    if (options.signal?.aborted) return finish("cancelled", "Layout compilation was cancelled");
    try {
      if (!sameLayoutScope(input.scope, adapters.getCurrentScope())) return finish("stale", "The selected input, owner or session changed");
    } catch { return finish("failed", "The current version binding could not be checked"); }
    if (error instanceof Interrupted) return finish(error.reason === "timeout" ? "nonconvergent" : error.reason, error.message);
    return finish("failed", error instanceof Error ? error.message : "Layout compilation failed");
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
  }
}
