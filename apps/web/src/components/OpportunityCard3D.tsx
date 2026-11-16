import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { useReducedMotion } from "../lib/ui-preferences";
import { ArrowUpRight, BookmarkX, Building2, CalendarClock, MapPin, RotateCcw } from "lucide-react";
import type { Opportunity } from "../lib/opportunities";
import { SourcePublicationBadges } from "./atlas/JobSourceBadges";

type Props = {
  compact?: boolean;
  job: Opportunity;
  location: string;
  modeLabel: string;
  statusLabel: string;
  stageLabel: string;
  salaryFallback: string;
  nextActionFallback: string;
  detailsLabel: string;
  frontLabel: string;
  backLabel: string;
  deadlineLabel: string;
  removeLabel?: string;
  disabled: boolean;
  stageOptions: Array<[Opportunity["application"]["stage"], string]>;
  onOpen: () => void;
  onStageChange: (stage: Opportunity["application"]["stage"]) => void;
  onRemove?: () => void;
};

function CardTechOverlay({ uid, badge }: { uid: string; badge: string }) {
  return (
    <svg className="opportunity-card-svg" viewBox="0 0 304 384" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id={`tech-grid-${uid}`} width="18" height="18" patternUnits="userSpaceOnUse">
          <path d="M 18 0 L 0 0 0 18" fill="none" stroke="currentColor" strokeOpacity="0.06" strokeWidth="0.7" />
          <circle cx="0" cy="0" r="0.9" fill="currentColor" fillOpacity="0.14" />
        </pattern>
        <linearGradient id={`tech-frame-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--card-accent)" stopOpacity="0.85" />
          <stop offset="50%" stopColor="var(--card-accent-secondary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--card-accent)" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={`tech-beam-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--card-accent)" stopOpacity="0" />
          <stop offset="45%" stopColor="var(--card-accent)" stopOpacity="0.12" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--card-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="292" height="372" rx="14" fill={`url(#tech-grid-${uid})`} />
      <rect className="tech-holo-beam" x="-140" y="-40" width="160" height="464" fill={`url(#tech-beam-${uid})`} />
      <path
        className="tech-chassis"
        d="M 18 5 L 286 5 L 299 18 L 299 366 L 286 379 L 18 379 L 5 366 L 5 18 Z"
        fill="none"
        stroke={`url(#tech-frame-${uid})`}
        strokeWidth="1.25"
      />
      <path
        className="tech-corner"
        d="M 10 26 L 10 14 L 18 8 L 36 8 M 268 8 L 286 8 L 294 14 L 294 26 M 10 358 L 10 370 L 18 376 L 36 376 M 268 376 L 286 376 L 294 370 L 294 358"
        fill="none"
        stroke="var(--card-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g className="tech-hud-ticks" opacity="0.65">
        <line x1="56" y1="8" x2="112" y2="8" stroke="var(--card-accent)" strokeWidth="1" strokeDasharray="4 3" />
        <circle cx="250" cy="8" r="1.8" fill="var(--card-accent)" />
        <circle cx="258" cy="8" r="1.4" fill="var(--card-accent-secondary)" />
        <text x="152" y="13" textAnchor="middle" fontSize="6.5" letterSpacing="1.6" fill="var(--card-accent)" fontFamily="ui-monospace, SFMono-Regular, monospace">
          {badge}
        </text>
      </g>
    </svg>
  );
}

