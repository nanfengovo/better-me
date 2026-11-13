import { randomBytes } from "node:crypto";
import { privacyDigest } from "../privacy/content-guard.js";
import type { TwinAuthStamp } from "../candidate-twin/types.js";

export type CareerMcpScope = "career:facts:read" | "career:propose_evidence" | "career:match" | "capsule:read" | "capsule:ask";
export type CareerMcpAccess = TwinAuthStamp & {
  scopes: readonly CareerMcpScope[]; audience: string; expiresAt: string;
  capsule?: { id: string; hash: string };
  valid(): Promise<boolean>;
  /** One logical operation, separate from repeated authorization checks. */
  reserveCall?(): Promise<boolean>;
};
export class CareerMcpError extends Error { constructor(readonly code: string) { super(code); this.name = "CareerMcpError"; } }
type HeldToken = { stamp: TwinAuthStamp; scopes: CareerMcpScope[]; audience: string; expiresAt: string; capsule?: { id: string; hash: string }; revoked: boolean; remainingCalls: number };
const allScopes: readonly CareerMcpScope[] = ["career:facts:read", "career:propose_evidence", "career:match", "capsule:read", "capsule:ask"];

/** Short-lived opaque delegation only. Existing identity remains the authority.
 * Tokens are hashed in memory, never tool arguments/logs; restart revokes them.
 * Host authorization decides which scopes can be delegated for each user. */
export class CareerMcpTokens {
  private readonly tokens = new Map<string, HeldToken>();
  constructor(private readonly identity: { valid(stamp: TwinAuthStamp): Promise<boolean>; mayDelegate(stamp: TwinAuthStamp, scopes: readonly CareerMcpScope[]): Promise<boolean> }, private readonly now: () => number = Date.now) {}
  async issue(input: { auth: TwinAuthStamp; scopes: readonly CareerMcpScope[]; audience: string; expiresAt: string; maxCalls?: number; capsule?: { id: string; hash: string } }): Promise<{ token: string; tokenId: string; expiresAt: string }> {
    for (const [id, token] of this.tokens) if (token.revoked || Date.parse(token.expiresAt) <= this.now()) this.tokens.delete(id);
    if (!input.scopes.length || input.scopes.some(scope => !allScopes.includes(scope)) || new Set(input.scopes).size !== input.scopes.length || !Number.isSafeInteger(input.maxCalls ?? 50) || (input.maxCalls ?? 50) < 1 || (input.maxCalls ?? 50) > 1000 || !input.audience || input.audience.length > 2000 || /[\r\n]/.test(input.audience) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= this.now() || Date.parse(input.expiresAt) > this.now() + 3_600_000 || this.tokens.size >= 1000 || (input.scopes.some(scope => scope.startsWith("capsule:")) && (!input.capsule || !/^[a-f0-9]{64}$/.test(input.capsule.hash))) || !await this.identity.valid(input.auth) || !await this.identity.mayDelegate(input.auth, input.scopes)) throw new CareerMcpError("mcp_delegation_not_authorized");
    const token = randomBytes(32).toString("base64url"), tokenId = privacyDigest(token);
    this.tokens.set(tokenId, { stamp: structuredClone(input.auth), scopes: [...input.scopes], audience: input.audience, expiresAt: input.expiresAt, ...(input.capsule ? { capsule: structuredClone(input.capsule) } : {}), revoked: false, remainingCalls: input.maxCalls ?? 50 });
    return { token, tokenId, expiresAt: input.expiresAt };
  }
  async resolve(token: string, audience: string): Promise<CareerMcpAccess> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CareerMcpError("mcp_token_invalid");
    const held = this.tokens.get(privacyDigest(token));
    const valid = async () => !!held && !held.revoked && held.audience === audience && Date.parse(held.expiresAt) > this.now() && await this.identity.valid(held.stamp);
    if (!held || !await valid()) throw new CareerMcpError("mcp_token_invalid_or_revoked");
    return { ...structuredClone(held.stamp), scopes: [...held.scopes], audience: held.audience, expiresAt: held.expiresAt, ...(held.capsule ? { capsule: structuredClone(held.capsule) } : {}), valid, reserveCall: async () => { if (!await valid() || held.remainingCalls <= 0) return false; held.remainingCalls--; return true; } };
  }
  async revoke(tokenId: string, auth: TwinAuthStamp): Promise<void> {
    const token = this.tokens.get(tokenId);
    if (!token || token.stamp.ownerId !== auth.ownerId || !await this.identity.valid(auth)) throw new CareerMcpError("mcp_token_revocation_not_authorized");
    token.revoked = true;
  }
  invalidateSession(sessionId: string): void { for (const token of this.tokens.values()) if (token.stamp.sessionId === sessionId) token.revoked = true; }
}

export async function requireMcpScope(access: CareerMcpAccess, scope: CareerMcpScope, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CareerMcpError("mcp_cancelled");
  let valid: boolean;
  try { valid = await access.valid(); } catch { throw new CareerMcpError("mcp_authorization_unavailable"); }
  if (!valid || !access.scopes.includes(scope) || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) throw new CareerMcpError("mcp_scope_or_authorization_denied");
}
