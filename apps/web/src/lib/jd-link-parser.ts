import { fetchChatCompletion, type LlmConfig } from "@better-me/core";
import { extractJdLink, extractJdLinkWithAutoBrowser, isJdLinkOnly, type JdImportResult } from "./jd-import";
import type { JdProvenance } from "./jd-source";
import type { PlatformDetailLocations } from "@better-me/source-adapters/platform-detail-locations";

export interface ParsedJobInfo {
  title: string;
  company: string;
  salary: string;
  location: string;
  description: string;
  sourceUrl?: string;
  sourcePlatform?: string;
}

const COMMON_PLATFORM_SUFFIXES = [
  /\s*[-_—|]\s*(?:BOSS直聘|boss直聘|Boss直聘|BOSS|zhipin\.com).*$/i,
  /\s*[-_—|]\s*(?:猎聘|猎聘网|liepin\.com).*$/i,
  /\s*[-_—|]\s*(?:前程无忧|51job|51JOB|jobs\.51job\.com).*$/i,
  /\s*[-_—|]\s*(?:智联招聘|智联|zhaopin\.com).*$/i,
  /\s*[-_—|]\s*(?:拉勾|拉勾网|lagou\.com).*$/i,
  /\s*[-_—|]\s*(?:LinkedIn|领英).*$/i,
  /\s*[-_—|]\s*(?:SEEK|Seek|seek\.com).*$/i,
  /\s*[-_—|]\s*(?:Indeed|indeed\.com).*$/i,
  /\s*[-_—|]\s*(?:GradConnection|gradconnection\.com).*$/i,
];

// Handles: 40k-60k, 40-60k, 40K-60K·16薪, 30-50万, 800-1000元/天
const SALARY_REGEX = /(?:薪资[：:\s]*)?(\d+(?:\.\d+)?\s*[kK千万元]?\s*[-~至到/]\s*\d+(?:\.\d+)?\s*[kK千万元](?:\s*[·*xX/]\s*\d+薪)?(?:\s*[·/]\s*(?:月|年|天))?)/i;
const SALARY_ANNUAL_REGEX = /(?:薪资[：:\s]*)?(\d+(?:\.\d+)?\s*[-~至到/]\s*\d+(?:\.\d+)?\s*万(?:\s*[·*xX/]\s*\d+薪)?(?:\s*[·/]\s*(?:月|年))?)/i;
const SALARY_GLOBAL_REGEX = /(?:salary[：:\s]*)?(\$\s*\d+[\d,]*(?:\.\d+)?\s*[-~至到/]\s*\$?\s*\d+[\d,]*(?:\.\d+)?\s*(?:\/\s*(?:yr|year|mo|month|hr|hour))?)/i;

const MAJOR_CITIES = [
  "北京", "上海", "深圳", "广州", "杭州", "成都", "武汉", "南京", "西安", "苏州",
  "厦门", "天津", "重庆", "青岛", "大连", "长沙", "宁波", "郑州", "合肥", "福州",
  "无锡", "珠海", "佛山", "东莞", "常州", "昆明", "沈阳", "济南", "香港", "澳门", "台北",
  "远程", "Remote",
];

function isLikelyCityName(text: string): boolean {
  const t = text.trim();
  if (t.length > 8) return false;
  return MAJOR_CITIES.some((city) => t === city || (t.includes(city) && t.length <= 5));
}