export function OpportunityCard3D({
  compact = false,
  job,
  location,
  modeLabel,
  statusLabel,
  stageLabel,
  salaryFallback,
  nextActionFallback,
  detailsLabel,
  frontLabel,
  backLabel,
  deadlineLabel,
  removeLabel = "取消收藏",
  disabled,
  stageOptions,
  onOpen,
  onStageChange,
  onRemove,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const [backVisible, setFlipped] = useState(false);
  const flipped = !compact && backVisible;
  const reducedMotion = useReducedMotion();
  const sceneRef = useRef<HTMLElement>(null);
  const frontTrigger = useRef<HTMLButtonElement>(null);
  const backAction = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const flip = (value: boolean) => { moveFocus.current = true; setFlipped(value); };
  useEffect(() => {
    if (flipped) {
      const object = sceneRef.current?.querySelector<HTMLElement>(".opportunity-card-object");
      object?.style.removeProperty("--card-rotate-x");
      object?.style.removeProperty("--card-rotate-y");
    }
    if (moveFocus.current) (flipped ? backAction : frontTrigger).current?.focus();
    moveFocus.current = false;
  }, [flipped]);

  function updatePerspective(event: PointerEvent<HTMLElement>) {
    if (compact || flipped || event.pointerType === "touch" || reducedMotion) { resetPerspective(event); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const object = event.currentTarget.querySelector<HTMLElement>(".opportunity-card-object");
    object?.style.setProperty("--card-rotate-x", `${(0.5 - y) * 12}deg`);
    object?.style.setProperty("--card-rotate-y", `${(x - 0.5) * 14}deg`);
    object?.style.setProperty("--card-light-x", `${x * 100}%`);
    object?.style.setProperty("--card-light-y", `${y * 100}%`);
  }

  function resetPerspective(event: PointerEvent<HTMLElement>) {
    const object = event.currentTarget.querySelector<HTMLElement>(".opportunity-card-object");
    object?.style.removeProperty("--card-rotate-x");
    object?.style.removeProperty("--card-rotate-y");
    object?.style.removeProperty("--card-light-x");
    object?.style.removeProperty("--card-light-y");
  }

  const description = job.description.trim().replace(/\s+/g, " ");

  return (
    <article ref={sceneRef} data-reduce-motion={reducedMotion} className={`opportunity-row opportunity-3d-card stage-${job.application.stage}${flipped ? " is-flipped" : ""}`}>
      <div className="opportunity-card-scene" onPointerMove={updatePerspective} onPointerLeave={resetPerspective}>
        <div className="opportunity-card-object">
          <section className="opportunity-card-face opportunity-card-front" aria-hidden={flipped} inert={flipped}>
            <CardTechOverlay uid={`${uid}-front`} badge={`OP // ${job.application.stage.toUpperCase()}`} />
            <div className="opportunity-card-body">
              <button type="button" className="opportunity-row-main" onClick={onOpen} tabIndex={flipped ? -1 : 0}>
                <span className="opportunity-card-top-bar">
                  <span className="company-crest-wrap" aria-hidden="true">
                    <svg className="company-crest-ring" viewBox="0 0 56 56" aria-hidden="true">
                      <circle className="crest-orbit" cx="28" cy="28" r="25" fill="none" stroke="var(--card-accent)" strokeWidth="1" strokeDasharray="6 4 2 4" strokeOpacity="0.65" />
                      <circle className="crest-inner" cx="28" cy="28" r="21" fill="none" stroke="var(--card-accent-secondary)" strokeWidth="1.2" strokeDasharray="18 10" strokeOpacity="0.55" />
                    </svg>
                    <span className="company-initial">
                      {job.company.trim() ? job.company.trim().slice(0, 2).toUpperCase() : <Building2 size={18} />}
                    </span>
                  </span>
                  <span className="opportunity-company-row">
                    <small className="opportunity-company">{job.company}</small>
                    <SourcePublicationBadges sourceLabel={job.sourcePlatform} publishedAt={job.sourcePublishedAt} publishedRaw={job.sourcePublishedText} />
                  </span>
                </span>
                <span className="opportunity-card-heading">
                  <strong className="opportunity-title-text">{job.title}</strong>
                  <span className="opportunity-row-meta">
                    <span className="opportunity-meta-item"><MapPin size={12} />{location}</span>
                    <span className={`opportunity-meta-item opportunity-salary${job.salaryText ? " is-known" : ""}`}>{job.salaryText || salaryFallback}</span>
                    {job.workMode !== "unknown" && <span className="opportunity-meta-item">{modeLabel}</span>}
                  </span>
                </span>
              </button>
              <p className={`opportunity-card-next${job.application.nextAction ? " has-action" : " is-empty"}`}>
                <CalendarClock size={13} aria-hidden="true" />
                <span>{job.application.nextAction || nextActionFallback}</span>
              </p>
            </div>
            <div className="opportunity-card-footer">
              <div className="opportunity-row-side">
                <span className={`job-status ${job.status}`}>{statusLabel}</span>
                <select aria-label={`${job.company} ${job.title} ${stageLabel}`} value={job.application.stage} disabled={disabled} onChange={(event) => {
                  if (event.target.value === "__unsave__") {
                    event.currentTarget.value = job.application.stage;
                    onRemove?.();
                    return;
                  }
                  onStageChange(event.target.value as Opportunity["application"]["stage"]);
                }}>
                  {stageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  {onRemove && <option value="__unsave__">{removeLabel}</option>}
                </select>
                {job.applicationDeadlineDate && <small className="application-deadline-list"><CalendarClock size={12} /> {deadlineLabel} {job.applicationDeadlineDate}</small>}
              </div>
              <div className="opportunity-card-actions">
                {onRemove && (
                  <button type="button" className="opportunity-card-remove opportunity-card-remove-front" onClick={onRemove} disabled={disabled} tabIndex={flipped ? -1 : 0} aria-label={`${removeLabel}：${job.title}`}>
                    <BookmarkX size={13} />{removeLabel}
                  </button>
                )}
                <button type="button" className="opportunity-card-flip" aria-label={`${compact ? detailsLabel : backLabel}：${job.title}`} aria-pressed={flipped} ref={frontTrigger} onClick={() => compact ? onOpen() : flip(true)} tabIndex={flipped ? -1 : 0}>
                  {compact ? <>{detailsLabel}<ArrowUpRight size={14} /></> : <><RotateCcw size={14} />{backLabel}</>}
                </button>
              </div>
            </div>
          </section>

          <section className="opportunity-card-face opportunity-card-back" aria-hidden={!flipped} inert={!flipped}>
            <CardTechOverlay uid={`${uid}-back`} badge={`LOG // ${job.application.stage.toUpperCase()}`} />
            <header>
              <span className="opportunity-card-stage">{stageLabel} · {job.application.stage}</span>
              <strong>{job.title}</strong>
              <small>{job.company}</small>
            </header>
            <div className="opportunity-card-note">
              <span>{job.application.nextAction || nextActionFallback}</span>
              <p>{description || nextActionFallback}</p>
            </div>
            <footer>
              <button type="button" className="opportunity-card-detail" ref={backAction} onClick={onOpen} tabIndex={flipped ? 0 : -1}>{detailsLabel}<ArrowUpRight /></button>
              {onRemove && <button type="button" className="opportunity-card-remove" onClick={onRemove} disabled={disabled} tabIndex={flipped ? 0 : -1} aria-label={`${removeLabel}：${job.title}`}><BookmarkX size={13} />{removeLabel}</button>}
              <button type="button" className="opportunity-card-flip" aria-label={`${frontLabel}：${job.title}`} onClick={() => flip(false)} tabIndex={flipped ? 0 : -1}><RotateCcw />{frontLabel}</button>
            </footer>
          </section>
        </div>
      </div>
    </article>
  );
}
