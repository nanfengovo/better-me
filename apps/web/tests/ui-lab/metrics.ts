type InteractionEntry = PerformanceEntry & { interactionId: number; processingStart: number; processingEnd: number };
type RunningMeasurement = {
  label: string; startedAt: number; lastFrame?: number; frameGaps: number[]; interactions: Map<number, number>;
  longTasks: number[]; hidden: boolean; supported: { event: boolean; longtask: boolean };
};
const round = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], p: number): number | null => values.length
  ? round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * values.length) - 1)]!) : null;

/** Measurement only. Playwright must produce actual clicks, keys and map gestures. */
export function createLabMetrics() {
  let active: RunningMeasurement | undefined;
  let raf = 0;
  const reports: unknown[] = [];
  const supported = { event: PerformanceObserver.supportedEntryTypes.includes("event"),
    longtask: PerformanceObserver.supportedEntryTypes.includes("longtask") };
  const observers: Array<{ observer: PerformanceObserver; collect: (entries: PerformanceEntry[]) => void }> = [];
  if (supported.event) {
    const collect = (entries: PerformanceEntry[]) => {
      if (!active) return;
      for (const raw of entries) {
        const entry = raw as InteractionEntry;
        if (entry.startTime < active.startedAt || !entry.interactionId) continue;
        active.interactions.set(entry.interactionId, Math.max(active.interactions.get(entry.interactionId) ?? 0, entry.duration));
      }
    };
    const observer = new PerformanceObserver(list => collect(list.getEntries()));
    observer.observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    observers.push({ observer, collect });
  }
  if (supported.longtask) {
    const collect = (entries: PerformanceEntry[]) => {
      if (!active) return;
      for (const entry of entries) if (entry.startTime >= active.startedAt) active.longTasks.push(entry.duration);
    };
    const observer = new PerformanceObserver(list => collect(list.getEntries()));
    observer.observe({ type: "longtask", buffered: true });
    observers.push({ observer, collect });
  }
  function frame(now: number) {
    if (!active) return;
    if (document.visibilityState !== "visible") active.hidden = true;
    if (active.lastFrame !== undefined) active.frameGaps.push(now - active.lastFrame);
    active.lastFrame = now;
    raf = requestAnimationFrame(frame);
  }
  function start(label = "UI interaction window") {
    cancelAnimationFrame(raf);
    active = { label, startedAt: performance.now(), frameGaps: [], interactions: new Map(), longTasks: [],
      hidden: document.visibilityState !== "visible", supported };
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!active) throw new Error("Start a measurement before stopping it.");
    cancelAnimationFrame(raf);
    for (const { observer, collect } of observers) collect(observer.takeRecords());
    const m = active; active = undefined;
    const interactionDurations = [...m.interactions.values()];
    const frameDuration = m.frameGaps.reduce((total, gap) => total + gap, 0);
    const report = { label: m.label, durationMs: round(performance.now() - m.startedAt),
      validForegroundWindow: !m.hidden, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      raf: { frames: m.frameGaps.length, meanFps: frameDuration ? round(m.frameGaps.length * 1000 / frameDuration) : null,
        medianGapMs: percentile(m.frameGaps, .5), p95GapMs: percentile(m.frameGaps, .95), maxGapMs: percentile(m.frameGaps, 1),
        gapsOver25ms: m.frameGaps.filter(gap => gap > 25).length, gapsOver50ms: m.frameGaps.filter(gap => gap > 50).length,
        note: "Foreground requestAnimationFrame cadence, not GPU-presented frame counting. Invalid if the tab was hidden." },
      eventTiming: { supported: m.supported.event, observedInteractions: interactionDurations.length,
        maximumObservedDurationMs: percentile(interactionDurations, 1), p98ObservedDurationMs: percentile(interactionDurations, .98),
        note: "Laboratory Event Timing proxy only, not field INP. Events below the 16ms observer threshold may be absent; null is not zero. Browser duration rounding applies." },
      longTasks: { supported: m.supported.longtask, count: m.longTasks.length,
        totalMs: round(m.longTasks.reduce((total, duration) => total + duration, 0)), maximumMs: percentile(m.longTasks, 1) },
      dom: { jobCards: document.querySelectorAll(".atlas-job-card").length,
        mapCanvases: document.querySelectorAll(".maplibregl-canvas").length,
        cesiumCanvases: document.querySelectorAll(".cesium-widget canvas").length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth },
    };
    reports.push(report);
    return report;
  }
  return { start, stop, reports, dispose() { cancelAnimationFrame(raf); observers.forEach(({ observer }) => observer.disconnect()); active = undefined; } };
}
