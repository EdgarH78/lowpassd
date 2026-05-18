import {
  ALLOWED_SLUGS,
  ALLOWED_SLUG_SET,
  ALLOWLIST,
  loadTopicIndex,
  type TopicIndex,
} from './compiler.js';
import { config } from './config.js';
import {
  generateContentWithTools,
  type ConversationTurn,
  type FunctionCall,
  type ResponsePart,
  type ToolDeclaration,
} from './llm.js';
import { getText, listObjects } from './storage.js';

const MAX_ITERATIONS = 8;
const ARTICLE_BODY_TRUNCATE = 2000;
const MAX_ARTICLES_PER_CALL = 30;

// ---- Public types --------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ChatResult {
  reply: string;
  toolCalls: ToolTrace[];
  iterations: number;
  hitIterationCap: boolean;
}

// ---- Tool definition -----------------------------------------------------

const NAVIGATE_TOOL: ToolDeclaration = {
  name: 'navigate',
  description:
    'Browse the lowpassd wiki. Call this iteratively as you need information.\n' +
    '- With no arguments: returns the list of all 18 topics with descriptions and per-topic article counts. Use this to discover what is available.\n' +
    '- With `topics`: returns the FULL wiki page content for each named topic (only allowlist slugs).\n' +
    '- With `includeArticles: true`: ALSO returns matching archived source articles (truncated to ~2000 chars each). Filter further with `dateFrom` and `dateTo` (YYYY-MM-DD). Useful when the wiki page is stale or you need direct quotes from sources.',
  parameters: {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: { type: 'string', enum: ALLOWED_SLUGS },
        description:
          'List of allowlist topic slugs to read in detail. If omitted, returns the topic catalog only.',
      },
      includeArticles: {
        type: 'boolean',
        description:
          'If true, also return raw source articles. Use this to get specific quotes or recent details not in the rolled-up page.',
      },
      dateFrom: {
        type: 'string',
        description:
          "Only return articles published on or after this date (YYYY-MM-DD). Applies when includeArticles=true.",
      },
      dateTo: {
        type: 'string',
        description:
          "Only return articles published on or before this date (YYYY-MM-DD). Applies when includeArticles=true.",
      },
    },
  },
};

// ---- Tool implementation -------------------------------------------------

