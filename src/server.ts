import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { marked } from 'marked';
import { config } from './config.js';
import {
  listIssueDates,
  loadIssueByDate,
  loadLatestIssue,
  renderArchivesHtml,
  renderEmptyHtml,
  renderIssueHtml,
} from './newspaper.js';
import { cycle, isRunning } from './orchestrator.js';
import { getText, listObjects } from './storage.js';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/health', c => c.text('ok'));

  app.get('/', async c => {
    const keys = await listObjects(config.s3.buckets.wiki, 'wiki/');
    const pages = keys
      .filter(k => k.endsWith('.md'))
      .map(k => k.replace(/^wiki\//, '').replace(/\.md$/, ''))
      .sort();
    const list = pages.length
      ? `<ul>${pages.map(p => `<li><a href="/wiki/${escapeAttr(p)}">${escapeHtml(p)}</a></li>`).join('')}</ul>`
      : '<p><em>No pages yet. Run a compile cycle to populate the wiki.</em></p>';
    const body = `
      <h1>lowpassd</h1>
      <p>A high-signal AI knowledge wiki, compiled by Gemini from RSS feeds.</p>
      <p><a href="/newspaper"><strong>The Lowpass Dispatch</strong> (daily newspaper)</a> · <a href="/trigger" onclick="event.preventDefault();fetch('/trigger',{method:'POST'}).then(r=>r.json()).then(j=>alert(JSON.stringify(j)))">Run cycle now</a> · <a href="/status">status</a></p>
      <h2>Pages (${pages.length})</h2>
      ${list}
    `;
    return c.html(layout('lowpassd', body));
  });

  app.get('/wiki/:slug', async c => {
    const slug = c.req.param('slug');
    const md = await getText(config.s3.buckets.wiki, `wiki/${slug}.md`);
    if (!md) {
      return c.html(layout(slug, `<h1>${escapeHtml(slug)}</h1><p>Page not found.</p>`), 404);
    }
    const linked = md
      // Turn malformed [https://...] citations (brackets only, no anchor) into autolinks.
      // Negative lookahead skips well-formed [label](url) pairs.
      .replace(/\[(https?:\/\/[^\]\s]+)\](?!\()/g, '<$1>')
      // Resolve [[slug]] / [[slug|alias]] wiki-links to internal routes.
      .replace(
        /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g,
        (_m, target: string, alias?: string) => `[${alias ?? target}](/wiki/${target})`,
      );
    const html = await marked.parse(linked);
    return c.html(layout(slug, html));
  });

  app.get('/newspaper', async c => {
    const issue = await loadLatestIssue();
    if (!issue) return c.html(renderEmptyHtml(), 404);
    const archives = await listIssueDates();
    return c.html(renderIssueHtml(issue, { archives }));
  });

  app.get('/newspaper/archives', async c => {
    const dates = await listIssueDates();
    return c.html(renderArchivesHtml(dates));
  });

  app.get('/newspaper/:date', async c => {
    const date = c.req.param('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.html(renderEmptyHtml(), 404);
    }
    const issue = await loadIssueByDate(date);
    if (!issue) return c.html(renderEmptyHtml(), 404);
    const archives = await listIssueDates();
    return c.html(renderIssueHtml(issue, { archives }));
  });

  app.get('/status', c => c.json({ running: isRunning() }));

  app.post('/trigger', c => {
    if (isRunning()) {
      return c.json({ status: 'already-running' }, 409);
    }
    void cycle().then(r => console.log('[trigger] cycle result', r));
    return c.json({ status: 'started' });
  });

  return app;
}

export function startServer(): void {
  const app = createApp();
  serve({ fetch: app.fetch, port: config.server.port });
  console.log(`[server] listening on http://0.0.0.0:${config.server.port}`);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · lowpassd</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #222; }
  a { color: #06f; text-decoration: none; } a:hover { text-decoration: underline; }
  h1, h2, h3 { line-height: 1.2; }
  code { background: #f4f4f4; padding: 0 0.25em; border-radius: 3px; font-size: 0.92em; }
  pre code { display: block; padding: 1em; overflow-x: auto; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 1em; color: #555; }
  nav { margin-bottom: 2rem; font-size: 0.9em; }
  ul { padding-left: 1.4em; }
</style></head>
<body><nav><a href="/">← index</a></nav>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
