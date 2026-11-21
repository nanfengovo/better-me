/**
 * Detects whether the web app is running in a pure static public preview
 * (e.g., GitHub Pages or explicit `VITE_STATIC_PREVIEW=true`) where no local
 * `agent-host` (5179) or `job-service` (5178) backend is expected to exist.
 */
export function isStaticPublicPreview(): boolean {
  if (typeof window === "undefined") return false;
  if (window.desktopApi?.isElectron) return false;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".invalid")) return false;
  return import.meta.env.VITE_STATIC_PREVIEW === "true" || host.endsWith(".github.io");
}
