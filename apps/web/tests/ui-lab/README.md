# Atlas UI isolated acceptance lab

This fixture mounts the real `AtlasWorkspace`, its compute Worker, real query path and MapLibre canvas. All job records, companies, addresses and source links are synthetic. It does not mount the resume editor or real dev brokers; Agent Companion is an opt-in UI-only fixture described below. UI changes and query-index activation remain separate: do not rebuild workspace package `dist` files while using this fixture for this UI-only comparison.

From the repository root:

```sh
pnpm --filter @better-me/web exec vite --config tests/ui-lab/vite.config.ts
```

Open in a **new, independently owned browser context**, never the user's existing page:

- `http://127.0.0.1:5186/tests/ui-lab/index.html?size=5000`
- `http://127.0.0.1:5186/tests/ui-lab/index.html?size=15000`
- Add `scenario=empty`, `scenario=unlocated`, `scenario=attention` or `scenario=loading`.
- Add `theme=dark`; `controls=hidden` removes test controls but keeps the synthetic-data disclosure.

The server is loopback-only, requires its own synthetic session token and never proxies API requests. A CSP allows connections only to its own origin and the application's existing public OpenFreeMap/OSM map hosts. Calls to real job/AI services are blocked. Sessions and changes live only in this Vite process's memory. Closing it discards synthetic state. Public geography assets come from the repository. Public map tile availability remains a network dependency; use the real UI's “地图与连接 → 地图与街道底图 → 本地概览” setting for an explicitly offline comparison, never mislabel that as the online-basemap result.

Open scenarios are not evicted when another tab starts. Closing or reloading an owned lab page releases its synthetic session with a keepalive request (bfcache pagehide retains it). HMR is disabled. After editing this Vite configuration or its server-side dataset module, explicitly restart **only the owned lab server**; do not assume server code has refreshed just because disk tests pass. The restart invalidates synthetic sessions: discard the affected measurement and reload owned lab pages before starting a fresh run.

## QA inventory, before browser sign-off

### Cesium engine and original local 3D Tiles fixture

The lab also serves the production Cesium static-assets plugin. Select `3D` view
and then `三维地球` to exercise the real SDK without a Google or ion account.
The local Natural Earth II texture is an overview, not satellite photography.

For an actual tileset load, use `实景 3D → 自有 / 获准使用的 3D Tiles`:

- URL: `http://127.0.0.1:5188/__atlas-ui-lab/3d-fixture/tileset.json`
- Attribution: `BetterMe 原创合成测试网格 · 非上海实景`
- Confirm permission, then load. Substitute the actual lab port if different.

This is an original synthetic box at the synthetic address near 121.34 / 31.12,
not a surveyed building or evidence of Shanghai coverage. Select an address and
open its JD; use the detail's map-location action to inspect the local mesh.
`/__atlas-ui-lab/3d-fixture/quota.json` returns HTTP 429 for the actionable-error
and explicit-retry path. No external model, CLI, job database or Google request
is necessary. The lab CSP deliberately blocks Google: use a separately authorized
environment for real coverage, credentials, billing and supplier performance QA.

The toolbar's `开始性能记录` / `结束性能记录` buttons expose metrics as visible
JSON, so UI automation need not invoke instrumentation through page evaluation.
The report counts Cesium canvases separately from MapLibre canvases. In streaming
tests also inspect whether list/query results actually settle; a high average
rAF cadence cannot excuse multi-second long tasks or a missing list. Neither
this fixture nor CPU marker benchmarks imply a Google scene FPS/INP pass.

### Flexible workbench and generated Agent artwork

The real Atlas pane handles, splitters, presets and focus controls are included
in the normal lab. Add `&companion=1` to show the actual Agent Companion with four
synthetic runtime entries and generated artwork. `companion-fixture.ts` intercepts
only the Agent service URL, returns runtime-list GETs locally, and rejects every
CLI/chat/write request without forwarding it. CSP also excludes real local
services. Never run these flows in an existing user tab.

