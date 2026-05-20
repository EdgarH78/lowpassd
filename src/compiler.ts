import { config } from './config.js';
import { generateJson, generateText, type Tier } from './llm.js';
import { generateNewspaper, saveIssue, type ArticleForNewspaper } from './newspaper.js';
import { getText, listObjects, moveObject, putText } from './storage.js';

// ---- ALLOWLIST -----------------------------------------------------------
// The categorizer can only assign articles to slugs in this list (enforced
// via the response schema `enum` constraint). Articles that don't fit any
// slug are dropped to wiki/rejected.log instead of being compiled.

export interface TopicDef {
  slug: string;
  description: string;
}

export const ALLOWLIST: TopicDef[] = [
  // Coding tools (per-product)
  { slug: 'claude-code',        description: 'Using/configuring Claude Code (CLI/desktop): tips, hooks, slash commands, MCP setup, agents/subagents, internals from the source-code leak.' },
  { slug: 'cursor',             description: 'Using/configuring Cursor IDE: rules, agents, prompts, workflows.' },
  { slug: 'codex',              description: 'OpenAI Codex (the agent): CLI/desktop usage, prompts, integration patterns.' },
  { slug: 'devin',              description: 'Cognition Devin: capabilities, workflows, comparisons.' },

  // Model families
  { slug: 'anthropic-claude',   description: 'Claude model family releases, capabilities, pricing, ecosystem news (excl. Claude Code itself, which has its own page).' },
  { slug: 'openai-models',      description: 'OpenAI model releases (GPT-5.x, etc.), capabilities, pricing, API features.' },
  { slug: 'open-source-models', description: 'Open-weight model releases (Llama, Qwen, DeepSeek, Mistral, Kimi, Gemma) and self-hosting tooling.' },

  // Agent engineering (build side)
  { slug: 'agent-architecture',   description: 'Agent loops, planner-executor, multi-agent patterns, supervisor/worker, ReAct, deep-agents.' },
  { slug: 'agent-tool-design',    description: 'Function calling, MCP, tool ergonomics, tool selection, sandboxing.' },
  { slug: 'agent-system-prompts', description: 'System prompts for agents, role design, persona, Claude-Code-leak-style insights into how production agents are prompted.' },
  { slug: 'agent-context-mgmt',   description: 'How an agent manages its OWN context internally: memory, compaction, summarization, conversation state, retrieval inside the agent.' },
  { slug: 'agent-evaluations',    description: 'How to evaluate and benchmark agents: harnesses, regressions, SWE-bench-style suites.' },
  { slug: 'agent-frameworks',     description: 'LangGraph, AutoGen, Strands, BAML, Mastra, OpenAI Agents SDK, Anthropic Agent SDK, etc.' },

  // Use-side (Staff Engineer productivity, non-coding)
  { slug: 'ai-for-product-work',           description: 'Using AI for product discovery, PRDs, prioritization, customer research, user interviews.' },
  { slug: 'ai-for-system-design',          description: 'Using AI for architecture, design docs, ADRs, tech specs, RFCs.' },
  { slug: 'ai-for-code-review',            description: 'Using AI for PR review, auto-reviewers, code-quality tooling.' },
  { slug: 'ai-for-debugging-and-incidents',description: 'Using AI for debugging, on-call, log analysis, postmortems, incident triage.' },

  // Cross-cutting
  { slug: 'context-engineering', description: 'USER-facing techniques for shaping the context window: CLAUDE.md, Cursor rules, retrieval/grounding strategies, /compact, session hygiene, Karpathy-style techniques. (For agents managing their OWN context → agent-context-mgmt.)' },
];

export const ALLOWED_SLUGS = ALLOWLIST.map(t => t.slug);
export const ALLOWED_SLUG_SET = new Set(ALLOWED_SLUGS);
export const TOPIC_INDEX_KEY = 'topic-index.json';
const MAX_TOPICS_PER_ARTICLE = 3;
const MAX_URL_RETRIES = 2;
const URL_FETCH_TIMEOUT_MS = 10_000;

// ---- PROMPTS -------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are lowpassd, a high-signal wiki builder for AI research and engineering.
You compile incoming articles into a cross-linked Markdown wiki in the style of a personal research notebook for a Staff Engineer who:
- uses AI to be more effective at engineering and product work (coding agents, context engineering, PRDs, design, code review, debugging),
- builds their own agents (architecture, tools, prompts, context, evals).

