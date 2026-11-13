# Layout compiler seam

This module does not modify the preview, Workspace, exporters or persisted resume.
The owning integration supplies isolated rendering, rewriting, independent semantic
review, authorization and final adoption. Do not turn a returned proposal into an
automatic `Fact`, resume write or "verified equivalent" badge.

## Entry points

- `measureDomLayout(printRoot, { scope, page, renderBinding, signal, isCurrent })`
  waits for fonts and decoded images, then reads real element and text `Range`
  rectangles. Pass the actual 210 mm paper root (or explicitly a content-width
  root), not the preview viewport. Preview `zoom`/axis-aligned scaling is removed;
  a responsive root at another layout width is rejected, not stretched. Hidden,
  detached, zero-size, unmeasurable and unsupported-transform inputs are unavailable.
  For a single text line whose measured element height exactly matches its CSS
  line-height and has no clipping container, vertical DOM flow uses that actual
  CSS line box. The original font `Range` remains recorded, and horizontal bounds
  are never replaced: an em box extending above a CJK heading is not by itself
  evidence that glyph ink is clipped. Fixed-height or clipping containers do not
  receive this exception; final-file geometry never accepts a DOM `flowRect`.
- `diagnoseLayout(measurement, thresholds)` is pure. It emits anchored measured
  whitespace, orphan-page, stranded-heading, short-last-line and overflow issues.
  Its penalty is a reproducible issue penalty, not resume quality or hiring odds.
- `compileLayoutProposals(input, adapters, budgets)` renders the immutable baseline,
  asks for bounded patches, rejects lexical invariant changes, requires an
  independent semantic verdict for wording, rerenders and ranks observed results.
  It always returns `requiresConfirmation: true`; cancellation and stale versions
  discard actionable proposals. Duplicate payloads are not rendered repeatedly.

`render(candidate, signal, binding)` must return geometry with that exact
`renderBinding`. An isolated render can pass `binding` directly to
`measureDomLayout`. `verifySemantics` must return the exact candidate ID and
`layoutCandidateFingerprint(candidate)`, all required semantic checks, and a
non-self-review method. The fingerprint detects mismatched payloads; it is not a
cryptographic signature, authorization or truth certificate. Supply authorized
proper names, technical entities, attribution phrases and evidence references in
each text's `protectedSpans`; lexical matching alone cannot establish equivalence.

## Final-output evidence

DOM flow is explicitly `dom-estimate`: screen geometry does not observe print
fragmentation, print-only styles or the independent DOCX renderer. A final renderer
must instead supply `pdf-final` or `docx-final`, page-local block coordinates and
actual page numbers, file SHA-256, input version, renderer/version, rendered time,
observed page count and a body-text comparison. DOCX additionally requires the
hash of its paginated rendering. Missing receipts fail closed. A file hash binds a
version, not facts, authorship, semantic equivalence or permission to publish.

The compiler never compares a DOM penalty to a final-file penalty as if they were
the same observation. PDF and DOCX still need separate final-file body/numeric/
reference/link and visual checks. A successful in-memory iteration does not
constitute those checks or completion of feature #3.

`inspectFinalLayoutArtifact` now implements that separate boundary. It accepts
ONLY an injected trusted exporter callback's exact bytes/receipt, recomputes both
SHA-256 values, checks operation/scope/candidate/format and delegates page geometry
to `pdfjs-final.ts`. It does not accept uploaded geometry or fall back to DOM
metrics. PDF uses its own bytes; DOCX requires both the original ZIP bytes and the
trusted paginated PDF's bytes. Each input is bounded and individually hashed.
The PDF.js adapter reads actual page sizes, text transforms/metrics, image
operator transforms and URI annotations. Unsupported metrics, scans, rotation,
page-size changes and budgets are explicitly unavailable instead of estimated.
Chromium/Skia can emit embedded Type3 CJK subsets with no `TextStyle.ascent`.
After resolving the real PDF operator-list font dependencies, the adapter uses
that font's actual `FontBBox` and `FontMatrix` through the installed PDF.js 6
font-object seam, with strict bounded feature checks. It never substitutes a
default ascent, a system font or a DOM rectangle. This is embedded font-metric
geometry, not a pixel-accurate glyph-ink or font-fidelity certificate; absent or
unsupported metrics still fail closed.

