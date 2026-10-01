import type { FindingId } from '../schemas.ts';

/**
 * Opportunity-score weights (0-100, higher = better lead for web/chatbot services).
 * Rationale:
 * - no_website (70): needs everything we sell; usually the best lead.
 * - website_unreachable (40): site down / erroring when checked.
 * - no_https, not_mobile_friendly (20 each): visible trust/usability problems.
 * - slow_response, no_chat_widget, no_contact_form, outdated_copyright (10 each).
 * - no_https_redirect, missing_meta_description, missing_title (5 each): minor.
 * - has_phone (+5): we can verify and reach the business.
 * The total is capped at 100.
 */
export const WEIGHTS: Readonly<Record<FindingId | 'has_phone', number>> = Object.freeze({
  no_website: 70,
  website_unreachable: 40,
  no_https: 20,
  not_mobile_friendly: 20,
  slow_response: 10,
  no_chat_widget: 10,
  no_contact_form: 10,
  outdated_copyright: 10,
  no_https_redirect: 5,
  missing_meta_description: 5,
  missing_title: 5,
  has_phone: 5,
});

export const THRESHOLDS = Object.freeze({
  slowResponseMs: 3_000,
  outdatedCopyrightYears: 2,
});
