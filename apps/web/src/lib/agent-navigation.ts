/** In-app navigation only. No authorization, model request or resume write is implied. */
export const OPEN_PROJECT_EVENT = "betterme:open-project-source";
export function openProjectSource(targetKey: string) {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_EVENT, { detail: { targetKey } }));
}
