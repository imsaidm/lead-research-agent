import { DraftSchema, type Audit, type Draft, type Finding } from '../schemas.ts';
import { matchedClaims } from './claims.ts';

/**
 * Guardrails for model-written outreach. Model output is untrusted: it must
 * parse with zod, respect length limits, include the opt-out and signature
 * placeholder, and only claim facts that the audit established.
 */
export const OPT_OUT_LINE = "Reply 'no thanks' and I won't follow up.";
export const SIGNATURE_PLACEHOLDER = '[Your Name]';
export const MAX_BODY_WORDS = 120;

export interface DraftContext {
  readonly findings: readonly Finding[];
  readonly audit: Audit;
  readonly businessName: string;
}

export type DraftValidation =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Canonical form before any check: NFKC folds fullwidth digits/percent signs to ASCII,
 * invisible format characters (zero-width joiners, bidi controls) are removed so they
 * cannot split words like "mo<ZWSP>bile" past the claim detectors.
 */
export const normalizeText = (s: string): string =>
  s.normalize('NFKC').replace(/\p{Cf}/gu, '')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Checked on the FULL text, business name included: a hostile OSM name cannot smuggle links or prices. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\d+(?:\.\d+)?\s*%|\bpercent\b/i, 'statistics/percentages are not allowed'],
  [/\$\s*\d|\bUSD\b|\bdollars?\b/i, 'prices are not allowed'],
  [/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.[a-z]{2,24}\b/i, 'links/domains are not allowed'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'email addresses are not allowed'],
  [/`|<\/?[a-z!]/i, 'markup/code is not allowed'],
];

/** Unverifiable claim types; checked with the business name removed ("Lone Star Plumbing" is not a star rating). */
const FORBIDDEN_CLAIMS: readonly (readonly [RegExp, string])[] = [
  [/competitor|\breviews?\b|\bratings?\b|\bstars?\b|losing (?:customers|business|leads|jobs|calls)|guarantee/i, 'claims about competitors, reviews or results are not allowed'],
];

const SECONDS_RE = /(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const NUMBER_WORDS = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundreds?|thousands?|millions?|dozens?)\b/i;

/** The business name is data, not a claim ("Mobile Plumbing Co" is not a mobile claim; "A1" is not a statistic). */
function withoutBusinessName(text: string, name: string): string {
  const normalized = normalizeText(name).trim();
  return normalized ? text.replace(new RegExp(escapeRe(normalized), 'gi'), ' ') : text;
}

function numberErrors(withoutName: string, ctx: DraftContext): readonly string[] {
  const seconds = ctx.audit.responseTimeMs === null ? null : ctx.audit.responseTimeMs / 1000;
  const secondErrors = [...withoutName.matchAll(SECONDS_RE)]
    .filter((m) => seconds === null || Math.abs(Number(m[1]) - seconds) > 0.15)
    .map((m) => `"${m[0]}" contradicts the measured response time (seconds)`);
  const withoutSeconds = withoutName.replace(SECONDS_RE, ' ');
  const yearErrors = [...withoutSeconds.matchAll(YEAR_RE)]
    .filter((m) => Number(m[0]) !== ctx.audit.copyrightYear)
    .map((m) => `year ${m[0]} is not the audited copyright year`);
  const leftover = withoutSeconds.replace(YEAR_RE, ' ');
  return [
    ...secondErrors,
    ...yearErrors,
    ...(/\p{Nd}/u.test(leftover) ? ['draft contains an unverifiable number'] : []),
    ...(NUMBER_WORDS.test(leftover) ? ['draft contains an unverifiable number word'] : []),
  ];
}

function claimErrors(text: string, draft: Draft, ctx: DraftContext): readonly string[] {
  const trueIds = new Set(ctx.findings.map((f) => f.id));
  const used = new Set(draft.findings_used);
  const claims = matchedClaims(text);

  const notFindings = draft.findings_used
    .filter((id) => !trueIds.has(id))
    .map((id) => `findings_used "${id}" is not an audit finding for this lead`);
  const unsupported = claims
    .filter((c) => !c.backedBy.some((id) => trueIds.has(id)))
    .map((c) => `unsupported claim: ${c.claim} (not found by the audit)`);
  const unlisted = claims
    .filter((c) => c.backedBy.some((id) => trueIds.has(id)) && !c.backedBy.some((id) => used.has(id)))
    .map((c) => `mentions ${c.claim} but no matching finding is listed in findings_used`);
  const unmentioned = draft.findings_used
    .filter((id) => !claims.some((c) => c.backedBy.includes(id)))
    .map((id) => `draft does not mention the claimed finding "${id}"`);
  return [...notFindings, ...unsupported, ...unlisted, ...unmentioned];
}

function formatErrors(draft: Draft): readonly string[] {
  const words = wordCount(draft.body);
  const optOut = OPT_OUT_LINE.toLowerCase().replace(/\.$/, '');
  return [
    ...(/[\r\n]/.test(draft.subject) ? ['subject must be a single line'] : []),
    ...(words > MAX_BODY_WORDS ? [`body must be at most ${MAX_BODY_WORDS} words (got ${words})`] : []),
    ...(!draft.body.toLowerCase().includes(optOut) ? [`missing opt-out line: ${OPT_OUT_LINE}`] : []),
    ...(!draft.body.includes(SIGNATURE_PLACEHOLDER) ? [`missing signature placeholder ${SIGNATURE_PLACEHOLDER}`] : []),
  ];
}

export function validateDraft(raw: unknown, ctx: DraftContext): DraftValidation {
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`) };
  }
  const draft: Draft = {
    ...parsed.data,
    body: normalizeText(parsed.data.body),
    subject: normalizeText(parsed.data.subject),
  };
  const text = `${draft.subject}\n${draft.body}`;
  const forbidden = FORBIDDEN.filter(([re]) => re.test(text)).map(([, message]) => message);
  const claimText = withoutBusinessName(text, ctx.businessName);
  const forbiddenClaims = FORBIDDEN_CLAIMS.filter(([re]) => re.test(claimText)).map(([, message]) => message);
  const errors = [...formatErrors(draft), ...forbidden, ...forbiddenClaims, ...claimErrors(claimText, draft, ctx), ...numberErrors(claimText, ctx)];
  return errors.length === 0 ? { ok: true, draft } : { ok: false, errors };
}
