import path from "node:path";
import { createFinalExportRenderer, type TrustedExportExecutable } from "./final-export-renderer.js";

/** Explicit installation environment only. No search of user's app folders,
 * PATH, credentials or download/install. Each executable is pinned and checked
 * again by the renderer; unset integrations remain unavailable. */
export function careerExportRendererFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const chromiumPath = environment.BETTERME_CAREER_EXPORT_CHROMIUM, officePath = environment.BETTERME_CAREER_EXPORT_SOFFICE;
  if (!chromiumPath && environment.BETTERME_CAREER_EXPORT_CHROMIUM_SHA256 || !officePath && (environment.BETTERME_CAREER_EXPORT_SOFFICE_SHA256 || environment.BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS)) throw new Error("final_export_configuration_incomplete");
  if (!chromiumPath && !officePath) return undefined;
  const specification = (executablePath: string | undefined, hash: string | undefined): TrustedExportExecutable | undefined => {
    if (!executablePath) { if (hash) throw new Error("final_export_configuration_incomplete"); return undefined; }
    if (!path.isAbsolute(executablePath) || /[\r\n\0]/.test(executablePath) || hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) throw new Error("final_export_configuration_invalid");
    return { executablePath, ...(hash ? { sha256: hash } : {}) };
  };
  const chromium = specification(chromiumPath, environment.BETTERME_CAREER_EXPORT_CHROMIUM_SHA256), soffice = specification(officePath, environment.BETTERME_CAREER_EXPORT_SOFFICE_SHA256);
  if (environment.BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS) {
    const paths: unknown = JSON.parse(environment.BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS);
    if (!soffice || !Array.isArray(paths) || paths.length > 16 || paths.some(item => typeof item !== "string" || !path.isAbsolute(item) || /[\r\n\0]/.test(item))) throw new Error("final_export_configuration_invalid");
    soffice.runtimeReadPaths = paths;
  }
  return createFinalExportRenderer({ chromium, soffice, maxInputBytes: 8_000_000, maxPdfBytes: 8_000_000, maxActiveMs: 115_000 });
}
