/**
 * Agent Guided Interaction & Visual Tour Helper
 * Enables the Agent to guide user attention to specific fields, experiences,
 * and claims on the left side of the workspace with smooth scrolling and animations.
 */

export interface AgentGuideTarget {
  anchor?: string; // e.g. "profile:headline", "experience:exp-1", "claim:claim-1"
  claimId?: string;
  experienceId?: string;
  section?: "headline" | "experience" | "skills" | "profile" | "education" | string;
  text?: string;
  label?: string; // e.g. "Agent 建议修改此处", "已由 Agent 自动同步更新"
  actionType?: "suggest" | "applied" | "focus";
}

let activeBeaconElement: HTMLElement | null = null;
let activeBeaconTimeout: ReturnType<typeof setTimeout> | null = null;

export function triggerAgentGuide(target: AgentGuideTarget) {
  if (typeof window === "undefined") return;

  // Dispatch custom DOM event for decoupled React listener or direct DOM handler
  const CustomEventClass = (window.CustomEvent || globalThis.CustomEvent) as typeof CustomEvent;
  if (CustomEventClass) {
    const event = new CustomEventClass("betterme:agent-guide", { detail: target });
    window.dispatchEvent(event);
  }

  // Directly perform DOM lookup and smooth scrolling
  setTimeout(() => {
    executeAgentGuide(target);
  }, 50);
}

export function executeAgentGuide(target: AgentGuideTarget): boolean {
  if (typeof document === "undefined") return false;

  // Clean up previous beacon
  if (activeBeaconElement) {
    activeBeaconElement.remove();
    activeBeaconElement = null;
  }
  if (activeBeaconTimeout) {
    clearTimeout(activeBeaconTimeout);
    activeBeaconTimeout = null;
  }
  document.querySelectorAll(".agent-guided-active").forEach((el) => {
    el.classList.remove("agent-guided-active");
  });

  // Auto switch FactEditor tab if target is in profile vs experiences
  const isProfileTarget =
    target.anchor?.startsWith("profile") ||
    target.section === "headline" ||
    target.section === "profile" ||
    target.section === "education";
  const isExpTarget =
    target.anchor?.startsWith("experience") ||
    target.anchor?.startsWith("claim") ||
    Boolean(target.claimId) ||
    Boolean(target.experienceId) ||
    target.section === "experience";

  let tabSwitched = false;
  if (isProfileTarget && !document.querySelector('[data-editor-anchor^="profile"]')) {
    const profileTabBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("个人信息") || b.textContent?.includes("Personal information")
    );
    if (profileTabBtn) {
      profileTabBtn.click();
      tabSwitched = true;
    }
  } else if (isExpTarget && !document.querySelector('[data-editor-anchor^="experience"]')) {
    const expTabBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("经历与成果") || b.textContent?.includes("Experience & achievements")
    );
    if (expTabBtn) {
      expTabBtn.click();
      tabSwitched = true;
    }
  }

  if (tabSwitched) {
    setTimeout(() => {
      findAndHighlightTarget(target);
    }, 70);
    return true;
  }

  return findAndHighlightTarget(target);
}

function findAndHighlightTarget(target: AgentGuideTarget): boolean {
  if (typeof document === "undefined") return false;

  // Find target element by priority
  let targetEl: HTMLElement | null = null;

  if (target.anchor) {
    targetEl = document.querySelector(`[data-editor-anchor="${target.anchor}"]`);
  }

  if (!targetEl && target.claimId) {
    targetEl =
      document.querySelector(`[data-editor-anchor="claim:${target.claimId}"]`) ||
      document.querySelector(`[data-editor-anchor="${target.claimId}"]`) ||
      document.querySelector(`[data-editor-anchor="experience:${target.claimId}"]`);
  }

  if (!targetEl && target.experienceId) {
    targetEl = document.querySelector(`[data-editor-anchor="experience:${target.experienceId}"]`);
  }

  if (!targetEl && target.section) {
    if (target.section === "headline" || target.section.includes("优势") || target.section.includes("定位")) {
      targetEl =
        document.querySelector('[data-editor-anchor="profile:headline"]') ||
        document.querySelector('[data-editor-anchor="profile"]');
    } else if (target.section === "education" || target.section.includes("学历")) {
      targetEl = document.querySelector('[data-editor-anchor="profile:education"]');
    } else if (target.section.includes("经历") || target.section === "experience") {
      targetEl =
        document.querySelector('[data-editor-anchor^="experience:"]') ||
        document.querySelector('[data-editor-anchor^="claim:"]');
    }
  }

  // Fallback: match by content text substring
  if (!targetEl && target.text && target.text.length > 5) {
    const snippet = target.text.slice(0, 20);
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-editor-anchor]"));
    targetEl = candidates.find((c) => c.textContent?.includes(snippet)) ?? null;
  }

  // If still not found, fallback to first claim or headline
  if (!targetEl) {
    targetEl =
      document.querySelector('[data-editor-anchor^="claim:"]') ||
      document.querySelector('[data-editor-anchor="profile:headline"]') ||
      document.querySelector('[data-editor-anchor^="experience:"]');
  }

  if (!targetEl) return false;

  // If inside a collapsed experience card, expand it
  const parentExp = targetEl.closest('article[data-editor-anchor^="experience:"]');
  if (parentExp) {
    const expandBtn = parentExp.querySelector<HTMLButtonElement>('button[type="button"]');
    const isBodyHidden = !parentExp.querySelector(".space-y-4");
    if (isBodyHidden && expandBtn) {
      expandBtn.click();
    }
  }

  // Smoothly scroll into view
  targetEl.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });

  // Apply glowing guided animation class
  targetEl.classList.add("agent-guided-active");

  // Create floating guided beacon tag
  const beacon = document.createElement("div");
  beacon.className = "agent-guide-beacon";
  const beaconText =
    target.label || (target.actionType === "applied" ? "✨ 已由 Agent 自动同步更新" : "🤖 Agent 建议优化此处");
  beacon.innerHTML = `<span>✨</span><span>${beaconText}</span>`;

  // Position relative to target
  targetEl.style.position = "relative";
  targetEl.appendChild(beacon);
  activeBeaconElement = beacon;

  // Fade out after 3.2 seconds
  activeBeaconTimeout = setTimeout(() => {
    if (activeBeaconElement === beacon) {
      beacon.style.opacity = "0";
      beacon.style.transition = "opacity 0.4s ease-out";
      setTimeout(() => {
        beacon.remove();
        targetEl?.classList.remove("agent-guided-active");
        if (activeBeaconElement === beacon) activeBeaconElement = null;
      }, 400);
    }
  }, 3200);

  return true;
}
