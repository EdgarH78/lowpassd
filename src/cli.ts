import { compile, saveTopicIndex, stripUnknownWikiLinks, type TopicIndex } from './compiler.js';
import { config } from './config.js';
import { ingest } from './ingest.js';
import { generateNewspaper, saveIssue, type ArticleForNewspaper } from './newspaper.js';
import { cycle } from './orchestrator.js';
import { ensureBuckets, getText, listObjects, putText } from './storage.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  await ensureBuckets();
  switch (cmd) {
    case 'ingest': {
      const r = await ingest();
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'compile': {
      const r = await compile();
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'cycle': {
      const r = await cycle();
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'newspaper-from-archive': {
      const rejectedTitles = await loadRejectedTitles();
      const archiveKeys = (await listObjects(config.storage.buckets.archive, 'archive/'))
        .filter(k => k.endsWith('.md'));
      const articles: ArticleForNewspaper[] = [];
      for (const key of archiveKeys) {
        const text = await getText(config.storage.buckets.archive, key);
        if (!text) continue;
        const parsed = parseArchivedArticle(text);
        if (rejectedTitles.has(parsed.title)) continue;
        articles.push(parsed);
      }
      console.log(`generating newspaper from ${articles.length} accepted archived articles (${archiveKeys.length} total, ${rejectedTitles.size} rejected)`);
      const issue = await generateNewspaper(articles);
      if (!issue) {
        console.log('no issue generated');
        return;
      }
      await saveIssue(issue);
      console.log(`saved newspaper/${issue.date}.json with ${issue.stories.length} stories`);
      return;
    }
    case 'rebuild-topic-index': {
      // Derive topic-index.json from current wiki pages + archive contents
      // by reverse-mapping cited URLs → archive article keys.
      const archiveKeys = (await listObjects(config.storage.buckets.archive, 'archive/'))
        .filter(k => k.endsWith('.md'));
      const urlToKey = new Map<string, string>();
      for (const k of archiveKeys) {
        const text = await getText(config.storage.buckets.archive, k);
        if (!text) continue;
        const m = text.match(/^url:\s*(.+)$/m);
        const url = m?.[1]?.trim();
        if (url) urlToKey.set(normalizeUrl(url), k);
      }

      const wikiKeys = (await listObjects(config.storage.buckets.wiki, 'wiki/'))
        .filter(k => k.endsWith('.md'));
      const index: TopicIndex = {};
      let totalMatches = 0;
      for (const wk of wikiKeys) {
        const slug = wk.replace(/^wiki\//, '').replace(/\.md$/, '');
        const text = await getText(config.storage.buckets.wiki, wk);
        if (!text) continue;
        const urls = new Set<string>();
        for (const m of text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)) {
          if (m[1]) urls.add(normalizeUrl(m[1]));
        }
        for (const m of text.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
          if (m[1]) urls.add(normalizeUrl(m[1]));
        }
        const keys = [...urls].map(u => urlToKey.get(u)).filter((k): k is string => !!k);
        if (keys.length > 0) {
          index[slug] = [...new Set(keys)].sort();
          totalMatches += keys.length;
        }
      }
      await saveTopicIndex(index);
      console.log(JSON.stringify({
        archiveArticles: archiveKeys.length,
        wikiPages: wikiKeys.length,
        topicsIndexed: Object.keys(index).length,
        articleAssociations: totalMatches,
      }, null, 2));
      return;
    }
    case 'clean-wiki-links': {
      const keys = (await listObjects(config.storage.buckets.wiki, 'wiki/')).filter(k => k.endsWith('.md'));
      let cleaned = 0;
      for (const key of keys) {
        const text = await getText(config.storage.buckets.wiki, key);
        if (!text) continue;
        const next = stripUnknownWikiLinks(text);
        if (next !== text) {
          await putText(config.storage.buckets.wiki, key, next);
          cleaned++;
          console.log(`cleaned ${key}`);
        }
      }
      console.log(JSON.stringify({ pagesScanned: keys.length, pagesCleaned: cleaned }, null, 2));
      return;
    }
    default:
      console.error('usage: cli.ts <ingest|compile|cycle|newspaper-from-archive|rebuild-topic-index|clean-wiki-links>');
      process.exit(1);
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

async function loadRejectedTitles(): Promise<Set<string>> {
  const text = await getText(config.storage.buckets.wiki, 'rejected.log');
  if (!text) return new Set();
  const titles = new Set<string>();
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const titleJson = parts[2];
    if (!titleJson) continue;
    try {
      const t = JSON.parse(titleJson) as unknown;
      if (typeof t === 'string') titles.add(t);
    } catch {
      // skip malformed lines
    }
  }
  return titles;
}

function parseArchivedArticle(text: string): ArticleForNewspaper {
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
    title,
    url: fm.url ?? '',
    feed: fm.feed ?? '',
    body: body.trim(),
  };
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