interface NavigateArgs {
  topics?: string[];
  includeArticles?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

interface TopicEntry {
  slug: string;
  description: string;
  articleCount: number;
  hasPage: boolean;
  pageContent?: string;
}

interface ArticleEntry {
  key: string;
  feed: string;
  title: string;
  url: string;
  publishedDate: string; // YYYY-MM-DD from path
  body: string;
}

interface NavigateResult {
  date: string; // today, for grounding
  topics: TopicEntry[];
  articles?: ArticleEntry[];
  notes?: string[];
}

async function navigate(args: NavigateArgs): Promise<NavigateResult> {
  const notes: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const index = await loadTopicIndex();
  const validTopics = (args.topics ?? []).filter(t => ALLOWED_SLUG_SET.has(t));
  const invalidTopics = (args.topics ?? []).filter(t => !ALLOWED_SLUG_SET.has(t));
  if (invalidTopics.length > 0) {
    notes.push(
      `Ignored unknown topic slugs: ${invalidTopics.join(', ')}. Valid slugs: ${ALLOWED_SLUGS.join(', ')}.`,
    );
  }

  // Topic catalog (always returned)
  const topicsOut: TopicEntry[] = [];
  for (const def of ALLOWLIST) {
    const articleKeys = index[def.slug] ?? [];
    const entry: TopicEntry = {
      slug: def.slug,
      description: def.description,
      articleCount: articleKeys.length,
      hasPage: false,
    };
    if (validTopics.includes(def.slug)) {
      const page = await getText(config.s3.buckets.wiki, `wiki/${def.slug}.md`);
      entry.hasPage = page !== null;
      if (page !== null) entry.pageContent = page;
    } else {
      // Quick existence check via list — defer fetching for catalog mode to keep tool result small.
      entry.hasPage = articleKeys.length > 0 || (await pageExists(def.slug));
    }
    topicsOut.push(entry);
  }

  let articlesOut: ArticleEntry[] | undefined;
  if (args.includeArticles) {
    articlesOut = await loadArticles({
      topics: validTopics,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      index,
    });
    if (articlesOut.length === MAX_ARTICLES_PER_CALL) {
      notes.push(
        `Article list truncated to ${MAX_ARTICLES_PER_CALL}. Narrow your topics or date range to see more.`,
      );
    }
  }

  return {
    date: today,
    topics: topicsOut,
    ...(articlesOut ? { articles: articlesOut } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

async function pageExists(slug: string): Promise<boolean> {
  // Cheap: just see if any object exists at the key prefix.
  const keys = await listObjects(config.s3.buckets.wiki, `wiki/${slug}.md`);
  return keys.length > 0;
}

async function loadArticles(args: {
  topics: string[];
  dateFrom?: string;
  dateTo?: string;
  index: TopicIndex;
}): Promise<ArticleEntry[]> {
  let candidateKeys: string[];
  if (args.topics.length > 0) {
    const set = new Set<string>();
    let indexedAny = false;
    for (const t of args.topics) {
      const keys = args.index[t];
      if (keys && keys.length > 0) {
        indexedAny = true;
        for (const k of keys) set.add(k);
      }
    }
    if (!indexedAny) {
      // Fall back to all archive (the topic index may be empty for new installs).
      candidateKeys = (await listObjects(config.s3.buckets.archive, 'archive/'))
        .filter(k => k.endsWith('.md'));
    } else {
      candidateKeys = [...set];
    }
  } else {
    candidateKeys = (await listObjects(config.s3.buckets.archive, 'archive/'))
      .filter(k => k.endsWith('.md'));
  }

  // Filter by date in path: archive/YYYY-MM-DD/...
  const filteredKeys = candidateKeys.filter(k => {
    const m = k.match(/^archive\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) return true; // unknown date format — keep
    const d = m[1]!;
    if (args.dateFrom && d < args.dateFrom) return false;
    if (args.dateTo && d > args.dateTo) return false;
    return true;
  });

  // Newest first, capped.
  filteredKeys.sort().reverse();
  const slice = filteredKeys.slice(0, MAX_ARTICLES_PER_CALL);

  const out: ArticleEntry[] = [];
  for (const key of slice) {
    const text = await getText(config.s3.buckets.archive, key);
    if (!text) continue;
    const parsed = parseArticle(text);
    out.push({
      key,
      feed: parsed.feed,
      title: parsed.title,
      url: parsed.url,
      publishedDate: key.match(/^archive\/(\d{4}-\d{2}-\d{2})\//)?.[1] ?? '',
      body: truncate(parsed.body, ARTICLE_BODY_TRUNCATE),
    });
  }
  return out;
}

function parseArticle(text: string): { feed: string; title: string; url: string; body: string } {
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
  let title = fm.title ?? '(untitled)';
  if (title.startsWith('"') && title.endsWith('"')) {
    try { title = JSON.parse(title) as string; } catch { title = title.slice(1, -1); }
  }
  return {
    feed: fm.feed ?? '',
    title,
    url: fm.url ?? '',
    body: body.trim(),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

// ---- ReAct loop ----------------------------------------------------------

function buildSystemInstruction(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the chat assistant for lowpassd, a personal AI knowledge wiki for a Staff Engineer who uses AI tools and builds agents.

Current date: ${today}. Use this for any "today", "yesterday", "last week" interpretations.

Tool use:
- Use the navigate tool iteratively. Start by calling it with no arguments to see the topic catalog and article counts.
- Then call navigate with specific topics to read their wiki pages.
- If the wiki page seems stale, or you need direct quotes from sources, call navigate with includeArticles=true and an appropriate date range.
- Don't request more articles than you need — narrow with dateFrom/dateTo.
- When you have enough information, stop calling tools and write the answer.

Answer style:
- Direct, technical, terse. The user is a Staff Engineer — skip definitions of basic terms.
- If a question is out of scope (nothing relevant in the wiki), say so plainly.
- If the user asks for recent news, prefer recent articles (use dateFrom). If they ask for an overview, the wiki page is usually right.

Citation rules (STRICT):
- Cite a URL only when stating a specific factual claim that came from that URL in the tool results.
- Format: [descriptive anchor](https://example.com). Anchor text is REQUIRED.
- Or use an autolink: <https://example.com>.
- NEVER write [https://example.com] with brackets only — Markdown will not render it as a link.
- NEVER write a bare URL outside of <> brackets.
- One citation per claim. Never stack multiple URLs on one sentence.`;
}

function toGeminiHistory(messages: ChatMessage[]): ConversationTurn[] {
  return messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));
}

export async function chat(history: ChatMessage[]): Promise<ChatResult> {
  const contents = toGeminiHistory(history);
  const toolCalls: ToolTrace[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { parts } = await generateContentWithTools({
      tier: 'flash',
      systemInstruction: buildSystemInstruction(),
      contents,
      tools: [NAVIGATE_TOOL],
    });

    const fnCalls = parts.filter((p): p is ResponsePart & { functionCall: FunctionCall } => !!p.functionCall);
    const textParts = parts.filter(p => typeof p.text === 'string' && p.text.length > 0);

    if (fnCalls.length === 0) {
      // Model returned text only — final answer.
      const reply = textParts.map(p => p.text).join('').trim() || '(no response)';
      return { reply, toolCalls, iterations: i + 1, hitIterationCap: false };
    }

    // Echo the model turn (calls + any text) back into the conversation.
    contents.push({
      role: 'model',
      parts: parts
        .map(p => {
          if (p.functionCall) return { functionCall: p.functionCall };
          if (typeof p.text === 'string') return { text: p.text };
          return null;
        })
        .filter((x): x is { functionCall: FunctionCall } | { text: string } => x !== null),
    });

    // Execute each function call and append the response turn.
    const responseParts: { functionResponse: { name: string; response: unknown } }[] = [];
    for (const call of fnCalls) {
      const fc = call.functionCall;
      let result: unknown;
      try {
        if (fc.name === 'navigate') {
          result = await navigate(fc.args as NavigateArgs);
        } else {
          result = { error: `unknown tool: ${fc.name}` };
        }
      } catch (err) {
        result = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
      toolCalls.push({ name: fc.name, args: fc.args, result });
      responseParts.push({ functionResponse: { name: fc.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    reply: '(Agent stopped after hitting iteration cap without producing a final answer.)',
    toolCalls,
    iterations: MAX_ITERATIONS,
    hitIterationCap: true,
  };
}
