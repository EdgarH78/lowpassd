import { config } from './config.js';
import { generateJson } from './llm.js';
import { getText, listObjects, putText } from './storage.js';

// Prefix for internal links so navigation stays under the LB path (e.g.
// /lowpassd). Empty when served at root.
const BASE = config.server.basePath;

// ---- Types ---------------------------------------------------------------

export interface NewspaperSource {
  title: string;
  url: string;
}

export interface NewspaperStory {
  kicker: string;     // section label, ALL CAPS, e.g. "MODELS"
  headline: string;   // <= 80 chars
  dek: string;        // subheadline / one-sentence summary, <= 140 chars
  body: string;       // markdown, 3-5 short paragraphs
  sources: NewspaperSource[];
}

export interface NewspaperIssue {
  date: string;       // YYYY-MM-DD
  issuedAt: string;   // ISO timestamp
  articleCount: number;
  stories: NewspaperStory[];
}

export interface ArticleForNewspaper {
  title: string;
  url: string;
  feed: string;
  body: string;
}

// ---- LLM generation ------------------------------------------------------

const NEWSPAPER_SYSTEM = `You are the editor of "The Lowpass Dispatch", a daily newspaper for working software engineers tracking AI.
You write in the voice of a sharp newsroom: specific, named, dated, with numbers and quotes.

House style:
- Active voice. Direct prose.
- No LLM verbal tics: never write "furthermore", "in conclusion", "it is important to note", "delve into", "tapestry", "navigate".
- Lead paragraph carries the news. Middle paragraphs add context. Closing paragraph notes what's next or why it matters.
- Name people, products, versions. Cite specific numbers and quotes when articles supply them.
- Each story body is 3-5 short paragraphs (~80-150 words total).

Audience: a Staff Engineer who ships features with AI tools (Claude Code, Codex, Cursor), builds agents, and needs to spot what matters and skip what doesn't.`;

const NEWSPAPER_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      maxItems: 5,
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          kicker:   { type: 'string', description: '1-2 word section label, ALL CAPS (e.g. MODELS, AGENTS, TOOLS, RESEARCH).' },
          headline: { type: 'string', description: 'Punchy newspaper headline, max 80 chars.' },
          dek:      { type: 'string', description: 'One declarative sentence under 140 chars summarizing the story.' },
          body:     { type: 'string', description: 'Markdown body, 3-5 short paragraphs. Plain prose, no code fences.' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url:   { type: 'string' },
              },
              required: ['title', 'url'],
            },
          },
        },
        required: ['kicker', 'headline', 'dek', 'body', 'sources'],
      },
    },
  },
  required: ['stories'],
};

function newspaperPrompt(articles: ArticleForNewspaper[]): string {
  return `This cycle ingested ${articles.length} articles. Select the 5 biggest stories and write each as a newspaper article.

Editorial rules:
- Diversify. Do NOT pick 5 model releases or 5 tool updates — span themes (e.g. one model, one agent technique, one tool, one industry shift, one research finding).
- Synthesize. Each story should draw from multiple source articles when possible. A story is a TREND or DEVELOPMENT, not a single article paraphrased.
- Cite only the articles that actually support the story. The "sources" field is for attribution, not padding.
- House style applies (see system instruction).

ARTICLES (each has a URL — that is the ONLY URL that may appear in the sources list for facts from that article):
${articles.map((a, i) => articleBlock(a, i + 1)).join('\n\n')}`;
}

function articleBlock(a: ArticleForNewspaper, n: number): string {
  const body = a.body.length > 1500 ? `${a.body.slice(0, 1500)}\n…[truncated]` : a.body;
  return `--- [${n}] ${a.title} ---
URL: ${a.url}
FEED: ${a.feed}

${body}`;
}

export async function generateNewspaper(articles: ArticleForNewspaper[]): Promise<NewspaperIssue | null> {
  if (articles.length === 0) return null;
  const result = await generateJson<{ stories: NewspaperStory[] }>({
    tier: 'pro',
    systemInstruction: NEWSPAPER_SYSTEM,
    prompt: newspaperPrompt(articles),
    schema: NEWSPAPER_SCHEMA,
  });
  const issuedAt = new Date().toISOString();
  return {
    date: issuedAt.slice(0, 10),
    issuedAt,
    articleCount: articles.length,
    stories: (result.stories ?? []).slice(0, 5),
  };
}

// ---- Storage -------------------------------------------------------------

const NEWSPAPER_PREFIX = 'newspaper/';

export async function saveIssue(issue: NewspaperIssue): Promise<string> {
  const key = `${NEWSPAPER_PREFIX}${issue.date}.json`;
  await putText(
    config.storage.buckets.wiki,
    key,
    JSON.stringify(issue, null, 2),
    'application/json; charset=utf-8',
  );
  return key;
}

export async function loadLatestIssue(): Promise<NewspaperIssue | null> {
  const dates = await listIssueDates();
  if (dates.length === 0) return null;
  return loadIssueByDate(dates[0]!);
}

