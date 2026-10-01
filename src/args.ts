import { parseArgs } from 'node:util';
import { z } from 'zod';
import { NICHE_NAMES } from './config/niches.ts';
import { AGENT_DEFAULTS } from './config/settings.ts';

const ArgsSchema = z.object({
  niche: z.enum(NICHE_NAMES as [string, ...string[]], { message: `niche must be one of: ${NICHE_NAMES.join(', ')}` }),
  city: z.string().trim().min(2).max(100).regex(/^[\p{L}\p{N} ,.'-]+$/u, 'city may only contain letters, digits, spaces and , . \' -'),
  limit: z.coerce.number().int().min(1).max(50),
  drafts: z.coerce.number().int().min(0).max(10),
  maxSteps: z.coerce.number().int().min(1).max(50),
  budget: z.coerce.number().positive().max(5),
  mock: z.boolean(),
  noLlm: z.boolean(),
  out: z.string().min(1).max(200),
});
export type CliArgs = z.infer<typeof ArgsSchema>;

export const USAGE = `Usage: npm run agent -- --niche <${NICHE_NAMES.join('|')}> --city "<City, ST>" [options]

Options:
  --limit <n>       businesses to research (1-50, default ${AGENT_DEFAULTS.limit})
  --drafts <n>      outreach drafts for top leads (0-10, default ${AGENT_DEFAULTS.maxDrafts})
  --max-steps <n>   agent turn limit (default ${AGENT_DEFAULTS.maxSteps})
  --budget <usd>    LLM cost cap per run (default from LEAD_AGENT_BUDGET_USD or ${AGENT_DEFAULTS.budgetUsd})
  --mock            offline: fixture data + mock LLM (no network, no API key)
  --no-llm          template mode: real data, deterministic drafts, no API key
  --out <dir>       output root (default out)
  --help            show this help`;

export type ParseResult = { readonly ok: true; readonly args: CliArgs } | { readonly ok: false; readonly error: string; readonly help: boolean };

export function parseCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ParseResult {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        niche: { type: 'string' },
        city: { type: 'string' },
        limit: { type: 'string' },
        drafts: { type: 'string' },
        'max-steps': { type: 'string' },
        budget: { type: 'string' },
        mock: { type: 'boolean', default: false },
        'no-llm': { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    return { ok: false, error: (err as Error).message, help: false };
  }
  if (values.help) return { ok: false, error: '', help: true };

  const parsed = ArgsSchema.safeParse({
    niche: values.niche?.toLowerCase(),
    city: values.city,
    limit: values.limit ?? AGENT_DEFAULTS.limit,
    drafts: values.drafts ?? AGENT_DEFAULTS.maxDrafts,
    maxSteps: values['max-steps'] ?? AGENT_DEFAULTS.maxSteps,
    budget: values.budget ?? env.LEAD_AGENT_BUDGET_USD ?? AGENT_DEFAULTS.budgetUsd,
    mock: values.mock,
    noLlm: values['no-llm'],
    out: values.out ?? 'out',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `--${String(i.path[0] ?? 'args')}: ${i.message}`).join('\n'), help: false };
  }
  return { ok: true, args: parsed.data };
}

const MODEL_RE = /^claude-[a-z0-9.-]{3,60}$/;
const CONTACT_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$|^https:\/\/[\w./-]+$/;

export function resolveModel(env: Readonly<Record<string, string | undefined>>): string {
  const model = env.LEAD_AGENT_MODEL?.trim() || AGENT_DEFAULTS.model;
  if (!MODEL_RE.test(model)) throw new Error(`LEAD_AGENT_MODEL "${model.slice(0, 60)}" is not a valid Claude model id`);
  return model;
}

/** Contact for the User-Agent. null = not configured (live runs warn). Reserved example domains are refused: OSM blocks them. */
export function resolveContact(env: Readonly<Record<string, string | undefined>>): string | null {
  const contact = env.LEAD_AGENT_CONTACT?.trim();
  if (!contact) return null;
  if (!CONTACT_RE.test(contact)) throw new Error('LEAD_AGENT_CONTACT must be an email address or an https URL');
  if (/[@./]example\.(?:com|org|net)\b|\.example\b|\.(?:test|invalid|localhost)\b/i.test(contact)) {
    throw new Error('LEAD_AGENT_CONTACT must be a real address you read (placeholder domains are blocked by OpenStreetMap)');
  }
  return contact;
}