export function cleanPlatformTitle(rawTitle: string): { title: string; company?: string; location?: string } {
  let text = rawTitle.trim();
  // Strip trailing platform markers
  for (const pattern of COMMON_PLATFORM_SUFFIXES) {
    text = text.replace(pattern, "").trim();
  }

  let extractedLocation: string | undefined;
  let extractedCompany: string | undefined;

  // Pattern: 【城市】... or 【公司】...
  const bracketMatch = text.match(/^[【「『]([^】」』]+)[】」』]\s*(.*)$/);
  if (bracketMatch) {
    const bracketContent = bracketMatch[1]!.trim();
    text = bracketMatch[2]!.trim();

    if (isLikelyCityName(bracketContent)) {
      extractedLocation = bracketContent;
    } else if (/公司|企业|集团|科技|网络|工作室|实验室|有限/i.test(bracketContent)) {
      extractedCompany = bracketContent;
    } else if (!text) {
      // Bracket had the whole title
      text = bracketContent;
    }
  }

  // Strip leading action words like 招聘 / 诚聘 / 急聘
  text = text.replace(/^(?:诚聘|招聘|急聘|热招|急招)\s*/g, "").trim();

  // Pattern: 职位名称_公司名称招聘 or 职位名称-公司名称 or 职位名称 某某公司
  const delimiterMatch = text.match(/^(.*?)\s*[_—|-]\s*(.*?)(?:招聘)?$/);
  if (delimiterMatch) {
    const part1 = delimiterMatch[1]!.trim();
    const part2 = delimiterMatch[2]!.trim();
    if (part2 && /公司|企业|集团|科技|网络|技术|工作室|实验室|有限/i.test(part2)) {
      text = part1;
      extractedCompany = extractedCompany || part2;
    } else if (part1 && /公司|企业|集团|科技|网络|技术|工作室|实验室|有限/i.test(part1)) {
      extractedCompany = extractedCompany || part1;
      text = part2;
    } else if (part2 && part2.length <= 30 && !extractedCompany) {
      text = part1;
      extractedCompany = part2;
    }
  }

  // If title has a space separating job title and company (e.g. "资深工程经理 某智能硬件科技有限公司")
  const spaceMatch = text.match(/^([^\s]{2,20})\s+([^\s]{2,30}(?:公司|企业|集团|科技|网络|工作室|实验室|有限[^\s]*))$/);
  if (spaceMatch) {
    text = spaceMatch[1]!.trim();
    extractedCompany = extractedCompany || spaceMatch[2]!.trim();
  }

  // Clean trailing "招聘"
  text = text.replace(/(?:高薪)?诚聘.*$/g, "").replace(/招聘$/g, "").trim();

  return {
    title: isLikelyCityName(text) ? "" : text,
    company: extractedCompany,
    location: extractedLocation,
  };
}

