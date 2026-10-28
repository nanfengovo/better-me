import type { MouseEvent } from "react";
import { Layers2 } from "lucide-react";

export type AtlasViewMode = "flat" | "spatial";

export function AtlasViewControls({ value, onChange }: {
  value: AtlasViewMode;
  onChange: (mode: AtlasViewMode, animate: boolean) => void;
}) {
  const choose = (mode: AtlasViewMode, event: MouseEvent<HTMLButtonElement>) => {
    const animate = event.detail > 0;
    // This transient input modality only controls CSS. Keep it off React state so
    // a press does not schedule a second workbench render or restart map work.
    const surface = event.currentTarget?.parentElement;
    if (surface) surface.dataset.motion = animate ? "pointer" : "instant";
    onChange(mode, animate);
  };
  return <div className="atlas-view-controls atlas-spatial-controls" data-view={value} data-motion="instant" role="group" aria-label="地图呈现方式">
    <button type="button" aria-label="平面视角 2D" aria-pressed={value === "flat"}
      title="平面阅读，关闭立体建筑" onClick={event => choose("flat", event)}>
      <Layers2 size={14} aria-hidden="true" /><span>2D</span>
    </button>
    <button type="button" aria-label="空间视角 3D" aria-pressed={value === "spatial"}
      title="空间视角；建筑立体效果取决于底图高度数据" onClick={event => choose("spatial", event)}>
      <span className="atlas-view-spatial-glyph" aria-hidden="true"><i /><i /><i /></span><span>3D</span>
    </button>
  </div>;
}
