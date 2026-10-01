import type { Audit, Finding, FindingId } from '../schemas.ts';
import { THRESHOLDS, WEIGHTS } from './weights.ts';

/**
 * Turns an audit into verifiable findings. Only facts the audit actually
 * established become findings; unknown (null) signals are never claimed.
 * These findings are the ONLY facts outreach drafts may mention.
 */
const make = (id: FindingId, evidence: string): Finding => Object.freeze({ id, weight: WEIGHTS[id], evidence });

export function deriveFindings(audit: Audit, nowYear: number): readonly Finding[] {
  if (audit.status === 'no_website') {
    return [make('no_website', 'No website is listed for this business in OpenStreetMap.')];
  }
  if (audit.status === 'fetch_failed' || audit.status === 'http_error') {
    const detail = audit.httpStatus ? ` (HTTP ${audit.httpStatus})` : '';
    return [make('website_unreachable', `The listed website could not be loaded when checked${detail}.`)];
  }
  if (audit.status !== 'ok') return [];

  const findings: Finding[] = [];
  if (audit.https === false && audit.httpsAvailable === false) {
    findings.push(make('no_https', 'The homepage is served without HTTPS and no HTTPS version responded.'));
  } else if (audit.https === false && audit.httpsAvailable === true) {
    findings.push(make('no_https_redirect', 'The homepage loads over plain HTTP; an HTTPS version exists but visitors are not redirected to it.'));
  }
  if (audit.hasViewport === false) {
    findings.push(make('not_mobile_friendly', 'The homepage has no mobile viewport meta tag, so it likely renders as a shrunken desktop page on phones.'));
  }
  if (audit.responseTimeMs !== null && audit.responseTimeMs > THRESHOLDS.slowResponseMs) {
    findings.push(make('slow_response', `The homepage took ${(audit.responseTimeMs / 1000).toFixed(1)} seconds to respond when checked.`));
  }
  if (audit.hasChatWidget === false) {
    findings.push(make('no_chat_widget', 'No live chat or chat assistant was detected on the homepage.'));
  }
  if (audit.hasContactForm === false) {
    findings.push(make('no_contact_form', 'No contact or quote request form was detected on the homepage.'));
  }
  if (audit.copyrightYear !== null && audit.copyrightYear <= nowYear - THRESHOLDS.outdatedCopyrightYears) {
    findings.push(make('outdated_copyright', `The footer copyright year is ${audit.copyrightYear}.`));
  }
  if (audit.hasMetaDescription === false) {
    findings.push(make('missing_meta_description', 'The homepage has no meta description for search results.'));
  }
  if (audit.title === null) {
    findings.push(make('missing_title', 'The homepage has no page title.'));
  }
  return Object.freeze(findings);
}
