/** Local browser and service use the same clock; expired IDs cannot create a new page. */
export const JD_START_REQUEST_WINDOW_MS = 120_000;
export const JD_START_REQUEST_FUTURE_SKEW_MS = 5_000;

export function isJdStartRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{8,12}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function jdStartRequestCreatedAt(value: string): number {
  if (!isJdStartRequestId(value)) return NaN;
  const time = Number.parseInt(value.slice(0, value.indexOf("_")), 36);
  return Number.isSafeInteger(time) ? time : NaN;
}

export function createJdStartRequestId(): string {
  return `${Date.now().toString(36)}_${crypto.randomUUID()}`;
}
