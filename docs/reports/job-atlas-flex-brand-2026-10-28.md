# Atlas flexible workbench and generated Agent artwork — 2026-10-28

## Scope and safety

Two independent presentation changes: generated Agent brand-inspired artwork,
and a UI-only Atlas pane layout. No collection, query-index, database schema,
resume state or animation-system changes. Preserve the existing 5173 browser
session and all running services. Verify using synthetic isolated 5186 fixtures.

## Design review

| Before | After | Why |
| --- | --- | --- |
| Small generic runtime glyphs | Four transparent 3D brand-inspired illustrations, visible names, vector fallback | Recognizable tools without a runtime image-generation dependency |
| Fixed map/list/JD proportions | Explicit pane handles, constrained splitters and three presets | Fit browsing, mapping and JD reading without overlapping windows |
| Detail or mobile pane can obscure the map | Inline detail pane, optional focus and stack modes | Keep map, jobs and JD available together |
| Layout choices are transient | Versioned UI-only local preference and reset | Recover a comfortable layout without touching jobs or resume storage |

## QA inventory (written before browser testing)

| Claim / control | Functional check | Visual state / evidence |
| --- | --- | --- |
| Four 3D runtime icons actually used | Successful local WebP loads in real Companion; no AI/CLI requests | Light/dark console with tools expanded; all four 42px tiles visible |
| Missing art is non-blocking | Image error falls back to SVG/terminal; switching runtime recovers | Automated fallback test and owned-browser failed-image state |
| Map + jobs + JD together | Select a job; all three panes remain mounted | Desktop 1451 x 1273, actual Atlas map and JD |
| Width and height drag | Pointer drag and keyboard arrows, minimum clamps, double-click/Enter reset | During drag, after resize, narrow panes and stack mode |
| Stable state and fast hot loop | No map remount, no list scroll loss, no child renders or query call per pointermove | Unit probes and real 5000/15000 synthetic data |
| Reorder via handle / keyboard / menu | Pointer reorder, Alt+arrow and menu action, then restore | Pane heading and drop-target/ghost, resulting order |
| Focus and restore | Focus each pane, then restore; no data reset | Focused map / jobs / JD and restored layout |
| Presets and stack | Balanced, map-first, JD reading, rows and back | Widths respond, readable JD and unclipped controls |
| Persistence and reset | Owned fixture reload retains layout; reset defaults | No changes to other localStorage keys |
| Narrow, medium, dark and reduced motion | 390/1024/1451 widths; rows below minimum width | Viewport + pane bounds, scrolling is intentional on narrow screens |
| Cancellation / interruption | Escape, pointercancel/lost capture, secondary pointer, unmount mid-drag | No stuck ghost, capture, cursor, or saved cancelled layout |
| Storage failure / bad preference | Corrupt JSON defaults; quota failure preserves in-memory interaction | Actionable non-blocking storage message |
| Collection remains independent | Synthetic increment while adjusting panes and filtering | Updated list/map, no calls to real services |

Exploratory cases: open/close JD while resized; change viewport mid-drag; reorder
with hidden JD; operate nested list/MapLibre controls after drag; failed WebP;
read long JD in a constrained pane. Numeric checks supplement visual review.

## Artwork provenance

Generated with the **built-in GPT image-generation tool**, four separate calls.
These are AI-generated brand-inspired illustrations, not official logos or
endorsements. All source prompts are in
`apps/web/public/agent-icons/generated-prompts.json`. Genuine alpha transparency
was retained in 256 x 256 WebP. Total bytes: 40,582. Masters are kept in the Codex
generated-images directory, not bundled into the application.

- `claude-code-3d-v1.webp`: terracotta beveled pixel crab, 15,390 bytes.
- `opencode-3d-v1.webp`: graphite extruded open frame, 6,810 bytes.
- `gemini-cli-3d-v1.webp`: blue-violet four-point glass/ceramic star, 9,634 bytes.
- `codex-3d-v1.webp`: forest-green terminal tile, 8,748 bytes.

