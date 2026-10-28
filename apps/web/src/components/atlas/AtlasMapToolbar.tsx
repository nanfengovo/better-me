import { Compass, Globe2, MapPin } from "lucide-react";
import { AtlasViewControls, type AtlasViewMode } from "./AtlasViewControls";

type MapScope = "global" | "domestic";

/** Workspace controls reserve a flow row; renderer overlays belong to the scene below. */
export function AtlasMapToolbar({ mode, onModeChange, viewMode, onViewChange, rotating, onToggleRotation, onReset, globalLabel = "全球", domesticLabel = "国内" }: {
  mode: MapScope;
  onModeChange: (mode: MapScope) => void;
  viewMode: AtlasViewMode;
  onViewChange: (mode: AtlasViewMode, animate: boolean) => void;
  rotating: boolean;
  onToggleRotation: () => void;
  onReset: () => void;
  globalLabel?: string;
  domesticLabel?: string;
}) {
  return <div className="atlas-map-top atlas-map-toolbar" role="group" aria-label="地图工具栏">
    <div className="atlas-mode-switch" role="group" aria-label="地图范围">
      <button type="button" aria-pressed={mode === "global"} className={mode === "global" ? "active" : ""} onClick={() => onModeChange("global")}>
        <Globe2 size={16} aria-hidden="true" />{globalLabel}
      </button>
      <button type="button" aria-pressed={mode === "domestic"} className={mode === "domestic" ? "active" : ""} onClick={() => onModeChange("domestic")}>
        <MapPin size={16} aria-hidden="true" />{domesticLabel}
      </button>
    </div>
    <AtlasViewControls value={viewMode} onChange={onViewChange} />
    <div className="atlas-map-camera-controls" role="group" aria-label="地图视角">
      <button type="button" aria-label="重置地图视角" title="重置视角" onClick={onReset}><Compass size={18} aria-hidden="true" /></button>
      <button type="button" aria-pressed={rotating} disabled={viewMode === "flat" || mode !== "global"} title="仅在全球 3D 总览启用；交互时会自动暂停" onClick={onToggleRotation}>
        {rotating ? "暂停旋转" : "自动旋转"}
      </button>
    </div>
  </div>;
}
