import type { OfficialJobDiscoveryCandidate } from "./official-job-discovery-contracts.js";

// These references describe the parent group, never the local hiring entity's shareholders.
// Only an already verified posting on that group's exact ATS tenant can receive a reference.
const groups = [
  { board: "https://agilent.wd5.myworkdayjobs.com/Agilent_Careers", brand: /\bagilent\b|安捷伦/i, name: "Agilent Technologies", headquarters: "美国 · 圣克拉拉", evidenceUrl: "https://www.agilent.com/en/contact-us/page" },
  { board: "https://elekta.wd3.myworkdayjobs.com/Elekta_Careers", brand: /\belekta\b|医科达/i, name: "Elekta", headquarters: "瑞典 · 斯德哥尔摩", evidenceUrl: "https://www.elekta.com/company/offices/" },
  { board: "https://maersk.wd3.myworkdayjobs.com/Maersk_Careers", brand: /\bm[aæ]ersk\b|\bmaersk\b|马士基/i, name: "A.P. Møller - Mærsk", headquarters: "丹麦 · 哥本哈根", evidenceUrl: "https://investor.maersk.com/static-files/d0d97fdd-9715-463e-abba-259e202466e4" },
  { board: "https://jobs.smartrecruiters.com/BoschGroup", brand: /\bbosch\b|博世/i, name: "Bosch", headquarters: "德国 · 格尔林根", evidenceUrl: "https://www.bosch.com/faq/" },
  { board: "https://jobs.smartrecruiters.com/WesternDigital", brand: /\bwestern digital\b|西部数据/i, name: "Western Digital", headquarters: "美国 · 圣何塞", evidenceUrl: "https://www.westerndigital.com/company/office-locations" },
  { board: "https://apply.careers.microsoft.com/careers", brand: /\bmicrosoft\b|微软/i, name: "Microsoft", headquarters: "美国 · 雷德蒙德", evidenceUrl: "https://news.microsoft.com/facts-about-microsoft/" },
] as const;
export const workdayBoardDirectory = groups.filter(group => new URL(group.board).hostname.endsWith(".myworkdayjobs.com")).map(group => group.board);

export function withEmployerGroupEvidence(job: OfficialJobDiscoveryCandidate): OfficialJobDiscoveryCandidate {
  if (job.verification !== "official-detail" || !job.company) return job;
  const url = new URL(job.url);
  const path = url.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}\//, "/");
  const group = groups.find(item => {
    const board = new URL(item.board);
    return url.origin === board.origin && path.startsWith(board.pathname + "/") && item.brand.test(job.company!);
  });
  if (!group) return job;
  return { ...job, employerGroup: { name: group.name, headquarters: group.headquarters, evidenceUrl: group.evidenceUrl } };
}