Images are decorative next to visible tool/model names. Gemini model status uses
the Gemini artwork; unrelated model providers do not inherit a misleading Codex
image. Image failure uses deterministic local vectors or an abstract terminal.

## Interaction references

[WAI window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
informs separator labels, orientation, controls and numeric values. Arrow keys
adjust, Shift increases the step, Home/End clamp, Enter restores the size (the
repository's existing splitter convention). This is not a full accessibility
certification. [Pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
keeps the active drag attached to its handle outside its bounds.

## Verification results (2026-10-28 through 2026-10-29)

- Focused artwork / layout / existing toolbar / readability / Companion suite:
  **33 passed**, no failures. Includes a red-then-green Escape listener-order
  regression and a viewport-resize/release race regression.
- Complete `atlas-workspace.test.tsx`: **78 passed**. Existing source collection,
  background enrichment, snapshot refresh, location review, double-click and
  selection recovery remain covered. Presentation structure expectations were
  updated for the new stable pane wrappers, not bypassed.
- Web TypeScript `--noEmit --incremental false`: passed in the isolated checkout.
- New presentation modules and Agent icon wiring: focused ESLint passed. The
  existing large `AtlasWorkspace.tsx` has **6 errors and 1 warning**, reproduced
  unchanged in the original main checkout before integration (empty catches,
  a pre-existing Boolean cast and harvestRecovery dependency warning). This is
  not an all-repository lint or build sign-off.

### Real browser checks

Used an owned Chrome context and the existing fail-closed synthetic lab on 5186.
No user browser context, cookies, resume or job-service endpoint was used.
Actual map renderer, Worker, list and JD components were exercised.

| Dataset | Layout-only query count | Map/list identity | Observed interaction smoke sample |
| --- | --- | --- | --- |
| 5,000 jobs | page queries **1 -> 1** | Both retained; actual list scroll **220 -> 220** after pointer reorder | 0.60s sample, max observed Event Timing 48ms, 0 long tasks |
| 15,000 jobs | page queries **2 -> 2** | Both retained through resize, presets, focus and restore | 1.06s sample, 11 observed interactions, max 56ms, 0 long tasks |

These are short foreground laboratory smoke windows, **not field INP, a
GPU-presented FPS benchmark, or a general performance guarantee**. rAF p95 gaps
were 16.7ms and 16.6ms respectively. Results depend on this machine and synthetic
data. No query-index or collection implementation was changed.

Also checked:

- Pointer reorder with a visible drop target/ghost, keyboard Alt+arrows and the
  pane options menu; width and height adjustments, presets, every pane's
  focus/restore cycle, stack/side-by-side and reset.
- Escape restores both geometry and separator ARIA values without closing an
  already mounted JD. Secondary pointers, capture loss and unmount cannot save a
  half-completed gesture. A viewport resize immediately before release now also
  cancels without saving, even before ResizeObserver's notification.
- Owned-page reload retained row order and map height **584px**; reset restored
  defaults. Only `better-me:atlas-workbench:v1` stores layout data; no resume or
  job data is persisted by this module.
- Desktop 1451x1273, medium 1024x1000 and touch/reduced-motion 390x844. No document
  horizontal overflow. Narrow screens intentionally stack and vertically scroll;
  JD remains an inline relative pane, not an overlay. Map and JD focus states
  were separately inspected. Dragging/resizing is constrained to keep controls
  and content usable, not an unrestricted floating desktop.
- Light/dark actual Companion: all four WebP images loaded at intrinsic 256px,
  displayed in 42px badges with `object-fit: contain`, and were non-draggable.
  Dark badges received a light neutral backing so graphite OpenCode art does not
  disappear. Gemini model status uses matching artwork. Blocking the OpenCode
  WebP in the owned mobile context produced its SVG fallback while the other
  three images loaded successfully. Mock Agent calls were runtime-list GETs only;
  no CLI, chat, real model or resume requests were sent.
- Exploratory pass covered opening JD, changing presets at minimum widths,
  scrolling the list, reordering, entering/leaving focus, changing window size
  mid-drag and using the actual MapLibre pan controls afterward. No stuck drag
  ghost, duplicated canvas, modal obstruction or browser page errors was found.

### Separate finding: continuous-increment search settling

The 15,000-job lab added 10 synthetic jobs every 2 seconds. A search for C# stayed
`aria-busy=true` beyond a **15-second wait budget** while revisions continued.
The test was not marked passing. Existing cards remained readable. After stopping
at **15,540 jobs / revision 55**, the query settled normally with matching C#
cards, no errors, and no data loss. This is a **separate query/sync scheduling
investigation**, not fixed or hidden inside this presentation change.

The 95.76s diagnostic window around that attempt observed 7 main-thread long
tasks (504ms total, maximum 98ms) and just one qualifying Event Timing entry.
It is insufficient for an INP claim. Do not describe the full continuously
updating search pipeline as performance-certified based on this UI pass.

First pointer reading of a previously closed JD retains the existing 520ms
double-click decision window (now also on desktop because the optional third
column can move the card). Keyboard reading is immediate, as is changing jobs
when a reading pane is already open. This avoids broken double-click location
actions without keeping an empty third column permanently visible.

### Evidence

Owned-browser evidence directory:
`/Users/feng/Documents/Private/简历/atlas-flex-brand-qORHmm/`.

- `desktop-15000-three-panes.jpg`, `medium-1024.jpg`.
- `agent-3d-light.jpg`, `agent-3d-dark.jpg`.
- `mobile-initial-390.jpg`, `mobile-map-focus.jpg`, `mobile-jd-focus.jpg`.
- `reorder-in-progress.jpg`, `browser-evidence.json`.

## Safe main-project integration

Integrated **22 explicitly whitelisted files** (18 text files and 4 WebP assets).
Byte comparison confirmed they matched the verified staging checkout. No package
installation, workspace build, query-index activation or server restart was used.
All **105 existing opportunities runtime files** remained byte-identical to the
pre-change staging copy. Existing unrelated worktree edits were preserved.

Main-project verification after integration:

- Complete workspace regression: **78/78 passed**.
- Focused presentation/Companion/readability suite: **33/33 passed**.
- Web TypeScript no-emit check: passed.
- Focused ESLint for the new modules, manifest and Companion wiring: passed.
  The large workspace file's pre-existing 6 errors / 1 warning remain documented
  above; no full-repository lint/build certification is claimed.
- Read-only GETs returned 200 for the main 5173 entry, both new TSX modules and all
  four WebP files, with the expected image content types and exact sizes.
- Before/after real data: **5,608 jobs, revision 4,135**, identical full exported
  dataset SHA-256 `5615ed3714b5d01473ed794a611ce7b70d5025709dd4ba52cb2f61ede5f5a092`.
  Enrichment remained completed 1,633 / pending 0 / running 0 / failed 0; its
  revision, service health and token fingerprint were unchanged.
- Of 781 baseline source files, the after-state audit found changes/new files only
  inside the whitelist (790 after-state source files). No backend, query-index,
  schema or source-adapter file changed in this UI implementation.
- Main process identities remained 83753 and 29285 (5173), 10262 (5178), 34879
  (5179). Existing IPv4 and IPv6 Vite HMR clients were explicitly protected before
  copying. The guards suppressed update/full-reload events and remain scoped to
  those old clients until they close. The user's existing page was never
  navigated, refreshed or accessed for verification. No resume content was
  operated on.

Read-only evidence and a checked private SQLite backup are retained outside the
repository in the evidence directory. The owned 5186 lab/browser is cleaned up;
the normal 5173 / 5178 / 5179 services remain running. Open the main workspace in
**a new tab** to load the new UI, keeping an unsaved existing session intact.
