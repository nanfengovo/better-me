export class AtlasClientError extends Error {
  constructor(public readonly code: "invalid-endpoint" | "missing-token" | "http-error" | "too-large" | "invalid-response", message: string) {
    super(message);
    this.name = "AtlasClientError";
  }
}
