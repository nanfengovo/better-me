/** Only an explicit request to prepare a job-specific resume opens consent.
 * Advice, architecture questions and normal discussion remain ordinary chat. */
export function isCareerTailoringRequest(text: string): boolean {
  if (/怎么|如何|为什么|架构|模块|系统|设计|解释|what\b|how\b|why\b/i.test(text)) return false;
  return /简历|resume|cv\b/i.test(text) && /定制|岗位专用|针对.{0,30}(?:岗位|职位)|根据.{0,30}(?:岗位|职位|jd)|tailor|job.specific/i.test(text);
}
