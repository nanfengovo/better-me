import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createControlledSourceTransport, createGoogleDohResolver, CareerWebSearchConfigSchema, createCareerWebSearchProvider, createFxReferenceProvider, type CareerWebSearchConfig } from "@better-me/source-adapters";
import { createJobApplication } from "./application.js";
import { createJobHttpServer, type JobHttpOptions } from "./http.js";
import { openJobRepository, type JobRepository } from "./repository.js";
import { createNominatimOfficeProvider, createPhotonOfficeProvider, OfficeGeocoderConfigSchema, type OfficeGeocoderConfig } from "./office-address-provider.js";

export class LocalJobServiceError extends Error {
  constructor(public readonly code: "invalid-config" | "data-directory-unavailable" | "data-directory-busy" | "invalid-lock" | "lock-ownership-changed" | "invalid-token" | "startup-failed" | "shutdown-failed", message: string) {
    super(message);
    this.name = "LocalJobServiceError";
  }
}
export type JobServiceConfig = {
  dataDirectory: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  allowedOrigins: readonly string[];
  dns?: "system" | "google-doh";
  careerSearch?: CareerWebSearchConfig;
  officeGeocoder?: OfficeGeocoderConfig;
};
export type ValidatedJobServiceConfig = Required<Omit<JobServiceConfig, "careerSearch" | "officeGeocoder">> & Pick<JobServiceConfig, "careerSearch" | "officeGeocoder">;
export function validateJobServiceConfig(config: JobServiceConfig): ValidatedJobServiceConfig {
  if (typeof config.dataDirectory !== "string" || !isAbsolute(config.dataDirectory) || config.dataDirectory.includes("\0")) throw new LocalJobServiceError("invalid-config", "Choose an explicit absolute data directory.");
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 5178;
  const dns = config.dns ?? "system";
  const careerSearch = config.careerSearch === undefined ? undefined : CareerWebSearchConfigSchema.safeParse(config.careerSearch);
  if (careerSearch && !careerSearch.success) throw new LocalJobServiceError("invalid-config", "Invalid career search configuration. Choose a supported provider and its permitted endpoint options.");
  const officeGeocoder = config.officeGeocoder === undefined ? undefined : OfficeGeocoderConfigSchema.safeParse(config.officeGeocoder);
  if (officeGeocoder && !officeGeocoder.success) throw new LocalJobServiceError("invalid-config", "Office geocoding supports only the explicitly enabled nominatim or photon provider.");
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535 || !["system", "google-doh"].includes(dns)) throw new LocalJobServiceError("invalid-config", "Invalid loopback listener or DNS configuration.");
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) throw new LocalJobServiceError("invalid-config", "Configure at least one exact UI origin.");
  for (const origin of config.allowedOrigins) {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password || parsed.hostname.includes("*")) throw new Error();
    } catch { throw new LocalJobServiceError("invalid-config", "UI origins must be exact HTTP(S) origins without a path or wildcard."); }
  }
  return { dataDirectory: resolve(config.dataDirectory), host, port, allowedOrigins: [...new Set(config.allowedOrigins)], dns, ...(careerSearch?.success ? { careerSearch: careerSearch.data } : {}), ...(officeGeocoder?.success ? { officeGeocoder: officeGeocoder.data } : {}) };
}

