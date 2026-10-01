import type { Draft, Finding, FindingId } from '../schemas.ts';
import { OPT_OUT_LINE, SIGNATURE_PLACEHOLDER } from './validate.ts';

/**
 * Deterministic outreach writer (no LLM). Used by --no-llm "template" mode and,
 * with a MOCK label, by the offline mock provider. It only restates audit
 * evidence, so its drafts pass the same validator as model-written drafts.
 */

export interface TemplateInput {
  readonly businessName: string;
  readonly niche: string;
  readonly findings: readonly Pick<Finding, 'id' | 'evidence' | 'weight'>[];
}

const secondsFrom = (evidence: string): string | null => /(\d+\.\d) seconds/.exec(evidence)?.[1] ?? null;
const yearFrom = (evidence: string): string | null => /\b((?:19|20)\d{2})\b/.exec(evidence)?.[1] ?? null;

const SENTENCES: Readonly<Record<FindingId, (evidence: string) => string | null>> = Object.freeze({
  no_website: () => "I was looking at local listings and couldn't find a website for your business.",
  website_unreachable: () => "When I tried the website on your listing, I couldn't load the site.",
  no_https: () => 'When I checked your homepage, it loaded without HTTPS, so browsers may mark it as not secure.',
  no_https_redirect: () => 'Your homepage opens over plain HTTP by default, even though an HTTPS version exists.',
  not_mobile_friendly: () => 'It also has no mobile viewport tag, so on phones it likely shows a shrunken desktop page.',
  slow_response: (e) => {
    const s = secondsFrom(e);
    return s ? `The homepage took ${s} seconds to respond when I tested it.` : null;
  },
  no_chat_widget: () => "I didn't see a live chat or chat assistant that could answer visitors after hours.",
  no_contact_form: () => "I also didn't spot a quote request form on the homepage.",
  outdated_copyright: (e) => {
    const y = yearFrom(e);
    return y ? `The footer still shows a copyright year of ${y}.` : null;
  },
  missing_meta_description: () => 'Your homepage has no meta description, which is the snippet shown in search results.',
  missing_title: () => 'Your homepage has no page title, which search results rely on.',
});

/** Findings that describe the same topic; a draft mentions at most one per topic. */
const TOPIC: Readonly<Partial<Record<FindingId, string>>> = Object.freeze({
  no_https_redirect: 'no_https',
  missing_title: 'missing_meta_description',
});
const topicOf = (id: FindingId): string => TOPIC[id] ?? id;

/** Highest-weight findings first, at most one per topic. */
export function pickFindings<F extends Pick<Finding, 'id' | 'weight'>>(findings: readonly F[], max = 2): readonly F[] {
  const sorted = [...findings].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return sorted.reduce<readonly F[]>((picked, f) => {
    if (picked.length >= max) return picked;
    if (picked.some((p) => topicOf(p.id) === topicOf(f.id))) return picked;
    return [...picked, f];
  }, []);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

export function writeTemplateDraft(input: TemplateInput, label: 'template' | 'mock'): Draft | null {
  const chosen = pickFindings(input.findings).flatMap((f) => {
    const sentence = SENTENCES[f.id](f.evidence);
    return sentence ? [{ id: f.id, sentence }] : [];
  });
  if (chosen.length === 0) return null;

  const prefix = label === 'mock' ? 'MOCK: ' : '';
  const topic = chosen[0]?.id === 'no_website' ? 'getting online' : 'your website';
  const subject = truncate(`${prefix}${input.businessName}: a note about ${topic}`, 60);
  const banner = label === 'mock' ? '[MOCK DRAFT - offline template, not written by Claude]\n\n' : '';
  const body = [
    `${banner}Hi ${input.businessName} team,`,
    chosen.map((c) => c.sentence).join(' '),
    'I help local service businesses fix issues like this. Would a short, no-obligation look be useful?',
    OPT_OUT_LINE,
    `${SIGNATURE_PLACEHOLDER}\n[Your Company]`,
  ].join('\n\n');

  return { subject, body, findings_used: chosen.map((c) => c.id) };
}
