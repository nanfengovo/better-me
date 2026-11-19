import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { Loader2, MapPin } from "lucide-react";
import type { AtlasDataset, GeocodingCandidate, GeocodingResult, JobLocation, JobSearchItem } from "@better-me/opportunities";
import type { AtlasDataMode } from "./connection-session";
import { AtlasJobDetail } from "./AtlasJobDetail";
import type { AtlasListingPresentation } from "./presentation";

const AtlasLocationConfirmation = lazy(() =>
  import("./AtlasLocationConfirmation").then((m) => ({ default: m.AtlasLocationConfirmation })),
);
const AtlasOfficeAddressConfirmation = lazy(() =>
  import("./AtlasOfficeAddressConfirmation").then((m) => ({ default: m.AtlasOfficeAddressConfirmation })),
);
const AtlasAddressEnrichment = lazy(() =>
  import("./AtlasAddressEnrichment").then((m) => ({ default: m.AtlasAddressEnrichment })),
);
const AtlasDetailLocations = lazy(() =>
  import("./AtlasDetailLocations").then((m) => ({ default: m.AtlasDetailLocations })),
);

export type AtlasOfficeFocusRequest = {
  id: string;
  jobId: string;
  locationId: string;
  snapshot: AtlasDataset;
  selectionKey: string;
  endpoint: string;
  token: string;
};

interface AtlasJobDetailPaneProps {
  active: boolean;
  enrichmentScope: string[] | null;
  detailReviewJobId: string;
  connected: boolean;
  dataMode: AtlasDataMode;
  liveData: AtlasDataset | null;
  data: AtlasDataset | null;
  displayedData: AtlasDataset | null;
  resultData: AtlasDataset | null;
  selected?: JobSearchItem;
  selectedEvidence: { data: AtlasDataset | null; loading: boolean; error?: string };
  listItems: JobSearchItem[];
  endpoint: string;
  token: string;
  selectionKey: string;
  text: string;
  originalCurrency: boolean;
  presentListing?: (item: JobSearchItem) => readonly AtlasListingPresentation[];
  locationReview?: { jobId: string; location: JobLocation };
  officeReview?: { jobId: string; location: JobLocation };
  locationChoices?: string;
  locationSearch?: { jobId: string; locationId: string; result?: GeocodingResult; loading: boolean; error?: string };
  countryName: (code: string) => string;
  cancelOfficeFocus: () => void;
  abortSearch: () => void;
  setEnrichmentScope: Dispatch<SetStateAction<string[] | null>>;
  setLiveData: Dispatch<SetStateAction<AtlasDataset | null>>;
  setDataMode: Dispatch<SetStateAction<AtlasDataMode>>;
  setDetailReviewJobId: Dispatch<SetStateAction<string>>;
  setSourcesOpen: Dispatch<SetStateAction<boolean>>;
  setOfficeFocusRequest: Dispatch<SetStateAction<AtlasOfficeFocusRequest | undefined>>;
  setSourceSearchMessage: Dispatch<SetStateAction<string>>;
  setLocationReview: Dispatch<SetStateAction<{ jobId: string; location: JobLocation } | undefined>>;
  setOfficeReview: Dispatch<SetStateAction<{ jobId: string; location: JobLocation } | undefined>>;
  openJob: (item: JobSearchItem) => void;
  closeJob: () => void;
  locateJob: (item: JobSearchItem, locationId?: string) => Promise<void>;
  routeJob: (item: JobSearchItem, analyze: boolean) => void;
  chooseLocationCandidate: (candidate: GeocodingCandidate) => void;
}