export function parseJobTextHeuristics(
  rawInput: string,
  extractedText: string,
  provenance?: JdProvenance | null,
  detailLocations?: PlatformDetailLocations
): ParsedJobInfo {
  let title = "";
  let company = "";
  let salary = "";
  let location = "";
  const description = extractedText.trim() || rawInput.trim();

  // 1. Location from detailLocations
  if (detailLocations?.locations && detailLocations.locations.length > 0) {
    const firstLoc = detailLocations.locations[0]!;
    const parts = [firstLoc.city, firstLoc.streetAddress || firstLoc.region].filter(Boolean);
    if (parts.length > 0) {
      location = parts.join(" · ");
    }
  }

  // 2. Title and Company from Provenance
  if (provenance?.title) {
    const cleaned = cleanPlatformTitle(provenance.title);
    if (cleaned.title) title = cleaned.title;
    if (cleaned.company) company = cleaned.company;
    if (cleaned.location && !location) location = cleaned.location;
  }

  // 3. Extract from raw share input (e.g. mobile share text)
  if (rawInput && (!title || !company || !location || !salary)) {
    // Isolate the header segment before salary, location, or responsibilities
    const headerSegment = rawInput.split(/(?:薪资|地点|工作地点|工作城市|岗位职责|工作职责|任职要求|任职资格|职位描述|福利待遇|职责|要求|https?:\/\/)/i)[0]?.trim() || "";
    if (headerSegment) {
      const headerCleaned = cleanPlatformTitle(headerSegment);
      if (!title && headerCleaned.title && !isLikelyCityName(headerCleaned.title)) title = headerCleaned.title;
      if (!company && headerCleaned.company) company = headerCleaned.company;
      if (!location && headerCleaned.location) location = headerCleaned.location;
    }

    // Check bracket in raw input: e.g. 【公司/职位】 or 【杭州·架构师】
    const shareBracketMatch = rawInput.match(/【([^】]+)】/);
    if (shareBracketMatch) {
      const content = shareBracketMatch[1]!.trim();
      const cleaned = cleanPlatformTitle(content);
      if (!title && cleaned.title && !isLikelyCityName(cleaned.title)) title = cleaned.title;
      if (!company && cleaned.company) company = cleaned.company;
      if (!location && cleaned.location) location = cleaned.location;

      // Handle combined bracket like 【杭州·架构师】
      if (content.includes("·") || content.includes("/")) {
        const parts = content.split(/[·/]/).map((p) => p.trim());
        for (const p of parts) {
          if (isLikelyCityName(p) && !location) location = p;
          else if (!title && p.length >= 2 && p.length <= 15) title = p;
        }
      }
    }

    // Company from rawInput: search for known company suffixes (exclude bare 技术)
    if (!company) {
      const companyMatch = rawInput.match(/([^\s，。！？【】《》]{2,20}(?:科技公司|网络公司|软件公司|信息公司|有限公司|有限责任公司|股份有限公司|科技集团|网络集团|集团公司|企业集团|科技|集团|公司|企业|工作室|实验室))/i);
      if (companyMatch) {
        const matchedComp = companyMatch[1]!.trim();
        if (matchedComp !== title && !isLikelyCityName(matchedComp)) {
          company = matchedComp;
        }
      }
    }
  }

  // 4. Extract from extracted text lines
  const lines = extractedText.split("\n").map((l) => l.trim()).filter(Boolean);

  // If title is still missing, inspect first lines
  if (!title && lines.length > 0) {
    for (const line of lines.slice(0, 5)) {
      if (!/^(?:岗位职责|工作职责|任职要求|任职资格|福利待遇|薪资|地点|关于我们|https?:\/\/)/i.test(line) && line.length >= 2 && line.length <= 60) {
        const cleaned = cleanPlatformTitle(line);
        if (cleaned.title && !isLikelyCityName(cleaned.title)) {
          title = cleaned.title;
          if (cleaned.company && !company) company = cleaned.company;
          if (cleaned.location && !location) location = cleaned.location;
          break;
        }
      }
    }
  }

  // If company is still missing, check lines 1 to 5
  if (!company && lines.length > 1) {
    for (const line of lines.slice(0, 5)) {
      if (line !== title && /公司|企业|集团|科技|网络|技术|工作室|实验室|有限公司/i.test(line) && line.length <= 40 && !/职责|要求|关于我们/i.test(line)) {
        company = line.replace(/^(?:公司名称|所属企业|招聘公司|公司)[：:\s]*/, "").trim();
        break;
      }
    }
  }

  // 5. Salary extraction from lines, text, or rawInput
  const fullTextToScan = `${rawInput}\n${extractedText}`;
  const salaryMatch =
    fullTextToScan.match(SALARY_REGEX) ||
    fullTextToScan.match(SALARY_ANNUAL_REGEX) ||
    fullTextToScan.match(SALARY_GLOBAL_REGEX);

  if (salaryMatch) {
    salary = salaryMatch[1]!.trim();
  } else {
    // Explicit "薪资：" label search
    const explicitSalary = fullTextToScan.match(/(?:薪资范围|薪资待遇|薪酬|薪水|薪资)[：:\s]*([^\n,，;；]{2,30})/i);
    if (explicitSalary) {
      salary = explicitSalary[1]!.trim();
    }
  }

  // 6. Location extraction if still missing
  if (!location) {
    const explicitLoc = fullTextToScan.match(/(?:工作地点|工作城市|工作地址|工作地区|地点|城市|坐标)[：:\s]*([^,，;；\n\r]+?)(?=\s*(?:岗位职责|工作职责|任职要求|任职资格|职位描述|福利待遇|薪资|要求|职责|点击|https?:\/\/|$))/i);
    if (explicitLoc) {
      location = explicitLoc[1]!.trim();
    } else {
      for (const city of MAJOR_CITIES) {
        const cityRegex = new RegExp(`(?:^|\\s|[【(（·])(${city}(?:[·\\s/-][\\u4e00-\\u9fa5\\w]+)?)(?:$|\\s|[】)）·，,])`);
        const found = fullTextToScan.match(cityRegex);
        if (found) {
          location = found[1]!.trim();
          break;
        }
      }
      if (!location) {
        const addressLine = fullTextToScan.slice(0, 800).match(/((?:北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|厦门|天津|重庆|青岛|大连|长沙|宁波|郑州|合肥|福州|无锡|珠海|佛山|东莞)[市省]?(?:\s*[^\n，。；！？]{2,30})?)/);
        if (addressLine && addressLine[1]!.trim() !== title) {
          location = addressLine[1]!.trim();
        }
      }
    }
  }

  return {
    title: title || "目标职位",
    company: company || "目标企业",
    salary,
    location,
    description,
    sourceUrl: provenance?.url,
    sourcePlatform: provenance?.platform,
  };
}

