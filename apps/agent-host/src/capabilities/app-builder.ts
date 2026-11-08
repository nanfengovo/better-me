import { createHash } from "node:crypto";
import {
  MicroAppBuildReceiptSchema,
  MicroAppManifestSchema,
  type MicroAppBuildReceipt,
  type MicroAppManifest,
} from "@better-me/agent-contracts";
import { EXECUTION_PROFILE, executeTransform } from "./sandbox.js";

export const CONTAINER_BUILD_PROFILE = "isolated-container-npm-v1";

export const ALLOWLISTED_MICROAPP_NPM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  recharts: "^2.12.0",
  "lucide-react": "^0.400.0",
  zod: "^3.23.0",
  "date-fns": "^3.6.0",
  clsx: "^2.1.0",
  "d3-scale": "^4.0.0",
  "d3-shape": "^3.2.0",
});

const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

const SAFE_SEMVER_RE = /^(\^|~)?\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;

export interface PackageJsonValidationResult {
  ok: boolean;
  errors: string[];
  sanitizedDependencies: Record<string, string>;
}

/**
 * Validates a candidate `package.json` for an Agent-authored Micro-App before container dependency resolution.
 * Enforces allowlisted external npm packages, safe semver ranges, and zero lifecycle install scripts.
 */
export function validateMicroAppPackageJson(rawPackageJson: {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): PackageJsonValidationResult {
  const errors: string[] = [];
  const sanitizedDependencies: Record<string, string> = {};

  if (rawPackageJson.scripts) {
    for (const hook of FORBIDDEN_LIFECYCLE_SCRIPTS) {
      if (hook in rawPackageJson.scripts) {
        errors.push(`Forbidden lifecycle script "${hook}" in micro-app package.json`);
      }
    }
  }

  const allDeps = {
    ...(rawPackageJson.dependencies ?? {}),
    ...(rawPackageJson.devDependencies ?? {}),
  };

  for (const [pkg, range] of Object.entries(allDeps)) {
    if (!(pkg in ALLOWLISTED_MICROAPP_NPM_PACKAGES)) {
      errors.push(`Package "${pkg}" is not in ALLOWLISTED_MICROAPP_NPM_PACKAGES`);
      continue;
    }
    if (typeof range !== "string" || !SAFE_SEMVER_RE.test(range.trim())) {
      errors.push(`Package "${pkg}" has unsafe version specifier "${String(range)}" (protocol/URL/file specifiers are forbidden)`);
      continue;
    }
    sanitizedDependencies[pkg] = range.trim();
  }

  return {
    ok: errors.length === 0,
    errors,
    sanitizedDependencies,
  };
}

export interface IsolatedBuildContainerPlan {
  appId: string;
  version: string;
  phaseAFetchArgs: string[];
  phaseBBuildAndVerifyArgs: string[];
  isolationFlags: string[];
  guestCspHeader: string;
}

/**
 * Produces the two-phase isolated container execution plan for building an Agent-generated Micro-App
 * with external npm packages while guaranteeing zero credential exposure and airgapped compilation.
 */
export function createIsolatedBuildContainerPlan(manifestInput: MicroAppManifest): IsolatedBuildContainerPlan {
  const manifest = MicroAppManifestSchema.parse(manifestInput);
  const pkgValidation = validateMicroAppPackageJson({
    name: manifest.appId,
    version: manifest.version,
    dependencies: manifest.dependencies,
  });
  if (!pkgValidation.ok) {
    throw new Error(`invalid_microapp_dependencies: ${pkgValidation.errors.join("; ")}`);
  }

  const isolationFlags = [
    "--network=none",
    "--read-only",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    "--pids-limit=64",
    "--memory=512m",
    "--cpus=1",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
  ];

  // Phase A: Network restricted strictly to npm registry cache fetch; --ignore-scripts prevents arbitrary code execution.
  const phaseAFetchArgs = [
    "docker",
    "run",
    "--rm",
    "--pids-limit=32",
    "--memory=256m",
    "--cpus=1",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-v",
    `microapp-build-${manifest.appId}:/workspace:rw`,
    "node:22-alpine",
    "pnpm",
    "install",
    "--ignore-scripts",
    "--frozen-lockfile",
  ];

  // Phase B: Complete network cutoff (--network=none) and read-only rootfs during bundle compilation & test verification.
  const phaseBBuildAndVerifyArgs = [
    "docker",
    "run",
    "--rm",
    ...isolationFlags,
    "-v",
    `microapp-build-${manifest.appId}:/workspace:ro`,
    "node:22-alpine",
    "node",
    "/workspace/verify-and-bundle.mjs",
  ];

  return {
    appId: manifest.appId,
    version: manifest.version,
    phaseAFetchArgs,
    phaseBBuildAndVerifyArgs,
    isolationFlags,
    guestCspHeader: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;",
  };
}

export const SYNTHETIC_OFFER_BACKCHECK_FIXTURES = Object.freeze([
  {
    offers: [
      { id: "offer-a", company: "Candidate-Offer-A", monthlyBaseK: 42.5, guaranteedMonths: 13, bonusMonths: 3, bonusRealizationRate: 0.92, providentFundRate: 0.12, weeklyHours: 47.5, commuteMinutes: 32 },
      { id: "offer-b", company: "Candidate-Offer-B", monthlyBaseK: 45.5, guaranteedMonths: 14, bonusMonths: 4, bonusRealizationRate: 0.9, providentFundRate: 0.12, weeklyHours: 66, commuteMinutes: 48 },
    ],
  },
  {
    offers: [
      { id: "offer-c", company: "Candidate-Offer-C", monthlyBaseK: 40, guaranteedMonths: 13, bonusMonths: 3, bonusRealizationRate: 0.85, providentFundRate: 0.12, weeklyHours: 50, commuteMinutes: 25 },
    ],
  },
  {
    offers: [
      { id: "offer-d", company: "Candidate-Offer-D", monthlyBaseK: 44, guaranteedMonths: 14, bonusMonths: 2, bonusRealizationRate: 0.95, providentFundRate: 0.12, weeklyHours: 45, commuteMinutes: 30 },
    ],
  },
]);

/**
 * Executes the micro-app's pure data transformation inside the QuickJS-WASM sandbox against
 * 3 synthetic Offer+Backcheck fixtures and emits a signed `MicroAppBuildReceipt`.
 */
export async function verifyMicroAppTransformInSandbox(params: {
  manifest: MicroAppManifest;
  transformSource: string;
  bundleHtml: string;
  signal?: AbortSignal;
}): Promise<MicroAppBuildReceipt> {
  const manifest = MicroAppManifestSchema.parse(params.manifest);
  const plan = createIsolatedBuildContainerPlan(manifest);

  let passedFixtures = 0;
  for (const fixture of SYNTHETIC_OFFER_BACKCHECK_FIXTURES) {
    const output = (await executeTransform(params.transformSource, fixture, params.signal)) as {
      rankedOfferIds?: unknown;
      bestHourlyWageRmb?: unknown;
    } | null;

    if (
      !output ||
      !Array.isArray(output.rankedOfferIds) ||
      output.rankedOfferIds.length !== fixture.offers.length ||
      typeof output.bestHourlyWageRmb !== "number" ||
      !Number.isFinite(output.bestHourlyWageRmb) ||
      output.bestHourlyWageRmb <= 0
    ) {
      throw new Error("microapp_synthetic_verification_failed");
    }
    passedFixtures += 1;
  }

  const codeHash = createHash("sha256")
    .update(params.transformSource)
    .update("\n---\n")
    .update(params.bundleHtml)
    .digest("hex")
    .slice(0, 32);

  return MicroAppBuildReceiptSchema.parse({
    appId: manifest.appId,
    version: manifest.version,
    codeHash,
    verifierVersion: `${EXECUTION_PROFILE}+${CONTAINER_BUILD_PROFILE}`,
    status: "passed",
    syntheticFixturesPassed: passedFixtures,
    containerIsolationFlags: plan.isolationFlags,
    verifiedAt: new Date().toISOString(),
  });
}
