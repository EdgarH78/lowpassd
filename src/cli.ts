import { compile, stripUnknownWikiLinks } from './compiler.js';
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
      const archiveKeys = (await listObjects(config.s3.buckets.archive, 'archive/'))
        .filter(k => k.endsWith('.md'));
      const articles: ArticleForNewspaper[] = [];
      for (const key of archiveKeys) {
        const text = await getText(config.s3.buckets.archive, key);
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
    case 'clean-wiki-links': {
      const keys = (await listObjects(config.s3.buckets.wiki, 'wiki/')).filter(k => k.endsWith('.md'));
      let cleaned = 0;
      for (const key of keys) {
        const text = await getText(config.s3.buckets.wiki, key);
        if (!text) continue;
        const next = stripUnknownWikiLinks(text);
        if (next !== text) {
          await putText(config.s3.buckets.wiki, key, next);
          cleaned++;
          console.log(`cleaned ${key}`);
        }
      }
      console.log(JSON.stringify({ pagesScanned: keys.length, pagesCleaned: cleaned }, null, 2));
      return;
    }
    default:
      console.error('usage: cli.ts <ingest|compile|cycle|newspaper-from-archive|clean-wiki-links>');
      process.exit(1);
  }
}

async function loadRejectedTitles(): Promise<Set<string>> {
  const text = await getText(config.s3.buckets.wiki, 'rejected.log');
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
