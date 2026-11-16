export type FormattedAtlasAddress = {
  regionPrefix: string;
  streetDetail: string;
  landmark: string;
  conciseLabel: string;
  fullText: string;
};

export type AtlasAddressDisplayParts = {
  primary: string;
  secondary: string;
};

const ADMIN_PREFIX_RE =
  /^((?:[\u4e00-\u9fa5]{2,5}(?:省|自治区|特别行政区))?(?:北京市|上海市|天津市|重庆市|[\u4e00-\u9fa5]{2,7}(?:市|自治州|盟|地区))?(?:[\u4e00-\u9fa5]{2,7}(?:新区|区|县|旗))?)(?:\s*[·,，/-]\s*)?(.{4,})$/;

const TRAILING_STREET_BLOCK_RE =
  /^(.*?(?:大道|公路|环路?|大街|路|街|巷|弄|胡同|道)\s*[甲乙丙丁A-Za-z0-9－—-]*\d+\s*(?:号院|号楼|号|弄|支弄|栋|幢)(?:\s*(?:[（(][^）)]{1,10}[）)]|[东南西北中前后上下左右甲乙丙丁A-Za-z0-9-]+(?:区|期|幢|栋|座|号楼|号|单元)))*)(?:\s*[·,，/-]\s*|\s*)(.{3,})$/;

const FLOOR_NOISE_RE = /^(?:[A-Za-z0-9-]+)?(?:楼|层|室|座|栋|单元|号|门|馆|[Ff])(?:[\dA-Za-z-]*)$/;

function cleanRegionPrefix(raw: string): { prefix: string; rest: string } {
  const match = ADMIN_PREFIX_RE.exec(raw);
  if (!match) return { prefix: "", rest: raw };
  const prefix = match[1]?.trim() ?? "";
  const rest = match[2]?.trim() ?? "";
  if (!prefix || rest.length < 4) return { prefix: "", rest: raw };
  // Guard against treating a park section like "西区9号楼" or "一期东区..." as a municipal district
  // unless an explicit province or city preceded it.
  const hasHigherAdmin = /(?:省|市|自治区|特别行政区|自治州)/.test(prefix);
  if (!hasHigherAdmin && /(?:[东南西北中上下前后期园院]区)$/.test(prefix)) {
    return { prefix: "", rest: raw };
  }
  return { prefix, rest };
}

function clampAddress(value: string, max = 28): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Splits raw office addresses into administrative context, street number, and building landmark
 * so map labels stay scannable without truncating landmark names behind city prefixes.
 */
export function formatAtlasAddress(raw: string): FormattedAtlasAddress {
  const fullText = raw.replace(/\s+/g, " ").trim();
  if (!fullText) {
    return { regionPrefix: "", streetDetail: "", landmark: "", conciseLabel: "", fullText: "" };
  }

  const { prefix: regionPrefix, rest } = cleanRegionPrefix(fullText);
  const splitMatch = TRAILING_STREET_BLOCK_RE.exec(rest);
  if (splitMatch) {
    const streetDetail = splitMatch[1]!.trim();
    const tail = splitMatch[2]!.trim();
    const isNoiseOnly = FLOOR_NOISE_RE.test(tail) || /^[（(].*[）)]$/.test(tail);
    if (!isNoiseOnly) {
      return {
        regionPrefix,
        streetDetail,
        landmark: tail,
        conciseLabel: clampAddress(tail, 24),
        fullText,
      };
    }
  }

  return {
    regionPrefix,
    streetDetail: rest,
    landmark: "",
    conciseLabel: clampAddress(rest, 28),
    fullText,
  };
}

/**
 * Formats an address into a primary landmark/street headline and an optional secondary
 * district/street context line for markers, hover cards, and address selectors.
 */
export function splitAtlasAddressDisplay(raw: string): AtlasAddressDisplayParts {
  const parsed = formatAtlasAddress(raw);
  if (parsed.landmark) {
    return {
      primary: parsed.landmark,
      secondary: parsed.regionPrefix ? `${parsed.regionPrefix} · ${parsed.streetDetail}` : parsed.streetDetail,
    };
  }
  if (parsed.regionPrefix) {
    return {
      primary: parsed.streetDetail,
      secondary: parsed.regionPrefix,
    };
  }
  return {
    primary: parsed.fullText || raw,
    secondary: "",
  };
}