The layout and artwork validation report is
`docs/reports/job-atlas-flex-brand-2026-10-28.md`. Continuous-increment query
settling is tracked there as a separate, not-yet-resolved verification finding.

| Claim | Functional and visual checks |
| --- | --- |
| Large result lists stay usable | For both sizes, type C#, clear, type Python; switch country/region and open/close filters; inspect first page/counts, no duplicate rows, pagination and detail/Escape. |
| Automatic list/map updates | Click “开始合成增量”; each two seconds adds 10 synthetic jobs (maximum 60 batches, approximately120 seconds) and changes one synthetic coordinate. The real background-status poll observes revisions and the Worker fetches real delta envelopes. Wait until an actual first revision advance and working status are visible before starting metrics; require at least three distinct observed revisions during actual typing/filter/map interactions. Stop via the lab button. |
| State-motion semantics | Trigger “模拟补全异常” then “恢复正常”; wait for production polling (initial idle cadence may be 5s+). Inspect icon/state transition, readability and count stability. Never interpret these as real collection results. |
| Spatial controls | Pointer 2D→3D→2D, keyboard activation, map pan/zoom/address selection. Confirm one canvas; inspect transition midway and after settle. |
| Empty/error resilience | Separate `empty`, `unlocated`, `attention`, `loading` URLs. No result is not an error; no address is not zero jobs; synthetic background failure retains usable rows. |
| Accessibility/responsiveness | Light/dark at 1600×900, 1280×800, and 390×844 touch; focus order, keyboard action, text contrast, no horizontal document overflow. Reduced-motion context: repeat state and map changes, ensure no continuous motion. |
| Asset correctness | Generated assets are decoded, with reserved dimensions and correct state, do not cover functional controls; fail an illustration request and verify text/actions remain. |
| Background behavior | In an owned context only, hide/show the tab or emulate reduced motion; no fake progress or runaway motion. Do not use a hidden measurement as an FPS pass. |

## Measurement API

`window.__atlasUiLab` is inspection/instrumentation only. Interactions used for acceptance must be real Playwright pointer, keyboard or touch actions.

```js
await page.evaluate(() => window.__atlasUiLab.metrics.start("15000, streaming, pointer + keyboard"));
// Perform actual user interactions and allow final rendering/event observers to settle.
const report = await page.evaluate(() => window.__atlasUiLab.metrics.stop());
const syntheticService = await page.evaluate(() => window.__atlasUiLab.state());
```

Reports include visible-window validity, requestAnimationFrame cadence, frame gaps, observed Event Timing interactions, >50ms long tasks, DOM cardinality and viewport. They do **not** automatically assert a pass. Frame cadence is not GPU frame presentation. Event Timing uses the browser's 16ms minimum observer threshold; absent entries are reported as `null`, not zero. `maximumObservedDurationMs` and `p98ObservedDurationMs` are **laboratory interaction-duration proxies, not field INP**. Record browser/GPU/viewport, cold vs warmed map state, actual interaction script and synthetic update counts next to numbers. Do not extrapolate a brief local run into a production-user INP claim.

The startup dataset is 5,000 or 15,000 jobs with one company/location per job, valid source/evidence/snapshot rows, compact synthetic salary descriptions, two searchable cities and four role patterns. One quarter of initial jobs have synthetic address coordinates; those coordinates are explicitly test evidence only. Streamed records increment the initial count; record both starting and final counts.

The synthetic stream is bounded to60 batches (600 added jobs). Normal polling receives deltas; a cursor that missed enough batches to exceed the production4096-entity delta bound receives an explicit `delta-too-large` baseline. Do not count a run that starts measuring only after the stream finishes as a concurrent-update pass.

Focused fixture contract tests:

```sh
pnpm exec tsx --test apps/web/tests/ui-lab/data.test.ts
```

## Optional production-bundle comparison (separate port 5190)

This comparison does not change the development lab on5186 or the user's application on5173. Wait until the intended UI source changes are complete, then build **only this Vite fixture**. Do not run workspace/root build commands or rebuild `packages/*/dist`: query-index activation must remain independent.

