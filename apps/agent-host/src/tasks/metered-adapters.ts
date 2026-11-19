import type { MeasureToolGeneration, ToolBuilder } from "../capabilities/ollama.js";
import type { TrainingAuthor } from "../growth/training-model.js";
import type { LearningTranslationEngine } from "../growth/learning-translations.js";
import type { LocalOllamaClient } from "../privacy/local-ollama.js";
import type { CodingGenerator } from "../sandbox/coding-engine.js";
import type { ModelUsageMeter } from "./usage-meter.js";

async function measure<T>(
  meter: ModelUsageMeter,
  label: string,
  fn: () => Promise<T>,
  extractUsage?: (result: T) => { inputTokens: number; outputTokens: number } | undefined,
): Promise<T> {
  const finish = meter.begin(label, "model");
  try {
    const result = await fn();
    finish({ ok: true, usage: extractUsage?.(result) });
    return result;
  } catch (error) {
    finish({ ok: false });
    throw error;
  }
}

export function measureToolGeneration(meter: ModelUsageMeter): MeasureToolGeneration {
  return generate => measure(
    meter,
    "capability:ollama",
    generate,
    (result) => typeof result.generatedTokens === "number"
      ? { inputTokens: 0, outputTokens: result.generatedTokens }
      : undefined,
  );
}

export function meteredToolBuilder(meter: ModelUsageMeter, inner: ToolBuilder): ToolBuilder {
  const measureGeneration = measureToolGeneration(meter);
  return (feedback, signal) => measureGeneration(() => inner(feedback, signal));
}

export function meteredCodingGenerator(meter: ModelUsageMeter, inner: CodingGenerator): CodingGenerator {
  return (input, signal) => measure(meter, `coding:${input.model || "local"}`, () => inner(input, signal));
}

export function meteredTrainingAuthor(meter: ModelUsageMeter, inner: TrainingAuthor): TrainingAuthor {
  const reviewWriting = inner.reviewWriting;
  const recommendTransfer = inner.recommendTransfer;
  return {
    ...(recommendTransfer ? {
      recommendTransfer: (...args: Parameters<typeof recommendTransfer>) =>
        measure(meter, `training-transfer-recommendation:${args[0]}`, () => recommendTransfer(...args)),
    } : {}),
    ...(reviewWriting ? {
      reviewWriting: (...args: Parameters<typeof reviewWriting>) =>
        measure(meter, `training-writing-review:${args[0]}`, () => reviewWriting(...args)),
    } : {}),
    pin: (model, signal) => inner.pin(model, signal),
    diagnose: (...args) =>
      measure(meter, `training-diagnose:${args[0]}`, () => inner.diagnose(...args)),
    design: (...args) =>
      measure(meter, `training-design:${args[0].model ?? "local"}`, () => inner.design(...args)),
    program: (plan, pin, kind, signal, previous) =>
      measure(meter, `training-program:${plan.model ?? "local"}`, () => inner.program(plan, pin, kind, signal, previous)),
  };
}

export function meteredTranslationEngine(
  meter: ModelUsageMeter,
  inner: LearningTranslationEngine | undefined,
): LearningTranslationEngine | undefined {
  if (!inner) return undefined;
  return {
    ...(inner.abortSettles ? { abortSettles: inner.abortSettles } : {}),
    backend: (location) => inner.backend(location),
    run: (input) => inner.run({
      ...input,
      modelCall: (prompt, complete) =>
        input.modelCall(prompt, (signal) =>
          measure(meter, `pdf2zh:${input.request.targetLanguage}`, () => complete(signal)),
        ),
    }),
  };
}

export function meteredLocalOllamaClient(
  meter: ModelUsageMeter,
  inner: LocalOllamaClient,
  modelLabel: string,
): LocalOllamaClient {
  return {
    binding: () => inner.binding(),
    complete: (input) => measure(meter, `local:${modelLabel}`, () => inner.complete(input)),
    ...(inner.embed
      ? { embed: (input: { texts: readonly string[]; signal: AbortSignal; budget: Parameters<LocalOllamaClient["complete"]>[0]["budget"] }) =>
          measure(meter, `local-embed:${modelLabel}`, () => inner.embed!(input)) }
      : {}),
  };
}
