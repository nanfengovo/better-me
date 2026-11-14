import { lazy, Suspense, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import { capturePrivateStorage } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";
import { LearningPathWorkspace } from "./LearningPathWorkspace";
import "./learning-path-workspace.css";

const Synthetic = lazy(() =>
  import("./GrowthJourneyWorkspace").then((module) => ({
    default: module.GrowthJourneyWorkspace,
  })),
);

/** Both paths use the existing entry. An unfinished legacy exercise stays intact. */
export function GrowthWorkspace({cloudConfig}:{cloudConfig?:LlmConfig}={}) {
  const { t } = useUiPreferences();
  const [tab, setTab] = useState<"materials" | "synthetic">(() => {
    try {
      return capturePrivateStorage().getItem("growth-journey.active.v1")
        ? "synthetic"
        : "materials";
    } catch {
      return "materials";
    }
  });
  return (
    <div className="growth-workspace">
      <nav className="learning-tabs" aria-label="成长练习方式">
        <button
          type="button"
          aria-pressed={tab === "materials"}
          onClick={() => setTab("materials")}
        >
          {t("资料与隔时复测", "Materials & delayed retest")}
        </button>
        <button
          type="button"
          aria-pressed={tab === "synthetic"}
          onClick={() => setTab("synthetic")}
        >
          {t("演示练习（非掌握证明）", "Demo exercise (not proof of mastery)")}
        </button>
      </nav>
      <Suspense
        fallback={
          <p className="learning-loading" role="status">
            {t("正在打开成长记录…", "Opening learning records…")}
          </p>
        }
      >
        {tab === "materials" ? <LearningPathWorkspace cloudConfig={cloudConfig} /> : <Synthetic />}
      </Suspense>
    </div>
  );
}
