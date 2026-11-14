import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useReducedMotion } from "../lib/ui-preferences";
import { ArrowUpRight, MapPin, RotateCcw } from "lucide-react";
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
  disabled: boolean;
  stageOptions: Array<[Opportunity["application"]["stage"], string]>;
  onOpen: () => void;
  onStageChange: (stage: Opportunity["application"]["stage"]) => void;
};

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
  disabled,
  stageOptions,
  onOpen,
  onStageChange,
}: Props) {
  const [backVisible, setFlipped] = useState(false);
  const flipped = !compact && backVisible;
  const reducedMotion = useReducedMotion();
  const frontTrigger = useRef<HTMLButtonElement>(null);
  const backAction = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const flip = (value: boolean) => { moveFocus.current = true; setFlipped(value); };
  useEffect(() => {
    if (moveFocus.current) (flipped ? backAction : frontTrigger).current?.focus();
    moveFocus.current = false;
  }, [flipped]);

  function updatePerspective(event: PointerEvent<HTMLElement>) {
    if (compact || event.pointerType === "touch" || reducedMotion) { resetPerspective(event); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const object = event.currentTarget.querySelector<HTMLElement>(".opportunity-card-object");
    object?.style.setProperty("--card-rotate-x", `${(0.5 - y) * 8}deg`);
    object?.style.setProperty("--card-rotate-y", `${(x - 0.5) * 10}deg`);
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
    <article data-reduce-motion={reducedMotion} className={`opportunity-row opportunity-3d-card stage-${job.application.stage}${flipped ? " is-flipped" : ""}`}>
      <div className="opportunity-card-scene" onPointerMove={updatePerspective} onPointerLeave={resetPerspective}>
        <div className="opportunity-card-object">
          <section className="opportunity-card-face opportunity-card-front" aria-hidden={flipped} inert={flipped}>
            <button className="opportunity-row-main" onClick={onOpen} tabIndex={flipped ? -1 : 0}>
              <span className="company-initial" aria-hidden="true">{job.company.slice(0, 2).toUpperCase()}</span>
              <span>
                <small>{job.company}</small>
                <strong>{job.title}</strong>
                <span className="opportunity-row-meta"><MapPin />{location}<i>·</i>{job.salaryText || salaryFallback}<i>·</i>{modeLabel}</span>
                <SourcePublicationBadges sourceLabel={job.sourcePlatform} publishedAt={job.sourcePublishedAt} publishedRaw={job.sourcePublishedText} />
              </span>
            </button>
            <p className="opportunity-card-next">{job.application.nextAction || nextActionFallback}</p>
            <div className="opportunity-row-side">
              <span className={`job-status ${job.status}`}>{statusLabel}</span>
              <select aria-label={`${job.title} ${stageLabel}`} value={job.application.stage} disabled={disabled} onChange={(event) => onStageChange(event.target.value as Opportunity["application"]["stage"])}>
                {stageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {job.applicationDeadlineDate && <small className="application-deadline-list">{deadlineLabel} {job.applicationDeadlineDate}</small>}
            </div>
            <button className="opportunity-card-flip" aria-label={`${compact ? detailsLabel : backLabel}：${job.title}`} aria-pressed={flipped} ref={frontTrigger} onClick={() => compact ? onOpen() : flip(true)} tabIndex={flipped ? -1 : 0}>
              <RotateCcw />{compact ? detailsLabel : backLabel}
            </button>
          </section>

          <section className="opportunity-card-face opportunity-card-back" aria-hidden={!flipped} inert={!flipped}>
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
              <button className="opportunity-card-detail" ref={backAction} onClick={onOpen} tabIndex={flipped ? 0 : -1}>{detailsLabel}<ArrowUpRight /></button>
              <button className="opportunity-card-flip" aria-label={`${frontLabel}：${job.title}`} onClick={() => flip(false)} tabIndex={flipped ? 0 : -1}><RotateCcw />{frontLabel}</button>
            </footer>
          </section>
        </div>
      </div>
    </article>
  );
}