Rules:
- Be terse and concrete. Prefer claims with citations. Skip filler and marketing fluff.
- Use [[slug]] wiki-links to other pages by their kebab-case slug when a concept has its own page.
- Group facts under H2 sections. Use bullet lists for claims.
- Each page should answer: what is this thing, why it matters, latest developments, key references.
- Never invent facts. If a claim isn't in a source, don't write it.
- Never invent URLs. Only cite URLs that appear verbatim in the source articles below.

Citation format (STRICT — Markdown will not render any other form):
- Inline citation: end the sentence with [anchor text](https://example.com). Anchor text is REQUIRED and must describe what's at the URL.
- Or use an autolink: <https://example.com>.
- NEVER write [https://example.com] with brackets only — it does not render as a link.
- NEVER write a bare URL outside of <> brackets.`;

function allowlistBlock(): string {
  return ALLOWLIST.map(t => `- ${t.slug}: ${t.description}`).join('\n');
}

function categorizePrompt(article: RawArticle): string {
  return `Classify the article below into the lowpassd taxonomy.

ALLOWED TOPICS — pick UP TO ${MAX_TOPICS_PER_ARTICLE} slugs that genuinely fit (fewer is better):
${allowlistBlock()}

Decision rules:
- A topic "fits" only if this article would meaningfully update that page's content. Mere mentions don't count.
- If NO topic fits, set rejected=true and propose a suggested slug describing what topic would have been needed. Do not stretch to fit.
- Prefer the most specific applicable topic (e.g. claude-code over anthropic-claude when the article is about the tool, not the model).

Article:
${articleSummary(article)}`;
}

const CATEGORIZE_SCHEMA = {
  type: 'object',
  properties: {
    rejected: {
      type: 'boolean',
      description: 'true if the article does not fit any allowed topic',
    },
    suggestedSlug: {
      type: 'string',
      description: 'if rejected, the slug this article would have warranted (kebab-case)',
    },
    topics: {
      type: 'array',
      maxItems: MAX_TOPICS_PER_ARTICLE,
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', enum: ALLOWED_SLUGS },
          reason: { type: 'string' },
        },
        required: ['slug', 'reason'],
      },
    },
  },
  required: ['rejected', 'topics'],
};

interface CategorizeResult {
  rejected: boolean;
  suggestedSlug?: string;
  topics: { slug: string; reason: string }[];
}

function pageUpdatePrompt(slug: string, existing: string | null, articles: RawArticle[]): string {
  const topicDef = ALLOWLIST.find(t => t.slug === slug);
  const head = existing
    ? `Update the existing wiki page "${slug}" by integrating new information from the articles below. Preserve still-relevant content. Reorganize if needed. Avoid duplication.`
    : `Write a new wiki page "${slug}" using the articles below as primary sources.`;
  return `${head}

Topic scope:
${topicDef ? topicDef.description : '(unknown topic)'}

CITATION RULES (HARD CONSTRAINTS):
- Each sentence may have AT MOST one citation.
- A citation MUST come from an article that actually contains the specific fact being stated.
- NEVER stack multiple citations on a single claim. The pattern "[A](u1), [B](u2), [C](u3)" is forbidden.
- If multiple articles cover the same fact, pick ONE and cite only that.
- If unsure which article supports a claim, OMIT the citation. No citation is always better than a wrong one.
- Citation format: [descriptive anchor](THAT ARTICLE'S CITE_AS URL).
- The "Key References" section at the bottom may list each article once, but it is not a place to attach citations to claims they don't support.

CROSS-LINK RULES (for inline [[wiki-slug]] links):
- ONLY use these slugs: ${ALLOWED_SLUGS.join(', ')}.
- Do not invent new slugs. If a concept would deserve a page but isn't in the allowlist, mention it in plain text without [[brackets]].

Output ONLY the full Markdown content of the page (no code fences, no preface). Start with an H1 title that names the topic in human form.

EXISTING PAGE (may be empty):
\`\`\`markdown
${existing ?? ''}
\`\`\`

NEW ARTICLES (each article has a CITE_AS URL — that is the ONLY URL allowed when citing facts from that article):
${articles.map((a, i) => articleForPageWrite(a, i + 1)).join('\n\n')}`;
}

function fixUrlsPrompt(slug: string, content: string, badUrls: string[], articles: RawArticle[]): string {
  return `The wiki page "${slug}" below contains URLs that are either NOT in the source articles or do not resolve. Fix them.

BAD URLs to remove or correct:
${badUrls.map(u => `- ${u}`).join('\n')}

Rules:
- ONLY use URLs from the CITE_AS field of one of the articles below.
- Each citation must come from an article that actually contains the fact being stated.
- If you cannot find a suitable replacement URL for a claim, rephrase the claim to not require a citation (or remove the claim).
- Preserve all other content unchanged.

Output ONLY the full Markdown content of the page (no code fences, no preface).

CURRENT PAGE:
\`\`\`markdown
${content}
\`\`\`

SOURCE ARTICLES (the ONLY allowed URLs are the CITE_AS values below):
${articles.map((a, i) => articleForPageWrite(a, i + 1)).join('\n\n')}`;
}

function articleForPageWrite(a: RawArticle, index: number): string {
  return `=== ARTICLE ${index} ===
TITLE: ${a.title}
FEED: ${a.feed}
PUBLISHED: ${a.frontmatter.published ?? ''}
CITE_AS: ${a.url}

${truncate(a.body, 6000)}
=== END ARTICLE ${index} ===`;
}

// ---- COMPILE -------------------------------------------------------------

interface RawArticle {
  key: string;
  frontmatter: Record<string, string>;
  body: string;
  dense: boolean;
  title: string;
  url: string;
  feed: string;
}

export interface CompileResult {
  rawArticlesProcessed: number;
  articlesRejected: number;
  topicsTouched: number;
  pagesWritten: number;
  urlsFixedByRetry: number;
  urlsStrippedAsFallback: number;
  newspaperIssued: boolean;
  newspaperStories: number;
  errors: { stage: string; key: string; error: string }[];
}

const NEWSPAPER_MIN_ARTICLES = 5;

export async function compile(): Promise<CompileResult> {
  const allRawKeys = (await listObjects(config.storage.buckets.raw, 'raw/'))
    .filter(k => k.endsWith('.md'));
  const errors: CompileResult['errors'] = [];

  // Process oldest-first (keys sort chronologically: raw/YYYY-MM-DD/...) and
  // cap per cycle so the run finishes within Cloud Run's request timeout. A
  // large backlog drains over successive cycles; each batch is archived below.
  const rawKeys = allRawKeys.slice(0, config.orchestrator.maxArticlesPerCycle);
  if (allRawKeys.length > rawKeys.length) {
    console.log(`[compile] backlog ${allRawKeys.length}, processing ${rawKeys.length} this cycle`);
  }

  if (rawKeys.length === 0) {
    return {
      rawArticlesProcessed: 0,
      articlesRejected: 0,
      topicsTouched: 0,
      pagesWritten: 0,
      urlsFixedByRetry: 0,
      urlsStrippedAsFallback: 0,
      newspaperIssued: false,
      newspaperStories: 0,
      errors,
    };
  }

  const articles: RawArticle[] = [];
  for (const key of rawKeys) {
    const text = await getText(config.storage.buckets.raw, key);
    if (!text) continue;
    articles.push(parseArticle(key, text));
  }

  // Phase 1: categorize each article into allowlist topic slugs.
  const topicToArticles = new Map<string, RawArticle[]>();
  const acceptedArticles: RawArticle[] = [];
  let rejectedCount = 0;
  const rejectedEntries: RejectedEntry[] = [];

  for (const article of articles) {
    try {
      const cats = await generateJson<CategorizeResult>({
        tier: article.dense ? 'pro' : 'flash',
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt: categorizePrompt(article),
        schema: CATEGORIZE_SCHEMA,
      });
      const validTopics = (cats.topics ?? []).filter(t => ALLOWED_SLUG_SET.has(t.slug));
      if (cats.rejected || validTopics.length === 0) {
        rejectedCount++;
        rejectedEntries.push({
          date: new Date().toISOString().slice(0, 10),
          feed: article.feed,
          title: article.title,
          suggestedSlug: cats.suggestedSlug ?? '',
        });
        continue;
      }
      acceptedArticles.push(article);
      for (const t of validTopics) {
        const list = topicToArticles.get(t.slug) ?? [];
        list.push(article);
        topicToArticles.set(t.slug, list);
      }
    } catch (err) {
      errors.push({
        stage: 'categorize',
        key: article.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (rejectedEntries.length > 0) {
    try {
      await appendRejectedLog(rejectedEntries);
    } catch (err) {
      errors.push({
        stage: 'rejected-log',
        key: 'rejected.log',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 2: per touched topic, fetch existing page, rewrite it, validate URLs.
  let pagesWritten = 0;
  let urlsFixedByRetry = 0;
  let urlsStrippedAsFallback = 0;

  for (const [slug, topicArticles] of topicToArticles) {
    const wikiKey = `wiki/${slug}.md`;
    const existing = await getText(config.storage.buckets.wiki, wikiKey);
    const tier: Tier = topicArticles.some(a => a.dense) ? 'pro' : 'flash';
    const sourceUrls = collectSourceUrls(topicArticles);

    try {
      const initial = await generateText({
        tier,
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt: pageUpdatePrompt(slug, existing, topicArticles),
      });
      const result = await validateAndFixUrls({
        slug,
        initial: cleanGeneratedContent(initial),
        sourceUrls,
        articles: topicArticles,
        tier,
      });
      urlsFixedByRetry += result.fixedByRetry;
      urlsStrippedAsFallback += result.strippedAsFallback;
      await putText(config.storage.buckets.wiki, wikiKey, result.content);
      pagesWritten++;
    } catch (err) {
      errors.push({
        stage: 'page-update',
        key: wikiKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 3: archive all processed raw files (including rejected — keep traceability).
  for (const article of articles) {
    const archiveKey = article.key.replace(/^raw\//, 'archive/');
    try {
      await moveObject(config.storage.buckets.raw, article.key, config.storage.buckets.archive, archiveKey);
    } catch (err) {
      errors.push({
        stage: 'archive',
        key: article.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 3.5: merge this cycle's topic→article mapping into the persisted index.
  try {
    const additions: Record<string, string[]> = {};
    for (const [slug, arts] of topicToArticles) {
      additions[slug] = arts.map(a => a.key.replace(/^raw\//, 'archive/'));
    }
    await mergeTopicIndex(additions);
  } catch (err) {
    errors.push({
      stage: 'topic-index',
      key: TOPIC_INDEX_KEY,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 4: issue the daily newspaper if there's enough accepted content.
  let newspaperIssued = false;
  let newspaperStories = 0;
  if (acceptedArticles.length >= NEWSPAPER_MIN_ARTICLES) {
    try {
      const inputs: ArticleForNewspaper[] = acceptedArticles.map(a => ({
        title: a.title,
        url: a.url,
        feed: a.feed,
        body: a.body,
      }));
      const issue = await generateNewspaper(inputs);
      if (issue) {
        await saveIssue(issue);
        newspaperIssued = true;
        newspaperStories = issue.stories.length;
      }
    } catch (err) {
      errors.push({
        stage: 'newspaper',
        key: 'newspaper',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    rawArticlesProcessed: articles.length,
    articlesRejected: rejectedCount,
    topicsTouched: topicToArticles.size,
    pagesWritten,
    urlsFixedByRetry,
    urlsStrippedAsFallback,
    newspaperIssued,
    newspaperStories,
    errors,
  };
}

// ---- URL VALIDATION ------------------------------------------------------

interface ValidateResult {
  content: string;
  fixedByRetry: number;
  strippedAsFallback: number;
}

async function validateAndFixUrls(args: {
  slug: string;
  initial: string;
  sourceUrls: Set<string>;
  articles: RawArticle[];
  tier: Tier;
}): Promise<ValidateResult> {
  let content = args.initial;
  let fixedByRetry = 0;
  const sourceNormalized = new Set([...args.sourceUrls].map(normalizeUrl));

  for (let attempt = 0; attempt <= MAX_URL_RETRIES; attempt++) {
    const urls = extractUrls(content);
    const bad: string[] = [];
    for (const u of urls) {
      if (!sourceNormalized.has(normalizeUrl(u))) {
        bad.push(u);
        continue;
      }
      if (!(await urlReachable(u))) {
        bad.push(u);
      }
    }
    if (bad.length === 0) {
      return { content, fixedByRetry, strippedAsFallback: 0 };
    }
    if (attempt === MAX_URL_RETRIES) {
      const stripped = stripBadUrls(content, new Set(bad));
      return { content: stripped, fixedByRetry, strippedAsFallback: bad.length };
    }
    const fixed = await generateText({
      tier: args.tier,
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: fixUrlsPrompt(args.slug, content, bad, args.articles),
    });
    content = cleanGeneratedContent(fixed);
    fixedByRetry++;
  }
  return { content, fixedByRetry, strippedAsFallback: 0 };
}

function extractUrls(md: string): string[] {
  const urls = new Set<string>();
  for (const m of md.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)) {
    const u = m[1];
    if (u) urls.add(u);
  }
  for (const m of md.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
    const u = m[1];
    if (u) urls.add(u);
  }
  return [...urls];
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,*/*;q=0.8',
};

async function urlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
    return statusLooksAlive(res.status);
  } catch {
    // Some servers reject HEAD or stall. Fall back to a tiny ranged GET.
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...BROWSER_HEADERS, Range: 'bytes=0-256' },
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      });
      try {
        await res.body?.cancel();
      } catch {
        // ignore cancel errors
      }
      return statusLooksAlive(res.status);
    } catch {
      return false;
    }
  }
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${host}${path}${url.search}${url.hash}`;
  } catch {
    return u;
  }
}

function statusLooksAlive(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  // CDN bot-blocks: 401/403 usually mean the page exists but bots are rejected.
  if (status === 401 || status === 403) return true;
  if (status === 405) return true; // method not allowed — URL still exists
  return false;
}

function stripBadUrls(md: string, bad: Set<string>): string {
  return md
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, anchor: string, url: string) =>
      bad.has(url) ? anchor : m,
    )
    .replace(/<(https?:\/\/[^>\s]+)>/g, (m, url: string) =>
      bad.has(url) ? '' : m,
    );
}

function collectSourceUrls(articles: RawArticle[]): Set<string> {
  const urls = new Set<string>();
  for (const a of articles) {
    if (a.url) urls.add(a.url);
    for (const m of a.body.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) {
      if (m[1]) urls.add(m[1]);
    }
    for (const m of a.body.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
      if (m[1]) urls.add(m[1]);
    }
    for (const m of a.body.matchAll(/(?<![(<])\bhttps?:\/\/[^\s)>\]]+/g)) {
      const u = m[0]?.replace(/[.,;:!?)\]]+$/, '');
      if (u) urls.add(u);
    }
  }
  return urls;
}

// ---- TOPIC INDEX ---------------------------------------------------------

export type TopicIndex = Record<string, string[]>;

export async function loadTopicIndex(): Promise<TopicIndex> {
  const text = await getText(config.storage.buckets.wiki, TOPIC_INDEX_KEY);
  if (!text) return {};
  try {
    return JSON.parse(text) as TopicIndex;
  } catch {
    return {};
  }
}

export async function saveTopicIndex(index: TopicIndex): Promise<void> {
  await putText(
    config.storage.buckets.wiki,
    TOPIC_INDEX_KEY,
    JSON.stringify(index, null, 2),
    'application/json; charset=utf-8',
  );
}

async function mergeTopicIndex(additions: TopicIndex): Promise<void> {
  const existing = await loadTopicIndex();
  for (const [slug, keys] of Object.entries(additions)) {
    const merged = new Set([...(existing[slug] ?? []), ...keys]);
    existing[slug] = [...merged].sort();
  }
  await saveTopicIndex(existing);
}

// ---- REJECTED LOG --------------------------------------------------------

interface RejectedEntry {
  date: string;
  feed: string;
  title: string;
  suggestedSlug: string;
}

async function appendRejectedLog(entries: RejectedEntry[]): Promise<void> {
  const key = 'rejected.log';
  const existing = (await getText(config.storage.buckets.wiki, key)) ?? '';
  const lines = entries
    .map(e => `${e.date}\t${e.feed}\t${JSON.stringify(e.title)}\tsuggested:${e.suggestedSlug || '(none)'}`)
    .join('\n');
  const body = existing ? `${existing.trimEnd()}\n${lines}\n` : `${lines}\n`;
  await putText(config.storage.buckets.wiki, key, body, 'text/plain; charset=utf-8');
}

// ---- PARSING / HELPERS ---------------------------------------------------

function parseArticle(key: string, text: string): RawArticle {
  const fm: Record<string, string> = {};
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    if (end > 0) {
      const fmText = text.slice(4, end);
      body = text.slice(end + 5);
      for (const line of fmText.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }
  }
  return {
    key,
    frontmatter: fm,
    body: body.trim(),
    dense: fm.dense === 'true',
    title: unquote(fm.title ?? '(untitled)'),
    url: fm.url ?? '',
    feed: fm.feed ?? '',
  };
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function stripUnknownWikiLinks(md: string): string {
  return md.replace(
    /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g,
    (full, slug: string, alias?: string) => (ALLOWED_SLUG_SET.has(slug) ? full : (alias ?? slug)),
  );
}

function cleanGeneratedContent(text: string): string {
  return stripUnknownWikiLinks(stripCodeFence(text));
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstNewline = trimmed.indexOf('\n');
  const lastFence = trimmed.lastIndexOf('```');
  if (firstNewline < 0 || lastFence <= firstNewline) return trimmed;
  return trimmed.slice(firstNewline + 1, lastFence).trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

function articleSummary(a: RawArticle): string {
  return `## ${a.title}
Feed: ${a.feed}
URL: ${a.url}
Published: ${a.frontmatter.published ?? ''}

${truncate(a.body, 6000)}`;
}
