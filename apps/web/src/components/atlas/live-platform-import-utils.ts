import {
  reviewedCardIdentity,
  reviewedCardsSearchPage,
  type PlatformSearchProvider,
} from "@better-me/source-adapters/browser-contracts";
import { getChinaDistricts, matchDisclosedChinaCities } from "./china-regions";

/**
 * A reviewed-card capture is tied to the search page that visibly contained
 * the card.  Live batch harvests can span multiple pages, so an import must
 * never submit cards from different evidence pages in one capture.
 */
export type EvidenceBackedLiveCard = {
  url: string;
  evidence: { pageUrl: string };
};

export type LiveReviewedCardsChunk<TCard extends EvidenceBackedLiveCard> = {
  pageUrl: string;
  cards: TCard[];
};

type CardWithLocationEvidence = EvidenceBackedLiveCard & {
  title: string;
  locationText?: string;
  cardText: string;
  evidence: {
    pageUrl: string;
    cardSelector: string;
    fields: Array<{ field: string; selector: string; text: string }>;
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recover a missing location field only when the job title itself explicitly
 * names a catalogued Chinese city and district together (for example
 * `C#工程师【上海-闵行区】`). The returned text is a literal excerpt from the
 * title, not a coordinate or a guessed office address.
 */
function disclosedCityDistrict(title: string): string | undefined {
  const matches = matchDisclosedChinaCities({ countryCode: "CN", raw: title });
  for (const match of matches) {
    const districts = getChinaDistricts(match.province.code, match.city.code)
      .filter((district) => title.includes(district.name))
      .sort((left, right) => right.name.length - left.name.length);
    const cityNames = [...new Set([
      match.matchedText,
      match.province.name,
      match.province.name.replace(/(?:省|市|自治区|特别行政区)$/u, ""),
      match.city.name,
    ].filter(Boolean))].sort((left, right) => right.length - left.length);

    for (const district of districts) {
      for (const city of cityNames) {
        if (city.length < 2) continue;
        const optionalCitySuffix = /市$/u.test(city) ? "" : "(?:市)?";
        const pattern = new RegExp(`${escapeRegExp(city)}${optionalCitySuffix}[\\s·•\\-—–,/，、（）()【】\\[\\]]{0,8}${escapeRegExp(district.name)}`, "u");
        const excerpt = title.match(pattern)?.[0];
        if (excerpt) return excerpt;
      }
    }
  }
  return undefined;
}

function attachDisclosedLocation<TCard extends EvidenceBackedLiveCard>(card: TCard): TCard {
  if (!card || typeof card !== "object" || !("title" in card) || !("cardText" in card) || !("evidence" in card)) return card;
  const candidate = card as TCard & CardWithLocationEvidence;
  if (typeof candidate.title !== "string" || typeof candidate.cardText !== "string"
    || typeof candidate.evidence?.cardSelector !== "string" || !Array.isArray(candidate.evidence.fields)
    || (typeof candidate.locationText === "string" && candidate.locationText.trim())) return card;

  const capturedLocation = candidate.evidence.fields.find((field) => field.field === "locationText");
  if (capturedLocation?.text.trim() && candidate.cardText.includes(capturedLocation.text.trim())) {
    return { ...candidate, locationText: capturedLocation.text.trim() } as TCard;
  }

  const titledLocation = disclosedCityDistrict(candidate.title);
  const titleEvidence = candidate.evidence.fields.find((field) => field.field === "title");
  let locationText = titledLocation && titleEvidence ? titledLocation : undefined;
  let selector = titleEvidence?.selector;
  if (!locationText) {
    // A company address mentioned elsewhere in the excerpt is not enough. Only
    // an explicitly labelled job/work location can recover a missing field.
    const labelled = candidate.cardText.match(/(?:^|[\n\r;；|｜])\s*(?:工作地点|工作地址|办公地点|办公地址|职位地点|岗位地点|职位地址)\s*[:：]\s*([^\n\r;；|｜]{1,120})/u)?.[1]?.trim();
    if (labelled) {
      locationText = disclosedCityDistrict(labelled);
      if (!locationText) {
        const cities = matchDisclosedChinaCities({ countryCode: "CN", raw: labelled });
        if (cities.some((match) => [match.matchedText, match.city.name, match.province.name].includes(labelled))) locationText = labelled;
      }
      selector = candidate.evidence.cardSelector;
    }
  }
  if (!locationText || !selector || !candidate.cardText.includes(locationText)) return card;

  return {
    ...candidate,
    locationText,
    evidence: {
      ...candidate.evidence,
      fields: [...candidate.evidence.fields.filter((field) => field.field !== "locationText"), { field: "locationText", selector, text: locationText }],
    },
  } as TCard;
}

function cardIdentity(card: EvidenceBackedLiveCard, provider: PlatformSearchProvider): string {
  const identity = reviewedCardIdentity(card.url, provider);
  if (!identity) throw new Error("Live card has no valid single-job identity for its provider.");
  return identity.id;
}

/**
 * Groups by the canonical evidence search page, removes duplicate listings
 * across pages, and chunks each page independently at the CAS limit.
 *
 * The first occurrence wins. This keeps the evidence attached to the first
 * page where the listing was observed and makes preview/import deterministic.
 */
export function groupLiveCardsForReviewedImport<TCard extends EvidenceBackedLiveCard>(
  cards: readonly TCard[],
  provider: PlatformSearchProvider,
  chunkSize = 50,
): LiveReviewedCardsChunk<TCard>[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunkSize must be a positive integer");
  }

  const groups = new Map<string, TCard[]>();
  const seen = new Set<string>();
  for (const capturedCard of cards) {
    const card = attachDisclosedLocation(capturedCard);
    const pageUrl = reviewedCardsSearchPage(card.evidence.pageUrl, provider);
    if (!pageUrl) throw new Error("Live card evidence does not point to the provider's official search page.");
    const identity = `${provider}\u0000${cardIdentity(card, provider)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const group = groups.get(pageUrl);
    if (group) group.push(card);
    else groups.set(pageUrl, [card]);
  }

  const chunks: LiveReviewedCardsChunk<TCard>[] = [];
  for (const [pageUrl, pageCards] of groups) {
    for (let offset = 0; offset < pageCards.length; offset += chunkSize) {
      chunks.push({ pageUrl, cards: pageCards.slice(offset, offset + chunkSize) });
    }
  }
  return chunks;
}