export async function loadIssueByDate(date: string): Promise<NewspaperIssue | null> {
  const text = await getText(config.storage.buckets.wiki, `${NEWSPAPER_PREFIX}${date}.json`);
  if (!text) return null;
  try {
    return JSON.parse(text) as NewspaperIssue;
  } catch {
    return null;
  }
}

export async function listIssueDates(): Promise<string[]> {
  const keys = await listObjects(config.storage.buckets.wiki, NEWSPAPER_PREFIX);
  return keys
    .filter(k => k.endsWith('.json'))
    .map(k => k.replace(NEWSPAPER_PREFIX, '').replace(/\.json$/, ''))
    .sort()
    .reverse();
}

// ---- HTML rendering ------------------------------------------------------

export function renderIssueHtml(issue: NewspaperIssue, opts?: { archives?: string[] }): string {
  const dateLong = formatDateLong(issue.date);
  const [lead, ...rest] = issue.stories;

  const archiveNav = opts?.archives && opts.archives.length > 1
    ? `<nav class="archives"><span class="archive-label">Past issues:</span> ${opts.archives
        .filter(d => d !== issue.date)
        .slice(0, 7)
        .map(d => `<a href="${BASE}/newspaper/${d}">${d}</a>`)
        .join(' · ')}</nav>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Lowpass Dispatch · ${dateLong}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=UnifrakturCook:wght@700&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
${NEWSPAPER_CSS}
</style>
</head>
<body>
  <nav class="topnav"><a href="${BASE}/">← wiki</a> <a href="${BASE}/newspaper/archives">archives</a></nav>
  <header class="masthead">
    <h1>The Lowpass Dispatch</h1>
    <div class="rules"></div>
    <div class="dateline">
      <span>Vol. I, No. ${issue.date}</span>
      <span>${dateLong}</span>
      <span>${issue.articleCount} articles surveyed</span>
    </div>
  </header>

  ${lead ? renderLeadStory(lead) : ''}

  <section class="secondary-grid">
    ${rest.map(renderStory).join('\n')}
  </section>

  ${archiveNav}

  <footer class="colophon">
    Compiled by lowpassd · Gemini editorial · issued ${issue.issuedAt}
  </footer>
</body></html>`;
}

function renderLeadStory(s: NewspaperStory): string {
  return `<article class="story lead">
    <div class="kicker">${escapeHtml(s.kicker)}</div>
    <h2 class="headline">${escapeHtml(s.headline)}</h2>
    <p class="dek">${escapeHtml(s.dek)}</p>
    <div class="body">${renderBody(s.body)}</div>
    ${renderSources(s.sources)}
  </article>`;
}

function renderStory(s: NewspaperStory): string {
  return `<article class="story">
    <div class="kicker">${escapeHtml(s.kicker)}</div>
    <h3 class="headline">${escapeHtml(s.headline)}</h3>
    <p class="dek">${escapeHtml(s.dek)}</p>
    <div class="body">${renderBody(s.body)}</div>
    ${renderSources(s.sources)}
  </article>`;
}

function renderBody(md: string): string {
  // Convert paragraphs (blank-line separated) to <p>. Inline a basic link parser.
  const paragraphs = md.trim().split(/\n\s*\n/);
  return paragraphs
    .map(p => `<p>${inlineMarkdown(p.trim())}</p>`)
    .join('\n');
}

function inlineMarkdown(text: string): string {
  // Order matters: escape HTML first, then re-introduce links/em/strong.
  let s = escapeHtml(text);
  // Links: [anchor](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, anchor: string, url: string) =>
    `<a href="${url}" rel="noopener">${anchor}</a>`,
  );
  // Autolinks: <https://...>
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_m, url: string) =>
    `<a href="${url}" rel="noopener">${url}</a>`,
  );
  // **strong**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *em*
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s;
}

function renderSources(sources: NewspaperSource[]): string {
  if (sources.length === 0) return '';
  return `<div class="sources">Sources: ${sources
    .map(s => `<a href="${escapeAttr(s.url)}" rel="noopener">${escapeHtml(s.title)}</a>`)
    .join(' · ')}</div>`;
}

function formatDateLong(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

export function renderArchivesHtml(dates: string[]): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>The Lowpass Dispatch · Archives</title>
<style>${NEWSPAPER_CSS}</style>
</head>
<body>
  <nav class="topnav"><a href="${BASE}/">← wiki</a> <a href="${BASE}/newspaper">latest issue</a></nav>
  <header class="masthead">
    <h1>The Lowpass Dispatch</h1>
    <div class="rules"></div>
    <div class="dateline"><span>Archives</span></div>
  </header>
  <section class="archive-list">
    ${dates.length === 0
      ? '<p><em>No issues yet.</em></p>'
      : `<ul>${dates.map(d => `<li><a href="${BASE}/newspaper/${d}">${formatDateLong(d)}</a></li>`).join('')}</ul>`}
  </section>
</body></html>`;
}

export function renderEmptyHtml(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>The Lowpass Dispatch</title>
<style>${NEWSPAPER_CSS}</style>
</head>
<body>
  <nav class="topnav"><a href="${BASE}/">← wiki</a></nav>
  <header class="masthead">
    <h1>The Lowpass Dispatch</h1>
    <div class="rules"></div>
    <div class="dateline"><span>No issue yet</span></div>
  </header>
  <p class="empty">No newspaper has been published. Run a compile cycle with at least five accepted articles to issue the first edition.</p>
</body></html>`;
}

