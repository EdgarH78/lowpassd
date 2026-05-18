import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { marked } from 'marked';
import { chat, type ChatMessage } from './chat.js';
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
      <p><a href="/newspaper"><strong>The Lowpass Dispatch</strong> (daily newspaper)</a> · <a href="/chat">chat</a> · <a href="/trigger" onclick="event.preventDefault();fetch('/trigger',{method:'POST'}).then(r=>r.json()).then(j=>alert(JSON.stringify(j)))">Run cycle now</a> · <a href="/status">status</a></p>
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

  app.get('/chat', c => c.html(CHAT_UI_HTML));

  app.post('/chat/api', async c => {
    let body: { history?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const history = parseChatHistory(body.history);
    if (history === null) {
      return c.json({ error: 'history must be an array of {role, content}' }, 400);
    }
    if (history.length === 0) {
      return c.json({ error: 'history is empty' }, 400);
    }
    try {
      const result = await chat(history);
      return c.json(result);
    } catch (err) {
      console.error('[chat] error', err);
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
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

function parseChatHistory(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return null;
    const r = (m as { role?: unknown }).role;
    const c = (m as { content?: unknown }).content;
    if ((r !== 'user' && r !== 'assistant') || typeof c !== 'string') return null;
    out.push({ role: r, content: c });
  }
  return out;
}

const CHAT_UI_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>chat · lowpassd</title>
<style>
  :root { --user: #e7eef9; --assistant: #f4f4f4; --muted: #666; --accent: #06f; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 0 1rem 7rem; line-height: 1.5; color: #222; }
  nav { padding: 0.6rem 0; font-size: 0.9em; border-bottom: 1px solid #ddd; margin-bottom: 1rem; }
  nav a { color: var(--accent); text-decoration: none; margin-right: 1rem; }
  nav a:hover { text-decoration: underline; }
  h1 { font-size: 1.4rem; margin: 0.5rem 0 1rem; }
  #messages { display: flex; flex-direction: column; gap: 1rem; }
  .msg { padding: 0.7rem 1rem; border-radius: 10px; max-width: 92%; word-wrap: break-word; white-space: pre-wrap; }
  .msg.user { background: var(--user); align-self: flex-end; }
  .msg.assistant { background: var(--assistant); align-self: flex-start; }
  .msg.assistant.error { background: #fde7e7; }
  .msg .body a { color: var(--accent); }
  .msg .tools { font-size: 0.8em; color: var(--muted); margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px dashed #ccc; }
  .msg .tools details { background: #fff; padding: 0.3rem 0.6rem; border-radius: 4px; margin-top: 0.3rem; }
  .msg .tools summary { cursor: pointer; font-family: 'SF Mono', Menlo, monospace; font-size: 0.85em; word-break: break-all; }
  .msg .tools pre { font-family: 'SF Mono', Menlo, monospace; font-size: 0.72rem; max-height: 240px; overflow: auto; background: #fafafa; padding: 0.4rem; margin: 0.4rem 0 0; white-space: pre; }
  #composer { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #ddd; padding: 0.7rem 1rem; }
  #composer-inner { max-width: 760px; margin: 0 auto; display: flex; gap: 0.5rem; }
  #input { flex: 1; padding: 0.6rem 0.8rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; font-family: inherit; }
  button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; background: var(--accent); color: white; border: 0; border-radius: 6px; }
  button:disabled { background: #aaa; cursor: not-allowed; }
  .hint { color: var(--muted); font-size: 0.85em; margin-bottom: 1rem; }
  .iter-cap { color: #a00; font-size: 0.85em; margin-top: 0.4rem; }
</style>
</head>
<body>
<nav>
  <a href="/">← wiki</a>
  <a href="/newspaper">newspaper</a>
</nav>
<h1>chat with lowpassd</h1>
<p class="hint">Ask about anything in the wiki: topics, recent articles, who's saying what. The agent navigates the wiki for you; tool calls are visible below each answer.</p>
<div id="messages"></div>
<form id="composer">
  <div id="composer-inner">
    <input id="input" autofocus placeholder="What's new with Claude Code?" autocomplete="off">
    <button type="submit" id="send">Send</button>
  </div>
</form>
<script>
  const history = [];
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderLinks(text) {
    // Rescue [https://...] brackets-only citations into autolinks first.
    const fixed = text.replace(/\\[(https?:\\/\\/[^\\]\\s]+)\\](?!\\()/g, '<$1>');
    const safe = fixed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return safe
      .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>')
      .replace(/&lt;(https?:\\/\\/[^&\\s]+)&gt;/g, '<a href="$1" rel="noopener" target="_blank">$1</a>')
      .replace(/(^|[^"=>/])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2" rel="noopener" target="_blank">$2</a>');
  }

  function renderMessage({ role, content, toolCalls, hitCap, error }) {
    const div = el('div', 'msg ' + role + (error ? ' error' : ''));
    const body = el('div', 'body');
    body.innerHTML = renderLinks(content);
    div.appendChild(body);
    if (hitCap) {
      const cap = el('div', 'iter-cap', 'iteration cap reached');
      div.appendChild(cap);
    }
    if (toolCalls && toolCalls.length) {
      const tools = el('div', 'tools');
      tools.appendChild(el('div', null, toolCalls.length + ' tool call(s)'));
      for (const tc of toolCalls) {
        const det = el('details');
        const sum = el('summary', null, tc.name + '(' + JSON.stringify(tc.args) + ')');
        det.appendChild(sum);
        const pre = el('pre');
        pre.textContent = JSON.stringify(tc.result, null, 2);
        det.appendChild(pre);
        tools.appendChild(det);
      }
      div.appendChild(tools);
    }
    messagesEl.appendChild(div);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    const userMsg = { role: 'user', content: text };
    history.push(userMsg);
    renderMessage(userMsg);

    const thinking = el('div', 'msg assistant', '…');
    messagesEl.appendChild(thinking);
    window.scrollTo({ top: document.body.scrollHeight });

    try {
      const res = await fetch('/chat/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok || data.error) {
        renderMessage({ role: 'assistant', content: 'error: ' + (data.error ?? res.statusText), error: true });
      } else {
        history.push({ role: 'assistant', content: data.reply });
        renderMessage({
          role: 'assistant',
          content: data.reply,
          toolCalls: data.toolCalls,
          hitCap: data.hitIterationCap,
        });
      }
    } catch (err) {
      thinking.remove();
      renderMessage({ role: 'assistant', content: 'network error: ' + err.message, error: true });
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
</script>
</body></html>`;
