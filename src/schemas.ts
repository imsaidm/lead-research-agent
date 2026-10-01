import { z } from 'zod';

export const BusinessIdSchema = z.string().regex(/^osm-(node|way|relation)-\d{1,15}$/, 'invalid business id');

export const BusinessSchema = z.object({
  id: BusinessIdSchema,
  name: z.string().min(1).max(200),
  niche: z.string().min(1).max(40),
  website: z.string().max(500).nullable(),
  phone: z.string().max(60).nullable(),
  address: z.string().max(300).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
});
export type Business = z.infer<typeof BusinessSchema>;

export const AUDIT_STATUSES = [
  'ok',
  'no_website',
  'invalid_url',
  'blocked_url',
  'robots_disallowed',
  'robots_unreachable',
  'fetch_failed',
  'http_error',
  'access_denied',
  'not_audited',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const AuditSchema = z.object({
  businessId: BusinessIdSchema,
  status: z.enum(AUDIT_STATUSES),
  requestedUrl: z.string().nullable(),
  finalUrl: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  https: z.boolean().nullable(),
  httpsAvailable: z.boolean().nullable(),
  redirected: z.boolean().nullable(),
  responseTimeMs: z.number().int().nonnegative().nullable(),
  htmlBytes: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  hasViewport: z.boolean().nullable(),
  title: z.string().max(200).nullable(),
  hasMetaDescription: z.boolean().nullable(),
  hasChatWidget: z.boolean().nullable(),
  chatVendor: z.string().max(40).nullable(),
  hasContactForm: z.boolean().nullable(),
  copyrightYear: z.number().int().nullable(),
  error: z.string().max(300).nullable(),
});
export type Audit = z.infer<typeof AuditSchema>;

export const FINDING_IDS = [
  'no_website',
  'website_unreachable',
  'no_https',
  'no_https_redirect',
  'not_mobile_friendly',
  'slow_response',
  'no_chat_widget',
  'no_contact_form',
  'outdated_copyright',
  'missing_meta_description',
  'missing_title',
] as const;
export type FindingId = (typeof FINDING_IDS)[number];

export interface Finding {
  readonly id: FindingId;
  readonly weight: number;
  /** Plain-language, verifiable statement backed by the audit. */
  readonly evidence: string;
}

export interface ScoredLead {
  readonly businessId: string;
  readonly score: number;
  readonly findings: readonly Finding[];
  readonly reasons: readonly string[];
}

export const DraftSchema = z
  .object({
    subject: z.string().min(1).max(60),
    body: z.string().min(1).max(2_000),
    findings_used: z.array(z.enum(FINDING_IDS)).min(1).max(2),
  })
  .strict();
export type Draft = z.infer<typeof DraftSchema>;

export type DraftWriter = 'claude' | 'mock' | 'template';

export type DraftResult =
  | { readonly status: 'ok'; readonly draft: Draft; readonly attempts: number; readonly writer: DraftWriter }
  | { readonly status: 'dropped'; readonly reason: string; readonly attempts: number; readonly retryable: boolean };
