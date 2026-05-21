import { ALLOWLIST } from './compiler.js';
import { generateJson } from './llm.js';

// Cheap title+abstract triage for high-volume feeds (arXiv). Reuses the
// compiler's topic ALLOWLIST so that what survives triage is the same notion
// of "relevant" the categorizer applies later — just decided up front from the
// title/abstract, on Flash, in batches, instead of ingesting and categorizing
// every paper individually.

export interface PrefilterCandidate {
  title: string;
  abstract: string;
}

// How many candidates to send per Flash call. arXiv RSS pulls are bursty; this
// keeps each prompt small enough to stay fast and cheap.
const BATCH_SIZE = 50;
// Abstracts can be long; the title + a lead chunk is plenty to judge relevance.
const ABSTRACT_CHARS = 1200;

const SCHEMA = {
  type: 'object',
  properties: {
    relevant: {
      type: 'array',
      description: 'indices of papers to KEEP (relevant to the taxonomy)',
      items: { type: 'integer' },
    },
  },
  required: ['relevant'],
} as const;

interface PrefilterResult {
  relevant: number[];
}

function taxonomyBlock(): string {
  return ALLOWLIST.map(t => `- ${t.slug}: ${t.description}`).join('\n');
}

function batchPrompt(batch: PrefilterCandidate[]): string {
  const list = batch
    .map((c, i) => {
      const abstract = c.abstract.replace(/\s+/g, ' ').trim().slice(0, ABSTRACT_CHARS);
      return `${i}. ${c.title}\n   ${abstract}`;
    })
    .join('\n\n');

  return `You are triaging arXiv papers for a high-signal AI wiki written for a Staff Engineer who:
- uses AI to be more effective at engineering and product work (coding agents, context engineering, PRDs, design, code review, debugging),
- builds their own agents (architecture, tools, prompts, context, evals).

KEEP a paper only if its title/abstract clearly indicates it would meaningfully update one of these wiki topics:
${taxonomyBlock()}

Be strict. Most arXiv papers — pure theory, narrow ML benchmarks, vision/robotics/bio, incremental results — are NOT relevant to this practitioner wiki. When in doubt, exclude.

Papers (0-indexed):
${list}

Return the indices of the papers to KEEP.`;
}

// Returns the indices (into `candidates`) that should be ingested. On error,
// fails open for that batch (keeps everything) so a transient LLM failure
// never silently drops content.
export async function prefilterRelevant(
  candidates: PrefilterCandidate[],
): Promise<Set<number>> {
  const keep = new Set<number>();
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    try {
      const res = await generateJson<PrefilterResult>({
        tier: 'flash',
        prompt: batchPrompt(batch),
        schema: SCHEMA,
      });
      for (const local of res.relevant ?? []) {
        if (Number.isInteger(local) && local >= 0 && local < batch.length) {
          keep.add(start + local);
        }
      }
    } catch (err) {
      console.error(
        `[prefilter] batch ${start}-${start + batch.length} failed, keeping all:`,
        err instanceof Error ? err.message : String(err),
      );
      for (let i = 0; i < batch.length; i++) keep.add(start + i);
    }
  }
  return keep;
}
