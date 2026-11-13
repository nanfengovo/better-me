import type { Viewer } from "cesium";
import type { SceneFailure } from "../../components/atlas/map3d/config";
import type { SkillConstellationModel } from "./model";

export interface SkillConstellationSceneStatus {
  phase: "loading" | "ready" | "error";
  /** ready means an actual postRender callback was observed, not just a Viewer. */
  renderedFrame: boolean;
  failure?: SceneFailure;
}
export interface SkillConstellationSceneHandle {
  update(model: SkillConstellationModel, selectedJobId?: string): void;
  focus(jobId: string): void;
  navigate(action: "in" | "out" | "reset"): void;
  dispose(): void;
}
export interface SkillConstellationSceneCallbacks {
  status(status: SkillConstellationSceneStatus): void;
  pick(jobIds: readonly string[]): void;
  inspectBadge(): void;
}
export interface SkillConstellationSceneOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  /** Optional shared Job Atlas Viewer. This Adapter never destroys it or changes
   * its imagery/source/quality; it owns only its own CustomDataSource/listeners. */
  sharedViewer?: Viewer;
}
export type SkillConstellationSceneFactory = (host: HTMLElement, model: SkillConstellationModel, callbacks: SkillConstellationSceneCallbacks,
  options: SkillConstellationSceneOptions) => SkillConstellationSceneHandle | Promise<SkillConstellationSceneHandle>;
