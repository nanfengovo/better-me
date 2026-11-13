# Receipt-bound skill constellation

`AtlasSkillConstellation` is an isolated Studio section. The existing Job Atlas,
Workspace and exporters are unchanged. No dependencies were installed.

## Host contract

Pass the actual authorized `createSkillJobLinks(...).links` projection, not raw
city text, geocoder guesses or model output:

```ts
<AtlasSkillConstellation
  binding={{ ownerId, sessionGeneration, contextId, revision }}
  getCurrentBinding={getCurrentBinding}
  badge={{
    id: output.badge.id,
    label: "本次授权实践",
    verificationReceiptId: output.badge.observation.receipt.id,
    sourceHash: output.badge.observation.sourceHash,
    skillIds: output.badge.observation.skillIds,
  }}
  links={output.links.links}
  excludedJobs={output.links.excludedJobs}
  limitations={output.links.limitations}
  jobMetadata={selectedJobs.map(job => ({ jobId: job.id, label: job.title }))}
  onSelectJob={selectExistingWorkspaceJob}
  onInspectBadge={openAuthorizedReceipt}
/>
```

`jobMetadata` has no coordinate fields and cannot add map points. The pure
projection rechecks badge IDs, SHA-256 shape, original geographic bounds, explicit
skills and rule meaning. A same-job conflict removes all its conflicting points;
duplicates do not count as opportunities. The 500-link bound is explicit: an
oversized cohort is unavailable rather than silently truncated. Validation does
not independently verify provenance: that belongs to the trusted Host projection.

The virtual node is a dimensionless Earth-centred presentation vector outside the
globe, not a candidate location. Its display position is derived geometrically
from the authorized office directions, with deterministic handling of antimeridian
and antipodal cases. Intermediate arc geometry is not a job location and must
never be persisted as one. Every real office endpoint uses the exact input
longitude and latitude through `Cartesian3.fromDegrees`.

## Real scene and fallback

The default lazy scene uses the same installed Cesium package, Vite local asset
route, quality policy and sanitized-error classifier as Job Atlas. It creates a
real Viewer, local SDK Natural Earth imagery and a dedicated CustomDataSource.
No ion/Google credentials, network tiles, city geocoding, model calls, animation
loop or fabricated preview are supplied. `ready` requires an actual Cesium
`postRender` event, not merely a resolved import or constructed Viewer. GPU loss,
first-frame timeout and initialization errors preserve the complete DOM list and
require an explicit retry. Errors never automatically select another provider.

If integration can expose the existing Job Atlas Viewer, `sharedViewer` mounts
only an owned overlay. It does not change shared imagery/quality, move the camera
on mount or destroy the shared Viewer. Camera buttons are explicit user actions.
Disposal removes only the owned DataSource and listeners, including a DataSource
whose asynchronous attachment settles after cancellation. The current existing
Atlas runtime does not expose its Viewer; using the optional seam will require a
separate root-owned integration change. Without it, Studio owns a separate Viewer.

Search, skill selection, pagination, source-hash details, badge receipt inspection,
job selection and coincident-job disambiguation remain keyboard-operable without
WebGL. Changing owner/session/context/revision remounts the isolated section;
stale callbacks and late handles cannot select jobs or expose success. The Host
still owns actual identity revocation and rerendering on account changes.

The map's diamond/point is an honest scene symbol, not the Vork image. Display the
real rendered badge and its independent file receipt elsewhere in Studio. A
Verification Receipt and hash bind a checked version and range, not authorship,
personal achievement, job freshness or hiring probability.

## Verification boundary

20 direct-source tests cover pure coordinates/conflicts/budgets, actual Cesium
entities on a synthetic shared-scene fixture, late attachment cleanup and React
control/lifecycle behavior. The fixture manually raises `postRender`; it is NOT a
real WebGL or screenshot acceptance. Strict isolated typecheck and lint passed.
Real browser/Electron rendering, multi-column/narrow screenshot acceptance,
keyboard traversal in a real browser and actual Vork render receipt checks remain
root-owned integration evidence. No real account or resume data was read.