const LOCK_NAME = ".job-service.lock";
const TOKEN_NAME = "service.token";
type LockOwner = { schemaVersion: 1; pid: number; owner: string; hostname: string; createdAt: string };
function filesystemCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String(error.code) : undefined; }
function busy(): LocalJobServiceError { return new LocalJobServiceError("data-directory-busy", "This data directory has an active or unverified service owner. No process was stopped."); }
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return filesystemCode(error) !== "ESRCH"; }
}
async function readOwner(lockPath: string): Promise<LockOwner> {
  try {
    const directory = await lstat(lockPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
    const metadata = await lstat(join(lockPath, "owner.json"));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
    const handle = await open(join(lockPath, "owner.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2048) throw new Error();
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object") throw new Error();
      const owner = value as Record<string, unknown>;
      if (owner.schemaVersion !== 1 || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.owner !== "string" || !/^[a-f0-9-]{36}$/.test(owner.owner) || typeof owner.hostname !== "string" || !owner.hostname || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))) throw new Error();
      return owner as LockOwner;
    } finally { await handle.close(); }
  } catch { throw new LocalJobServiceError("invalid-lock", "The existing service lock cannot be verified. Preserve it for inspection."); }
}
function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.owner === right.owner && left.pid === right.pid && left.hostname === right.hostname && left.createdAt === right.createdAt;
}
async function writeOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const handle = await open(join(lockPath, "owner.json"), "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
export type DataDirectoryLock = { dataDirectory: string; lockPath: string; release: () => Promise<void> };

/** Atomic directory ownership. A stale owner is quarantined only after a single reclaimer verifies its dead PID again. */
export async function acquireDataDirectoryLock(dataDirectory: string, options: { processAlive?: (pid: number) => boolean; machineName?: string } = {}): Promise<DataDirectoryLock> {
  if (!isAbsolute(dataDirectory)) throw new LocalJobServiceError("invalid-config", "Choose an explicit absolute data directory.");
  let directory: string;
  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(dataDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error();
    directory = await realpath(dataDirectory);
  } catch { throw new LocalJobServiceError("data-directory-unavailable", "Choose an available private data directory without a symbolic link; POSIX permissions must exclude other users."); }
  const lockPath = join(directory, LOCK_NAME);
  const probe = options.processAlive ?? isProcessAlive;
  const machine = options.machineName ?? hostname();
  const owner: LockOwner = { schemaVersion: 1, pid: process.pid, owner: randomUUID(), hostname: machine, createdAt: new Date().toISOString() };
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (filesystemCode(error) !== "EEXIST") throw new LocalJobServiceError("data-directory-unavailable", "The service lock could not be created.");
    const previous = await readOwner(lockPath);
    if (previous.hostname !== machine || probe(previous.pid)) throw busy();
    const claim = join(lockPath, ".reclaim");
    try { await mkdir(claim, { mode: 0o700 }); }
    catch { throw busy(); }
    const claimIdentity = await lstat(claim);
    if (!claimIdentity.isDirectory() || claimIdentity.isSymbolicLink()) throw busy();
    // A guard left at the same pathname is not necessarily ours after a replacement.
    // Its directory identity and unique owner both have to survive every retry/cleanup.
    await writeOwner(claim, owner);
    const ownsClaim = async () => {
      const identity = await lstat(claim);
      return identity.isDirectory() && !identity.isSymbolicLink() && identity.dev === claimIdentity.dev && identity.ino === claimIdentity.ino
        && sameOwner(await readOwner(claim), owner);
    };
    try {
      const quarantine = join(directory, `.job-service-stale-${previous.owner}-${randomUUID()}`);
      for (let attempt = 0; ; attempt++) {
        const current = await readOwner(lockPath);
        if (!sameOwner(current, previous) || current.hostname !== machine || probe(current.pid) || !await ownsClaim()) throw busy();
        try {
          // Windows may briefly refuse a directory rename while losing contenders
          // finish reading the old owner. Keep the guard and revalidate before retrying.
          await rename(lockPath, quarantine);
          break;
        } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(filesystemCode(error) ?? "") || attempt >= 5) throw busy();
          await delay(10 * 2 ** attempt);
        }
      }
      try { await mkdir(lockPath, { mode: 0o700 }); }
      catch { throw busy(); }
    } catch (error) {
      // A competing owner may now hold lockPath. Never remove its files or its reclaim guard.
      const current = await readOwner(lockPath).catch(() => undefined);
      if (current && sameOwner(current, previous) && await ownsClaim().catch(() => false)) {
        const files = await readdir(claim).catch(() => []);
        if (files.length === 1 && files[0] === "owner.json") {
          await unlink(join(claim, "owner.json")).then(() => rmdir(claim)).catch(() => undefined);
        }
      }
      throw error;
    }
  }
  try { await writeOwner(lockPath, owner); }
  catch {
    // A partial owner file remains conservative evidence; do not guess whether it is safe to erase.
    throw new LocalJobServiceError("invalid-lock", "Service ownership metadata could not be written completely.");
  }
  let released = false;
  return { dataDirectory: directory, lockPath, release: async () => {
    if (released) return;
    const current = await readOwner(lockPath);
    if (!sameOwner(current, owner)) throw new LocalJobServiceError("lock-ownership-changed", "Service lock ownership changed; the lock was preserved.");
    const files = await readdir(lockPath);
    if (files.length !== 1 || files[0] !== "owner.json") throw new LocalJobServiceError("lock-ownership-changed", "Unexpected lock files were preserved for inspection.");
    await unlink(join(lockPath, "owner.json"));
    await rmdir(lockPath);
    released = true;
  } };
}