export async function parseJobWithLlm(
  text: string,
  llmConfig: LlmConfig,
  baseInfo: ParsedJobInfo,
  _signal?: AbortSignal
): Promise<ParsedJobInfo> {
  if (!llmConfig.apiKey?.trim() && llmConfig.provider !== "ollama") {
    return baseInfo;
  }

  const needsRefinement =
    baseInfo.title === "目标职位" ||
    baseInfo.company === "目标企业" ||
    !baseInfo.salary ||
    !baseInfo.location;

  if (!needsRefinement) {
    return baseInfo;
  }

  const prompt = `请从以下招聘信息或JD中精确提取职位名称、公司名称、薪资范围、工作地点。
请直接返回JSON对象，包含且仅包含以下四个字段：
{
  "title": "职位名称（如资深前端工程师）",
  "company": "招聘企业名称（如某某科技）",
  "salary": "薪资待遇（如30k-50k·16薪，无明确说明则留空字符串）",
  "location": "工作地点或城市（如上海浦东，无明确说明则留空字符串）"
}

招聘信息文本：
${text.slice(0, 3000)}`;

  try {
    const content = await fetchChatCompletion(llmConfig, [
      { role: "system", content: "You are a professional HR data extraction assistant. Output pure JSON only." },
      { role: "user", content: prompt },
    ]);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        title?: string;
        company?: string;
        salary?: string;
        location?: string;
      };
      return {
        ...baseInfo,
        title: (parsed.title?.trim() && parsed.title !== "目标职位") ? parsed.title.trim() : baseInfo.title,
        company: (parsed.company?.trim() && parsed.company !== "目标企业") ? parsed.company.trim() : baseInfo.company,
        salary: parsed.salary?.trim() || baseInfo.salary,
        location: parsed.location?.trim() || baseInfo.location,
      };
    }
  } catch {
    // If LLM times out or errors, fall back to base heuristics gracefully
  }

  return baseInfo;
}

export async function extractAndParseJobLink(
  input: string,
  options: {
    signal: AbortSignal;
    mode?: "static" | "browser" | "auto-browser";
    llmConfig?: LlmConfig;
  }
): Promise<ParsedJobInfo> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请粘贴岗位分享链接或招聘信息。");
  }

  let importResult: JdImportResult | null = null;
  let importError: Error | null = null;

  try {
    if (options.mode === "auto-browser") {
      importResult = await extractJdLinkWithAutoBrowser(trimmed, options.signal);
    } else {
      importResult = await extractJdLink(trimmed, options.signal, options.mode || "static");
    }
  } catch (err) {
    if (options.mode === "browser") {
      try {
        importResult = await extractJdLinkWithAutoBrowser(trimmed, options.signal);
      } catch (autoErr) {
        importError = autoErr instanceof Error ? autoErr : new Error(String(autoErr));
      }
    } else {
      importError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // If extraction succeeded via native service:
  if (importResult) {
    const heuristics = parseJobTextHeuristics(
      trimmed,
      importResult.text,
      importResult.provenance,
      importResult.detailLocations
    );

    if (options.llmConfig) {
      return await parseJobWithLlm(importResult.text, options.llmConfig, heuristics, options.signal);
    }
    return heuristics;
  }

  // If extraction failed because of unsupported domain or plain text with link:
  // Check if user pasted job description text or mobile share containing text
  if (trimmed.length >= 20 && !isJdLinkOnly(trimmed)) {
    const heuristics = parseJobTextHeuristics(trimmed, trimmed, null);
    if (options.llmConfig) {
      return await parseJobWithLlm(trimmed, options.llmConfig, heuristics, options.signal);
    }
    return heuristics;
  }

  // Re-throw the extraction error if it was a dedicated link-only failure
  throw importError || new Error("未能成功读取岗位链接，请确认链接有效或直接粘贴 JD 正文。");
}
