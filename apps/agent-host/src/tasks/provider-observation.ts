import type { CareerTaskModelOutput } from "../kernel/model-protocol.js";
import type { ProviderTokenUsage } from "./usage-meter.js";

export type ProviderObservation = Readonly<{ wallMs: number } & Partial<ProviderTokenUsage>>;
const observations = new WeakMap<object, ProviderObservation>();

/** The configured adapter records its own response object, before parsing model text. */
export function recordProviderObservation(output: object, observation: ProviderObservation) {
  observations.set(output, observation);
}

export function providerObservation(output: CareerTaskModelOutput) {
  return typeof output === "object" ? observations.get(output) : undefined;
}

export function providerJournalFields(output: CareerTaskModelOutput, providerCallOrdinal: number) {
  const observation = providerObservation(output);
  return observation ? { providerObservation: observation, providerCallOrdinal } : {};
}