From the repository root:

```sh
pnpm --filter @better-me/web exec vite build --config tests/ui-lab/production.config.ts --mode production
node apps/web/tests/ui-lab/verify-production.mjs
pnpm --filter @better-me/web exec vite preview --config tests/ui-lab/production.config.ts --host 127.0.0.1 --port 5190 --strictPort
```

Then use a new owned browser page:

- `http://127.0.0.1:5190/tests/ui-lab/index.html?size=5000`
- `http://127.0.0.1:5190/tests/ui-lab/index.html?size=15000`

The preview serves compiled static production React bundles while adapting the same synthetic API/CSP hook to Vite's preview server. `__ui-lab-build.json` records build time, production mode and the existing opportunities runtime hash. `verify-production.mjs` checks production entry files for development clients/`jsxDEV` markers and checks that runtime hash. Neither command is a performance pass; report development and production browser numbers separately. Hidden source maps are available for profiling but are not linked into loaded scripts. Assets go only to `output/atlas-ui-lab-production`; existing output is not destructively emptied. Rebuild and verify after any further UI edit before collecting production results.

## Harvest status clarity fixture (no API/session needed)

`/tests/ui-lab/harvest-clarity.html` mounts the real `AtlasHarvestProgress`, `AtlasLiveHarvestResults` and `AtlasBackgroundEnrichmentStatus`, with the actual Atlas styles and theme provider. Unlike the large-library lab, it never creates a synthetic service session, polls an API, starts a collector, mounts a resume editor or loads a map. It is safe to serve with the isolated lab Vite configuration; do not point an existing user page at it.

Default state reproduces independent synthetic counters: discovered1220, successful-input receipts1122, unconfirmed15. The four source states cover explicit51JOB timeout, Liepin page budget, ready BOSS with unconfirmed scrolling progress, and ready LinkedIn with partial pagination failure. All1220 source cards exist in the fixture; the real list renders its normal50-card page. The first three cards have different source labels. All source URLs use `example.invalid`, and clicking a source link is intercepted inside the fixture rather than opening an external page.

Use the sidebar buttons for partial, login-required, verification-required, unknown-reason, explicit `queryTermError`, ingestion-receipt timeout, completed, cancelled and running states. “继续采集” and “平台登录／验证” callbacks only update the visible fixture action output; “停止采集” changes this local fixture to cancelled while preserving cards. Background controls independently select working, done, error or no state. There are600px/380px pane buttons and a theme toggle; on viewports≤760px the pane takes available width and controls move below it.

Query parameters: `scenario=partial|login|verification|unknown|query-error|import-error|success|cancelled|running`, `width=380`, `theme=dark`, and optional `height=600`. Height accepts integer CSS pixels from320–1600; omitted or invalid values preserve the viewport-relative default. An explicit height applies to the actual product pane, including narrow/mobile layouts, without changing product typography or internal scrolling. For example, `http://127.0.0.1:5186/tests/ui-lab/harvest-clarity.html?scenario=partial&height=600` when the isolated lab is explicitly started by the operator.

`scenario=import-error&height=600` isolates a real `importFailures` prop:15 unconfirmed51JOB cards with a30-second ingestion-receipt timeout, while source reading is successful. It retains discovered1220 and successful receipts1122 as independent evidence; the fixture does not interpret their difference as a queue. Its source cards/receipts are internally consistent (51JOB15, Liepin837, BOSS269, LinkedIn99), and it never uses `provider.error` to represent a write failure. The separate default `partial` scenario retains the original source-page failures unchanged.

Acceptance checks are scoped to `[data-clarity-live-pane]`, not the lab controls: at a900px-tall desktop viewport the main cause and first card should be visible; progress/source details start closed while counts remain; expand/collapse must not lose facts; verify44px mobile targets, focus and no horizontal document overflow. This fixture deliberately does not override product typography, target sizes, status spacing or component detail disclosure. Readable text and viewport assertions need a real browser pass; merely mounting these components is not sign-off.