export function AtlasJobDetailPane({
  active,
  enrichmentScope,
  detailReviewJobId,
  connected,
  dataMode,
  liveData,
  data,
  displayedData,
  resultData,
  selected,
  selectedEvidence,
  listItems,
  endpoint,
  token,
  selectionKey,
  text,
  originalCurrency,
  presentListing,
  locationReview,
  officeReview,
  locationChoices,
  locationSearch,
  countryName,
  cancelOfficeFocus,
  abortSearch,
  setEnrichmentScope,
  setLiveData,
  setDataMode,
  setDetailReviewJobId,
  setSourcesOpen,
  setOfficeFocusRequest,
  setSourceSearchMessage,
  setLocationReview,
  setOfficeReview,
  openJob,
  closeJob,
  locateJob,
  routeJob,
  chooseLocationCandidate,
}: AtlasJobDetailPaneProps) {
  return (
    <>
      {active && enrichmentScope && connected && dataMode === "live" && liveData && (
        <aside id="atlas-job-detail" className="atlas-job-detail atlas-enrichment-detail" aria-label="岗位办公地点批量核对面板">
          <div className="atlas-job-detail-body">
            <Suspense fallback={<p role="status">正在打开办公地点补全…</p>}>
              <AtlasAddressEnrichment
                endpoint={endpoint}
                token={token}
                data={liveData}
                jobIds={enrichmentScope}
                onClose={() => {
                  cancelOfficeFocus();
                  setEnrichmentScope(null);
                }}
                onSnapshot={(snapshot) => {
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                }}
                onReviewJob={(jobId) => {
                  setEnrichmentScope(null);
                  const item = listItems.find((entry) => entry.job.id === jobId);
                  if (item) openJob(item);
                  if (
                    liveData.jobs
                      .find((job) => job.id === jobId)
                      ?.listingIds.some((id) => liveData.listings.find((listing) => listing.id === id)?.sourceId.startsWith("reviewed-platform-"))
                  ) {
                    setDetailReviewJobId(jobId);
                  } else {
                    setSourcesOpen(true);
                  }
                }}
                onOfficeSnapshot={(snapshot, location, jobId) => {
                  if (liveData.revision > snapshot.revision) return;
                  setOfficeFocusRequest({ id: crypto.randomUUID(), jobId, locationId: location.id, snapshot, selectionKey, endpoint, token });
                  abortSearch();
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                  setSourceSearchMessage(`办公位置已读取，索引版本 ${snapshot.revision}。符合当前筛选时会定位高亮，也可双击岗位再次定位。`);
                }}
                onReviewOffice={(jobId, locationId) => {
                  const location = liveData.locations.find((entry) => entry.id === locationId);
                  const item = listItems.find((entry) => entry.job.id === jobId);
                  if (location && item) {
                    setEnrichmentScope(null);
                    openJob(item);
                    setOfficeReview({ jobId, location });
                  }
                }}
              />
            </Suspense>
          </div>
        </aside>
      )}
      {!enrichmentScope && detailReviewJobId && active && connected && liveData && (
        <aside id="atlas-job-detail" className="atlas-job-detail atlas-address-detail" aria-label="岗位办公地址核对面板">
          <div className="atlas-job-detail-body">
            <Suspense fallback={<p role="status">正在打开原岗位地址核对…</p>}>
              <AtlasDetailLocations
                key={`${detailReviewJobId}:${endpoint}:${token}`}
                endpoint={endpoint}
                token={token}
                data={liveData}
                jobId={detailReviewJobId}
                onClose={() => {
                  cancelOfficeFocus();
                  setDetailReviewJobId("");
                }}
                onSnapshot={(snapshot) => {
                  abortSearch();
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                  setSourceSearchMessage(`来源地点已读取，索引版本 ${snapshot.revision}。可在核对面板继续确认具体办公位置。`);
                }}
                onOfficeSnapshot={(snapshot, location) => {
                  if (liveData.revision > snapshot.revision) return;
                  setOfficeFocusRequest({ id: crypto.randomUUID(), jobId: detailReviewJobId, locationId: location.id, snapshot, selectionKey, endpoint, token });
                  abortSearch();
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                  setSourceSearchMessage(`办公位置已读取，索引版本 ${snapshot.revision}。符合当前筛选时会定位高亮，也可双击岗位再次定位。`);
                }}
              />
            </Suspense>
          </div>
        </aside>
      )}
      {!enrichmentScope && !detailReviewJobId && selected && data && (
        <AtlasJobDetail
          key={selected.job.id}
          item={selected}
          data={selectedEvidence.data ?? displayedData ?? data}
          evidenceLoading={selectedEvidence.loading}
          evidenceError={selectedEvidence.error}
          searchQuery={text}
          demo={dataMode === "demo"}
          originalCurrency={originalCurrency}
          presentations={presentListing?.(selected) ?? []}
          onClose={closeJob}
          onLocate={(locationId) => void locateJob(selected, locationId)}
          onSave={() => routeJob(selected, false)}
          onAnalyze={() => routeJob(selected, true)}
          onConfirmLocation={
            connected && resultData === data
              ? (location) => {
                  setOfficeReview(undefined);
                  setLocationReview({ jobId: selected.job.id, location });
                }
              : undefined
          }
          onConfirmOffice={
            connected && resultData === data
              ? (location) => {
                  setLocationReview(undefined);
                  setOfficeReview({ jobId: selected.job.id, location });
                }
              : undefined
          }
          onReadLocations={
            connected && selected.job.listingIds.some((id) => data.listings.find((listing) => listing.id === id)?.sourceId.startsWith("reviewed-platform-"))
              ? () => setDetailReviewJobId(selected.job.id)
              : undefined
          }
        >
          {locationReview?.jobId === selected.job.id && connected && liveData && (
            <Suspense fallback={<p role="status">正在打开地区核对…</p>}>
              <AtlasLocationConfirmation
                key={`${locationReview.jobId}:${locationReview.location.id}:${endpoint}`}
                endpoint={endpoint}
                token={token}
                jobId={locationReview.jobId}
                location={locationReview.location}
                revision={liveData.revision}
                onClose={() => setLocationReview(undefined)}
                onSnapshot={(snapshot) => {
                  abortSearch();
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                  setDataMode("live");
                  setSourceSearchMessage(`已读取地区记录，索引版本 ${snapshot.revision}。当前筛选会按最新确认结果重新计算；不再符合条件的岗位会退出列表。`);
                }}
              />
            </Suspense>
          )}
          {officeReview?.jobId === selected.job.id && active && connected && liveData && (
            <Suspense fallback={<p role="status">正在打开办公地址核对…</p>}>
              <AtlasOfficeAddressConfirmation
                key={`${officeReview.jobId}:${officeReview.location.id}:${endpoint}:${token}`}
                endpoint={endpoint}
                token={token}
                jobId={officeReview.jobId}
                location={officeReview.location}
                revision={liveData.revision}
                onClose={() => setOfficeReview(undefined)}
                onSnapshot={(snapshot) => {
                  if (liveData.revision > snapshot.revision) return;
                  setOfficeFocusRequest({ id: crypto.randomUUID(), jobId: officeReview.jobId, locationId: officeReview.location.id, snapshot, selectionKey, endpoint, token });
                  abortSearch();
                  setLiveData((current) => (current && current.revision > snapshot.revision ? current : snapshot));
                  setDataMode("live");
                  setSourceSearchMessage(`已读取办公地址记录，索引版本 ${snapshot.revision}。地图将使用最新有效位置，来源未披露的地址仍待核对。`);
                }}
              />
            </Suspense>
          )}
          {locationChoices === selected.job.id && (
            <div className="atlas-location-candidates" aria-label="选择要定位的工作地点">
              <p>该岗位披露多个地点，请选择本次要定位的办公地点。</p>
              {selected.locations
                .filter((location) => location.kind === "office")
                .map((location) => (
                  <button type="button" key={location.id} onClick={() => void locateJob(selected, location.id)}>
                    <MapPin size={14} />
                    {location.officeResolution?.formattedAddress ?? location.streetAddress ?? location.raw}
                  </button>
                ))}
            </div>
          )}
          {locationSearch?.jobId === selected.job.id && (
            <div className="atlas-location-candidates" aria-label="城市定位候选">
              {locationSearch.loading && (
                <p role="status">
                  <Loader2 size={15} className="animate-spin" /> 正在查询本地地名库…
                </p>
              )}
              {locationSearch.error && <p role="status">{locationSearch.error}</p>}
              {locationSearch.result && (
                <>
                  <p>来源没有办公坐标。请选择城市参考点，仅用于本次地图浏览；不会写入岗位地址。</p>
                  {locationSearch.result.candidates.map((candidate) => (
                    <button key={candidate.id} onClick={() => chooseLocationCandidate(candidate)}>
                      <MapPin size={14} />
                      {candidate.matchedName} · {countryName(candidate.place.countryCode)} · {Object.values(candidate.place.administrativeCodes).join(" / ")}
                      <small>城市估算 · 非办公地址</small>
                    </button>
                  ))}
                  {!locationSearch.result.candidates.length && <p>在当前国家 / 地区范围没有找到明确候选，请打开原文核对地点。</p>}
                  <small>{locationSearch.result.candidates[0]?.evidence.provenance.attribution}</small>
                </>
              )}
            </div>
          )}
        </AtlasJobDetail>
      )}
    </>
  );
}
