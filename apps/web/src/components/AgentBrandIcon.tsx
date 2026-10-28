import { useState } from "react";
import { BrainCircuit, CircleDot, Code2, Cpu, Orbit, Sparkles, Terminal, WandSparkles } from "lucide-react";
import { getAgentIconAsset } from "./agent-icon-manifest";

/** Decorative artwork: the adjacent runtime/provider name is the accessible label. */
export function AgentBrandIcon({ id }: { id: string }) {
  return <BrandIcon key={id} id={id} />;
}

function BrandIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  const asset = getAgentIconAsset(id);
  if (asset?.source === "project-generated" && asset.generatedSrc && !failed) {
    const base = import.meta.env?.BASE_URL ?? "/";
    return <img className="agent-runtime-art" data-agent-art={id}
      src={base + asset.generatedSrc.replace(/^\/+/, "")} alt="" aria-hidden="true"
      width={256} height={256} decoding="async" draggable={false} onError={() => setFailed(true)} />;
  }
  if (asset?.brandIcon) return <svg className="agent-runtime-brand" data-agent-fallback={id} viewBox="0 0 24 24" aria-hidden="true"><path d={asset.brandIcon.path} /></svg>;
  const fallbacks: Record<string, typeof Terminal> = { "claude-code": Sparkles, opencode: Code2, "gemini-cli": WandSparkles, codex: Terminal,
    "deepseek-harness": BrainCircuit, pi: CircleDot, antigravity: Orbit, ollama: Cpu };
  const Icon = Object.hasOwn(fallbacks,id) ? fallbacks[id]! : Terminal;
  return <Icon size={19} strokeWidth={1.8} aria-hidden="true" data-agent-fallback={id} />;
}
