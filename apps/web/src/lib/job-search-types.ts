import type { JobPlatform } from "./jd-source";

/** Parser outcomes are separate from a browser session's lifecycle or transport failure. */
export type JobSearchCaptureStatus = "ready" | "empty" | "login_required" | "verification_required" | "unknown_layout" | "oversized" | "unsupported_page";
export type JobSearchField = "url" | "title" | "company" | "locationText" | "salaryText" | "publicationText";

export type JobSearchCard = {
  platform: JobPlatform;
  url: string;
  title: string;
  company?: string;
  locationText?: string;
  salaryText?: string;
  publicationText?: string;
  /** Visible card excerpt, not a full JD, a source-verified vacancy or a personal fact. */
  cardText: string;
  evidence: { pageUrl: string; cardSelector: string; fields: Array<{ field: JobSearchField; selector: string; text: string }> };
};

export type JobSearchCaptureResult = {
  status: JobSearchCaptureStatus;
  platform: JobPlatform;
  url: string;
  cards: JobSearchCard[];
  partial: boolean;
  warnings: string[];
};
