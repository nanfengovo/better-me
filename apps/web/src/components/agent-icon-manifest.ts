import type { SimpleIcon } from "simple-icons";
import {
  siClaudecode,
  siDeepseek,
  siGooglegemini,
  siOllama,
  siOpencode,
  siPi,
} from "simple-icons";

export interface AgentIconAsset {
  id: string;
  /** Optional project-local generated raster. Brand SVG is the deterministic fallback. */
  generatedSrc?: string;
  alt: string;
  fallbackLabel: string;
  brandIcon?: SimpleIcon;
  source: "simple-icons-cc0" | "project-generated" | "abstract-fallback";
}

/**
 * Project-generated artwork is brand-inspired, not an official logo. Keep it
 * separate from runtime metadata. A missing image never blocks tool selection.
 */
export const AGENT_ICON_ASSETS: Record<string, AgentIconAsset> = {
  "claude-code": { id: "claude-code", generatedSrc: "/agent-icons/claude-code-3d-v1.webp", alt: "Claude Code inspired 3D pixel crab", fallbackLabel: "Claude", brandIcon: siClaudecode, source: "project-generated" },
  opencode: { id: "opencode", generatedSrc: "/agent-icons/opencode-3d-v1.webp", alt: "OpenCode inspired 3D open frame", fallbackLabel: "Open", brandIcon: siOpencode, source: "project-generated" },
  "gemini-cli": { id: "gemini-cli", generatedSrc: "/agent-icons/gemini-cli-3d-v1.webp", alt: "Gemini inspired 3D four-point star", fallbackLabel: "Gemini", brandIcon: siGooglegemini, source: "project-generated" },
  codex: { id: "codex", generatedSrc: "/agent-icons/codex-3d-v1.webp", alt: "Codex inspired 3D terminal tile", fallbackLabel: "Codex", source: "project-generated" },
  "deepseek-harness": { id: "deepseek-harness", generatedSrc: "/agent-icons/deepseek-harness.png", alt: "DeepSeek brand mark", fallbackLabel: "DeepSeek", brandIcon: siDeepseek, source: "simple-icons-cc0" },
  pi: { id: "pi", generatedSrc: "/agent-icons/pi.png", alt: "Pi brand mark", fallbackLabel: "Pi", brandIcon: siPi, source: "simple-icons-cc0" },
  antigravity: { id: "antigravity", generatedSrc: "/agent-icons/antigravity.png", alt: "Antigravity abstract mark", fallbackLabel: "Gravity", source: "abstract-fallback" },
  ollama: { id: "ollama", generatedSrc: "/agent-icons/ollama.png", alt: "Ollama brand mark", fallbackLabel: "Ollama", brandIcon: siOllama, source: "simple-icons-cc0" },
};

export function getAgentIconAsset(id: string): AgentIconAsset | undefined {
  return Object.hasOwn(AGENT_ICON_ASSETS, id) ? AGENT_ICON_ASSETS[id] : undefined;
}
