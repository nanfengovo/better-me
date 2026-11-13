import { useEffect, useState } from "react";
import { z } from "zod";
import { useRecoveryField, useWorkspaceRecovery } from "./use-workspace-recovery";

const PageSchema = z.enum(["resume", "opportunities", "resources", "atlas", "agent", "autopilot"]);
const NavigationSchema = z.object({ page: PageSchema, workspaceTab: z.enum(["content", "design"]), agentMode: z.enum(["advisor", "studio"]) }).strict();
export function workspacePageFromSearch(search: string) {
  const page = PageSchema.safeParse(new URLSearchParams(search).get("workspace"));
  return page.success ? page.data : undefined;
}
export function useWorkspaceNavigation() {
  const recovery = useWorkspaceRecovery("navigation", NavigationSchema, (): z.infer<typeof NavigationSchema> => ({ page: workspacePageFromSearch(window.location.search) ?? "resume", workspaceTab: "content", agentMode: "advisor" }));
  const [page, updatePage] = useRecoveryField(recovery, "page");
  const [workspaceTab, setWorkspaceTab] = useRecoveryField(recovery, "workspaceTab");
  const [agentMode, setAgentMode] = useRecoveryField(recovery, "agentMode");
  const [urlAtOpen] = useState(() => workspacePageFromSearch(window.location.search));
  useEffect(() => {
    if (urlAtOpen) updatePage(urlAtOpen);
    const back = () => updatePage(workspacePageFromSearch(window.location.search) ?? "resume");
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [urlAtOpen, updatePage]);
  const setPage = (next: typeof page) => {
    if (next !== page) {
      const url = new URL(window.location.href); url.searchParams.set("workspace", next);
      window.history.pushState(null, "", url);
    }
    updatePage(next);
  };
  return { page, setPage, workspaceTab, setWorkspaceTab, agentMode, setAgentMode, recovery };
}
