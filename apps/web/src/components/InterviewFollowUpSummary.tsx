import { useEffect, useState } from "react";

type RetestItem = {
  path: "facts" | "practice" | "defer";
  retestDueAt?: string | null;
  retestAt: string | null;
  independent: boolean | null;
  assessment: "met" | "retry" | null;
};

export function InterviewFollowUpSummary({ items }: { items: readonly RetestItem[] }) {
  const [now, setNow] = useState(Date.now);
  const scheduled = items.filter(item => item.path === "practice" && item.retestDueAt);
  const due = scheduled.filter(item => Date.parse(item.retestDueAt!) <= now);
  const completed = due.filter(item => item.retestAt);
  const met = completed.filter(item => item.assessment === "met");
  const independent = met.filter(item => item.independent === true).length;
  const pending = completed.filter(item => item.assessment === null).length;
  const hasFuture = scheduled.length > due.length;
  useEffect(() => {
    if (!hasFuture) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [hasFuture]);

  if (!scheduled.length) return null;
  return <p className="crfp-muted" aria-label="本页当前安排的复测进度">
    {due.length ? `本页到期复测已提交 ${completed.length}/${due.length} 项。` : "已安排复测，尚未到期。"}
    {completed.length > 0 && ` 其中 ${met.length} 项本人确认达到原定标准${met.length ? `（${independent} 项独立作答）` : ""}${pending ? `，${pending} 项待本人核对` : ""}。`}
  </p>;
}
