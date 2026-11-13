import { AgentBrandIcon } from "./AgentBrandIcon";

export function StudioRuntimeIcon({ agentId, className = "" }: { agentId: string; className?: string }) {
  return <span className={`studio-runtime-icon ${className}`} data-studio-agent={agentId} aria-hidden="true"><AgentBrandIcon id={agentId} /></span>;
}