/** Reuses a private local credential. No caller receives it in a public service handle or log. */
export async function loadOrCreateServiceToken(dataDirectory: string): Promise<{ token: string; tokenPath: string }> {
  const tokenPath = join(dataDirectory, TOKEN_NAME);
  try {
    const handle = await open(tokenPath, "wx", 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (filesystemCode(error) !== "EEXIST") throw new LocalJobServiceError("invalid-token", "The local service token could not be created.");
  }
  try {
    const stat = await lstat(tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error();
    const handle = await open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let token: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 256) throw new Error();
      const raw = await handle.readFile("utf8");
      if (!/^[A-Za-z0-9_-]{43,128}\n?$/.test(raw)) throw new Error();
      token = raw.trimEnd();
    } finally { await handle.close(); }
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
    return { token, tokenPath };
  } catch { throw new LocalJobServiceError("invalid-token", "The existing local service token is invalid; it was preserved."); }
}

type Application = Pick<ReturnType<typeof createJobApplication>, "registry" | "shutdown">;
type HttpListener = Pick<ReturnType<typeof createJobHttpServer>, "listen" | "close">;
export type JobServiceDependencies = {
  openRepository?: (path: string) => JobRepository;
  createApplication?: (options: Parameters<typeof createJobApplication>[0]) => Application;
  createHttpServer?: (options: JobHttpOptions) => HttpListener;
};
export type LocalJobServiceHandle = {
  url: string; port: number; dataDirectory: string; databasePath: string; tokenPath: string;
  allowedOrigins: readonly string[]; dns: "system" | "google-doh"; recoveredRuns: number;
  close: () => Promise<void>;
};
export async function startLocalJobService(input: JobServiceConfig, dependencies: JobServiceDependencies = {}): Promise<LocalJobServiceHandle> {
  const config = validateJobServiceConfig(input);
  const lock = await acquireDataDirectoryLock(config.dataDirectory);
  let repository: JobRepository | undefined;
  let application: Application | undefined;
  let http: HttpListener | undefined;
  let listening = false;
  let httpStopped = false;
  let applicationStopped = false;
  let repositoryClosed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const results = await Promise.allSettled([
        listening && !httpStopped ? Promise.resolve().then(() => http!.close()).then(() => { httpStopped = true; }) : Promise.resolve(),
        application && !applicationStopped ? Promise.resolve().then(() => application!.shutdown()).then(() => { applicationStopped = true; }) : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new LocalJobServiceError("shutdown-failed", "The service did not finish draining. Its database and ownership lock were preserved.");
      if (repository && !repositoryClosed) { repository.close(); repositoryClosed = true; }
      await lock.release();
    })().catch((error: unknown) => { closing = undefined; throw error; });
    return closing;
  };
  try {
    const { token, tokenPath } = await loadOrCreateServiceToken(lock.dataDirectory);
    const databasePath = join(lock.dataDirectory, "jobs.sqlite");
    repository = (dependencies.openRepository ?? openJobRepository)(databasePath);
    // Recovery cannot classify a still-running owner's work as interrupted: the lock is already exclusive.
    const recovered = await repository.recoverInterruptedRuns();
    const transport = createControlledSourceTransport({ ...(config.dns === "google-doh" ? { resolve: createGoogleDohResolver() } : {}) });
    application = (dependencies.createApplication ?? createJobApplication)({ repository, transport,
      fxReferenceProvider: createFxReferenceProvider(transport),
      ...(config.officeGeocoder ? { officeAddressProvider: config.officeGeocoder.provider === "photon" ? createPhotonOfficeProvider(transport) : createNominatimOfficeProvider(transport) } : {}),
      ...(config.careerSearch ? { careerWebSearchProvider: createCareerWebSearchProvider(config.careerSearch) } : {}) });
    http = (dependencies.createHttpServer ?? createJobHttpServer)({ registry: application.registry, token, allowedOrigins: config.allowedOrigins, host: config.host, port: config.port });
    const address = await http.listen();
    listening = true;
    return { ...address, dataDirectory: lock.dataDirectory, databasePath, tokenPath, allowedOrigins: config.allowedOrigins, dns: config.dns, recoveredRuns: recovered.recovered, close };
  } catch (error) {
    await close();
    if (error instanceof LocalJobServiceError) throw error;
    throw new LocalJobServiceError("startup-failed", filesystemCode(error) === "EADDRINUSE" ? "The configured service address is already in use. No listener was stopped." : "The local job service could not start. Existing data and credentials were preserved.");
  }
}
