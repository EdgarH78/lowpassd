import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import TurndownService from 'turndown';
import { config } from './config.js';
import { defaultFeeds, type Feed } from './feeds.js';
import { objectExists, putText } from './storage.js';
import { loadState, saveState, type State } from './state.js';

const parser: Parser = new Parser({ timeout: 30_000 });
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export interface IngestResult {
  feedsAttempted: number;
  articlesFetched: number;
  articlesSkippedExisting: number;
  errors: { feed: string; error: string }[];
}

export async function ingest(feeds: Feed[] = defaultFeeds): Promise<IngestResult> {
  const state = await loadState();
  const now = Date.now();
  const lookbackMs = config.orchestrator.maxLookbackDays * 24 * 60 * 60 * 1000;
  const earliestAllowed = now - lookbackMs;

  let articlesFetched = 0;
  let articlesSkippedExisting = 0;
  const errors: IngestResult['errors'] = [];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const result = await ingestFeed(feed, parsed.items, state, earliestAllowed, now);
      articlesFetched += result.fetched;
      articlesSkippedExisting += result.skipped;
    } catch (err) {
      errors.push({
        feed: feed.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await saveState(state);
  return {
    feedsAttempted: feeds.length,
    articlesFetched,
    articlesSkippedExisting,
    errors,
  };
}

async function ingestFeed(
  feed: Feed,
  items: Parser.Item[],
  state: State,
  earliestAllowed: number,
  now: number,
): Promise<{ fetched: number; skipped: number }> {
  const lastIso = state[feed.slug]?.lastPublishedIso;
  const lastMs = lastIso ? Date.parse(lastIso) : 0;
  let newestSeenMs = lastMs;
  let fetched = 0;
  let skipped = 0;

  for (const item of items) {
    const publishedMs = parseItemDate(item) ?? now;
    if (publishedMs <= lastMs) continue;
    if (publishedMs < earliestAllowed) continue;
    if (publishedMs > newestSeenMs) newestSeenMs = publishedMs;

    const key = articleKey(feed, item, publishedMs);
    if (await objectExists(config.s3.buckets.raw, key)) {
      skipped++;
      continue;
    }
    const article = renderArticle(feed, item);
    await putText(config.s3.buckets.raw, key, article);
    fetched++;
  }

  if (newestSeenMs > lastMs) {
    state[feed.slug] = { lastPublishedIso: new Date(newestSeenMs).toISOString() };
  }
  return { fetched, skipped };
}

function parseItemDate(item: Parser.Item): number | null {
  const iso = item.isoDate ?? item.pubDate;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function articleKey(feed: Feed, item: Parser.Item, publishedMs: number): string {
  const date = new Date(publishedMs).toISOString().slice(0, 10);
  const idSource = item.guid ?? item.link ?? item.title ?? JSON.stringify(item);
  const hash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);
  return `raw/${date}/${feed.slug}/${hash}.md`;
}

function renderArticle(feed: Feed, item: Parser.Item): string {
  const html =
    (item as Record<string, unknown>)['content:encoded'] as string | undefined
    ?? item.content
    ?? item.summary
    ?? item.contentSnippet
    ?? '';
  const body = html ? turndown.turndown(html).trim() : '';
  const title = (item.title ?? '(untitled)').replace(/\s+/g, ' ').trim();
  const lines = [
    '---',
    `feed: ${feed.slug}`,
    `dense: ${feed.dense ?? false}`,
    `title: ${JSON.stringify(title)}`,
    `url: ${item.link ?? ''}`,
    `published: ${item.isoDate ?? item.pubDate ?? ''}`,
    `fetched: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ];
  return lines.join('\n');
}
