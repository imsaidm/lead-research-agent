import type { FindingId } from '../schemas.ts';

/**
 * Claim detectors: phrases a draft can use to talk about a website problem.
 * Each claim lists the findings that can back it. If a draft's text matches a
 * claim, at least one of those findings must be true for the lead (and listed
 * in findings_used). Absence claims ("no HTTPS") are separate from mentions
 * ("HTTPS") so a lead whose HTTPS merely lacks a redirect cannot be told it
 * has no HTTPS at all.
 */
export interface ClaimDetector {
  readonly claim: string;
  readonly pattern: RegExp;
  readonly backedBy: readonly FindingId[];
}

const NEGATION = String.raw`(?:no|without(?:\s+an?)?|lacks?(?:\s+an?)?|missing(?:\s+an?)?|(?:has|have)\s+no|(?:don'?t|doesn'?t|do\s+not|does\s+not|didn'?t|did\s+not|isn'?t|is\s+not|wasn'?t|was\s+not)\s+(?:have|has|use|using|support|find|see|on|served\s+over|load(?:ed|ing)?\s+over)(?:\s+(?:an?|your))?|(?:couldn'?t|could\s+not|can'?t|cannot)\s+(?:find|see)(?:\s+(?:an?|your))?|not\s+(?:using|on|served\s+over|loaded\s+over))`;

export const CLAIMS: readonly ClaimDetector[] = Object.freeze([
  {
    claim: 'no website',
    pattern: new RegExp(String.raw`\b${NEGATION}\s+(?:business\s+|own\s+)?(?:web\s?site|site|online\s+presence|web\s+presence)\b|\bnot\s+online\b`, 'i'),
    backedBy: ['no_website'],
  },
  {
    claim: 'website unreachable',
    pattern: /\b(?:site|website|homepage|page)\s+(?:was|is|seemed|appeared)\s+(?:down|unreachable|offline|broken)\b|\b(?:couldn'?t|could not|can'?t|cannot|wasn'?t able to|was unable to)\s+(?:load|open|reach)\s+(?:your|the)\s+(?:site|website|homepage|page)\b|\breturned an error\b|\berror page\b/i,
    backedBy: ['website_unreachable'],
  },
  {
    claim: 'no HTTPS',
    pattern: new RegExp(String.raw`\b${NEGATION}\s+(?:https|ssl|tls|secure\s+connection|certificate|encryption)\b|not\s+secure|insecure|unencrypted`, 'i'),
    backedBy: ['no_https'],
  },
  { claim: 'HTTPS', pattern: /\bhttps\b|\bssl\b|\btls\b|secure connection|padlock|certificate|encrypt/i, backedBy: ['no_https', 'no_https_redirect'] },
  { claim: 'mobile', pattern: /\bmobile|smartphones?|phone screens?|viewport|responsive|small screens?/i, backedBy: ['not_mobile_friendly'] },
  {
    claim: 'speed',
    pattern: /\bslow|load(?:ing)?\s+(?:time|speed)|seconds?\s+to\s+(?:load|respond)|\btook\s+(?:about\s+|around\s+|roughly\s+)?[\d.]+\s*s(?:ec(?:ond)?s?)?\b|page speed/i,
    backedBy: ['slow_response'],
  },
  {
    claim: 'chat',
    pattern: /\blive[- ]?chat|\bchat\s?(?:widget|box|bubble|assistant|bot)|chatbot|\bai assistant|virtual assistant|\bchat\b\s+on\s+(?:your|the)\s+(?:site|website|homepage)/i,
    backedBy: ['no_chat_widget'],
  },
  {
    claim: 'contact form',
    pattern: /contact form|quote form|request form|\bweb ?form|online form|booking form|enquiry form|inquiry form|\bform\b\s+on\s+(?:your|the)/i,
    backedBy: ['no_contact_form'],
  },
  { claim: 'copyright', pattern: /copyright|©|\(c\)|\bfooter/i, backedBy: ['outdated_copyright'] },
  { claim: 'meta description', pattern: /meta description|search snippet/i, backedBy: ['missing_meta_description'] },
  { claim: 'page title', pattern: /page title|title tag/i, backedBy: ['missing_title'] },
  {
    claim: 'search visibility',
    pattern: /search (?:results|listing)|google (?:results|search|listing)|\bseo\b/i,
    backedBy: ['missing_meta_description', 'missing_title'],
  },
]);

export function matchedClaims(text: string): readonly ClaimDetector[] {
  return CLAIMS.filter((c) => c.pattern.test(text));
}