`captureFinalLayoutExpectedDocument` independently captures the entire authorized
Template DOM's text and hyperlinks, not just editable Claims. The final parser's
extracted body is compared to that baseline (whitespace/NFC/common bullet marks
plus ONLY the Unicode compatibility decomposition of standard Latin presentation
ligatures U+FB00–U+FB06 and Kangxi radicals U+2F00–U+2FD5). This narrow,
source-independent glyph-extraction compatibility is applied symmetrically to
both texts, with the raw PDF text retained. It is **not** general NFKC/NFKD:
fullwidth forms, circled/Roman numerals and unit symbols remain distinct;
missing/extra digits, names, qualifiers, citations and negations cannot be
silently normalized away. Unextractable/PUA text is unknown. Links are compared
without opening destinations. This is byte/text/link/geometry checking, not OCR,
font-fidelity certification or human visual acceptance.

If the independent source itself contains one of those radicals or presentation
ligatures, a compatibility-fold match with unequal raw NFC/whitespace/list-dot
text remains `unknown`, not verified. An intentional radical symbol or ligature
in an entity name cannot silently become an ordinary ideograph or Latin letters.
Exact raw-normalized source symbols still match; known number/entity/negation
changes still remain mismatches. This is extraction compatibility, not a general
semantic equivalence between Unicode symbols and words.

The Panel's optional `exportFinalArtifact({ operationId, format, scope,
renderBinding, resume, candidate?, signal })` returns
`{ operationId, format, scope, renderBinding, artifact:{bytes,sha256,filename},
renderedPdf?:{bytes,sha256,filename}, receipt:{id,renderer:{name,version},renderedAt} }`.
No existing file-exporter is replaced. Separate PDF/DOCX states and separate
consumed consent show not-run/running/diagnosed/unavailable/stale/cancelled/timeout;
each diagnosed result exposes actual bytes for explicit download. A reviewed
candidate can be exported without adopting it. `visualCheck` remains
`not-performed` even when all machine checks pass. Final operations stop at
120 seconds maximum and are not retried. The workspace dynamically loads the
owning trusted exporter only after that explicit operation.

## Workspace UI integration

`CareerLayoutPanel` uses the existing `ResumeTemplate` in an inert, offscreen,
210 mm print-width root. It is not `display:none` or `visibility:hidden`. Each
candidate is actually rerendered and remeasured; mounting alone performs no extra
image rendering or model request. Layout-only suggestions are available without a
model. Wording requires separate consent, a new-context review, per-change
checkboxes, a new measurement/review of the selected subset, then explicit adoption.

`createCareerLayoutModelAdapter` accepts an injected Host request function, fixed
local runtime and authorized context. It checks the actual SHA-256 of the exact
`JSON.stringify({ contract, data })` payload and exact context/model/digest in the
response. The separately dispatched review is not a self-rating of the rewrite,
but using the same model in a new context still does not constitute independent
fact verification. No default fetch, tools, file access, credentials or fallback
provider are supplied by the Adapter.

`onAdopt(candidate, context)` belongs to the existing business command. Its formal
read-back receipt must match `baseScope` and `candidateFingerprint`; missing or
ambiguous outcomes are unknown and are never retried automatically. If that exact
CAS advances the resume itself, the receipt may include `resultScope`. It must
retain owner/session/document identity and exactly match the current new scope;
unrelated source advances remain stale. Integrators should keep the in-flight
panel alive until that result settles, then revoke its old authorization and
create a new context for any new action. The helper does not write Facts or create
a second resume history. Changed text drops only its old character-offset styling
so stale UTF-16 ranges cannot style the wrong characters.

## Current verification boundary

Owned unit tests run direct source with synthetic geometry. happy-dom has no
real layout engine: Range/box fixtures validate normalization and lifecycle, not
browser pagination. Real browser multi-column/CJK/English/long-link/font-fallback
samples, actual Workspace CAS adoption, real resume PDF/DOCX exports and Electron
acceptance belong to the integration workflow. The PDF.js unit test really parses
an in-memory synthetic multipage PDF including a URI and transformed image; it
does not establish CJK/font/visual acceptance for a delivered resume file.
