import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import TurndownService from 'turndown';
import { config } from './config.js';
import { defaultFeeds, type Feed } from './feeds.js';
import { prefilterRelevant } from './prefilter.js';
import { objectExists, putText } from './storage.js';
import { loadState, saveState, type State } from './state.js';

const parser: Parser = new Parser({ timeout: 30_000 });
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export interface IngestResult {
  feedsAttempted: number;
  articlesFetched: number;
  articlesSkippedExisting: number;
  // Candidates dropped by title/abstract triage on prefilter feeds (arXiv).
  articlesPrefiltered: number;
  errors: { feed: string; error: string }[];
}

export async function ingest(feeds: Feed[] = defaultFeeds): Promise<IngestResult> {
  const state = await loadState();
  const now = Date.now();
  const lookbackMs = config.orchestrator.maxLookbackDays * 24 * 60 * 60 * 1000;
  const earliestAllowed = now - lookbackMs;

  let articlesFetched = 0;
  let articlesSkippedExisting = 0;
  let articlesPrefiltered = 0;
  const errors: IngestResult['errors'] = [];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const result = await ingestFeed(feed, parsed.items, state, earliestAllowed, now);
      articlesFetched += result.fetched;
      articlesSkippedExisting += result.skipped;
      articlesPrefiltered += result.prefiltered;
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
    articlesPrefiltered,
    errors,
  };
}

async function ingestFeed(
  feed: Feed,
  items: Parser.Item[],
  state: State,
  earliestAllowed: number,
  now: number,
): Promise<{ fetched: number; skipped: number; prefiltered: number }> {
  const lastIso = state[feed.slug]?.lastPublishedIso;
  const lastMs = lastIso ? Date.parse(lastIso) : 0;
  let newestSeenMs = lastMs;
  let skipped = 0;

  // First pass: collect the new, in-window, not-yet-stored items. The cursor
  // advances over every item we see (including ones we'll later drop), so a
  // prefiltered-out paper is never reconsidered on a future run.
  const candidates: { item: Parser.Item; key: string }[] = [];
  for (const item of items) {
    const publishedMs = parseItemDate(item) ?? now;
    if (publishedMs <= lastMs) continue;
    if (publishedMs < earliestAllowed) continue;
    if (publishedMs > newestSeenMs) newestSeenMs = publishedMs;

    const key = articleKey(feed, item, publishedMs);
    if (await objectExists(config.storage.buckets.raw, key)) {
      skipped++;
      continue;
    }
    candidates.push({ item, key });
  }

  // For high-volume feeds, triage by title+abstract before storing so we don't
  // ingest (and later pay to categorize) hundreds of off-topic papers.
  let toStore = candidates;
  let prefiltered = 0;
  if (feed.prefilter && candidates.length > 0) {
    const keep = await prefilterRelevant(
      candidates.map(c => ({
        title: (c.item.title ?? '').replace(/\s+/g, ' ').trim(),
        abstract: itemAbstract(c.item),
      })),
    );
    toStore = candidates.filter((_, i) => keep.has(i));
    prefiltered = candidates.length - toStore.length;
    console.log(
      `[ingest] ${feed.slug}: prefilter kept ${toStore.length}/${candidates.length}`,
    );
  }

  for (const { item, key } of toStore) {
    await putText(config.storage.buckets.raw, key, renderArticle(feed, item));
  }

  if (newestSeenMs > lastMs) {
    state[feed.slug] = { lastPublishedIso: new Date(newestSeenMs).toISOString() };
  }
  return { fetched: toStore.length, skipped, prefiltered };
}

function itemAbstract(item: Parser.Item): string {
  return (item.contentSnippet ?? item.summary ?? item.content ?? '').trim();
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