// ---- Helpers -------------------------------------------------------------

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

// ---- CSS -----------------------------------------------------------------

const NEWSPAPER_CSS = `
:root {
  --paper: #f7f2e8;
  --ink:   #1a1a1a;
  --mute:  #5a5a5a;
  --rule:  #1a1a1a;
  --accent:#7a0f1f;
}
* { box-sizing: border-box; }
html, body {
  background: var(--paper);
  color: var(--ink);
  margin: 0;
  padding: 0;
}
body {
  font-family: 'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', serif;
  font-size: 17px;
  line-height: 1.55;
  max-width: 1080px;
  margin: 0 auto;
  padding: 1rem 2rem 3rem;
}
.topnav {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.85rem;
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #ddd;
}
.topnav a {
  color: var(--mute);
  text-decoration: none;
}
.topnav a:hover { color: var(--ink); text-decoration: underline; }

.masthead {
  text-align: center;
  padding: 1.25rem 0 0.75rem;
  border-bottom: 3px double var(--rule);
}
.masthead h1 {
  font-family: 'UnifrakturCook', 'UnifrakturMaguntia', 'Old English Text MT', Georgia, serif;
  font-weight: 700;
  font-size: clamp(2.8rem, 6vw, 4.6rem);
  margin: 0;
  letter-spacing: -1px;
  line-height: 1;
}
.dateline {
  display: flex;
  justify-content: space-between;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--mute);
  padding: 0.5rem 0;
  border-top: 1px solid var(--rule);
  margin-top: 0.6rem;
}

.story { margin-top: 1.8rem; }
.story .kicker {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  font-weight: 700;
  color: var(--accent);
  text-transform: uppercase;
  margin-bottom: 0.35rem;
}
.story .headline {
  font-family: 'Playfair Display', Georgia, serif;
  font-weight: 900;
  line-height: 1.05;
  margin: 0 0 0.4rem;
  color: var(--ink);
}
.story.lead .headline { font-size: clamp(2rem, 4.2vw, 3rem); }
.story .headline { font-size: 1.5rem; }
.story .dek {
  font-family: 'Source Serif 4', Georgia, serif;
  font-style: italic;
  font-size: 1.1rem;
  color: var(--mute);
  margin: 0 0 1rem;
  line-height: 1.4;
}
.story .body {
  font-size: 1rem;
  line-height: 1.62;
  hyphens: auto;
  text-align: justify;
}
.story.lead .body {
  column-count: 2;
  column-gap: 2.4rem;
}
.story.lead .body p:first-child::first-letter {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 3.6rem;
  float: left;
  line-height: 0.9;
  padding: 0.35rem 0.45rem 0 0;
  font-weight: 900;
}
.story p { margin: 0 0 0.85rem; }
.story a {
  color: var(--ink);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.story a:hover { color: var(--accent); }
.sources {
  margin-top: 0.6rem;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.82rem;
  color: var(--mute);
  letter-spacing: 0.02em;
}
.sources a { color: var(--mute); }
.sources a:hover { color: var(--ink); }

.secondary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem 2.4rem;
  margin-top: 2.2rem;
  border-top: 3px double var(--rule);
  padding-top: 1.2rem;
}
.secondary-grid .story {
  margin-top: 0;
  border-top: 1px solid #ccc;
  padding-top: 1.2rem;
}
.secondary-grid .story:nth-child(-n+2) { border-top: 0; padding-top: 0; }
@media (max-width: 720px) {
  .secondary-grid { grid-template-columns: 1fr; }
  .secondary-grid .story:nth-child(2) { border-top: 1px solid #ccc; padding-top: 1.2rem; }
  .story.lead .body { column-count: 1; }
}

.archives, .archive-list {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.9rem;
  color: var(--mute);
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid #ddd;
}
.archives a { color: var(--mute); text-decoration: none; margin-right: 0.4rem; }
.archives a:hover { color: var(--ink); text-decoration: underline; }
.archive-label { font-weight: 700; margin-right: 0.5rem; }
.archive-list ul { list-style: none; padding: 0; }
.archive-list li { padding: 0.35rem 0; border-bottom: 1px dotted #ccc; }
.archive-list a { color: var(--ink); text-decoration: none; }
.archive-list a:hover { color: var(--accent); }

.colophon {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid #ddd;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 0.78rem;
  color: var(--mute);
  text-align: center;
  font-style: italic;
}
.empty { text-align: center; padding: 3rem 1rem; color: var(--mute); font-style: italic; }
`;
