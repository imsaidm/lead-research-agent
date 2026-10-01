import { existsSync } from 'node:fs';
import { parseCliArgs, resolveContact, resolveModel, USAGE } from './args.ts';
import { ConfigError, runLeadAgent } from './run.ts';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  const parsed = parseCliArgs(process.argv.slice(2), env);
  if (!parsed.ok) {
    if (parsed.help) {
      out(USAGE);
      return 0;
    }
    err(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { args } = parsed;
  const contact = resolveContact(env);
  if (!args.mock && !contact) err('warning: LEAD_AGENT_CONTACT is not set; OpenStreetMap asks clients to identify a contact. Set it in .env.');
  const mode = args.mock ? 'MOCK (offline)' : args.noLlm ? 'template (no LLM)' : 'Claude agent';
  out(`Lead Research Agent | ${args.niche} in ${args.city} | mode: ${mode}${args.mock && args.noLlm ? ' + template drafts' : ''}`);

  const result = await runLeadAgent({
    niche: args.niche,
    city: args.city,
    limit: args.limit,
    maxDrafts: args.drafts,
    maxSteps: args.maxSteps,
    budgetUsd: args.budget,
    offline: args.mock,
    noLlm: args.noLlm,
    model: resolveModel(env),
    contact,
    outRoot: args.out,
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
  });

  const { records, loop, saved, ledger } = result;
  const drafts = records.filter((r) => r.draft?.status === 'ok').length;
  out(`Found ${records.length} businesses; ${records.filter((r) => r.audit.status === 'ok').length} websites audited; ${drafts} drafts written.`);
  out(`Stop reason: ${loop.stopReason}${loop.detail ? ` (${loop.detail})` : ''}; agent steps: ${loop.steps}`);
  if (ledger) out(`LLM usage: ${ledger.totals.calls} calls, ${ledger.totals.inputTokens} in / ${ledger.totals.outputTokens} out tokens, ~$${ledger.totals.usd.toFixed(4)}${args.mock ? ' (mock estimate, nothing billed)' : ''}`);
  out(`Output: ${saved.outputDir} (${saved.files.join(', ')})`);
  out('Nothing was sent. Review drafts.md before any outreach.');
  if (['tool_error', 'llm_error', 'save_failed'].includes(loop.stopReason)) return 1;
  if (['saved', 'completed', 'end_turn'].includes(loop.stopReason)) return 0;
  return 3; // incomplete run (budget, max steps, refusal, truncation); partial results were written
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    err(e instanceof ConfigError ? `Config error: ${e.message}` : `Error: ${(e as Error).message}`);
    process.exit(e instanceof ConfigError ? 2 : 1);
  },
);
