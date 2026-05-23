# lowpassd

A high-signal AI knowledge wiki, compiled automatically by Gemini from RSS feeds.

lowpassd ingests AI/ML news and research from a curated set of feeds, uses Gemini to sort each article into a fixed topic taxonomy, and continuously rewrites a cross-linked Markdown wiki — plus a daily "newspaper" digest and a chat agent that navigates the wiki for you. It's a low-pass filter on the AI firehose: only the signal relevant to a Staff Engineer building with and on top of AI makes it through.

**Live:** [theforgerealm.com/lowpassd](https://theforgerealm.com/lowpassd)

## How it works

Every cycle runs two phases:

1. **Ingest** — Pull new items from each [feed](src/feeds.ts) (tracked per-feed by a published-date cursor in `state/feeds.json`) and store them as raw Markdown in the `raw` bucket.
   - High-volume firehoses (arXiv) are flagged `prefilter`: their items are triaged by title + abstract through a cheap batched Gemini Flash call ([`src/prefilter.ts`](src/prefilter.ts)) so only papers relevant to the taxonomy are stored — the rest never cost a full categorization.
2. **Compile** ([`src/compiler.ts`](src/compiler.ts)) —
   - **Categorize:** each raw article is classified into the topic [`ALLOWLIST`](src/compiler.ts) (Flash, or Pro for `dense` feeds). Articles that fit no topic are dropped to `wiki/rejected.log`.
   - **Write:** for each touched topic, Gemini rewrites the wiki page, integrating the new articles and preserving still-relevant content. Cited URLs are validated (with retries) so pages don't accumulate dead links.
   - **Archive:** processed raw articles move to the `archive` bucket.
   - **Newspaper:** once enough accepted articles accumulate, an issue of *The Lowpass Dispatch* is generated.

A per-cycle cap (`MAX_ARTICLES_PER_CYCLE`) bounds each run so a large backlog drains over several cycles instead of blowing the request timeout.

## Storage

Three GCS buckets (one [`@google-cloud/storage`](src/storage.ts) client, keyless via ADC in prod):

| Bucket | Holds |
|--------|-------|
| `raw` | newly ingested articles + `state/feeds.json` cursors |
| `archive` | articles already compiled into the wiki |
| `wiki` | the compiled Markdown pages, `topic-index.json`, newspaper issues |

## HTTP routes

Served by [Hono](src/server.ts):

| Route | Purpose |
|-------|---------|
| `GET /` | wiki index |
| `GET /wiki/:slug` | a rendered wiki page |
| `GET /newspaper`, `/newspaper/:date`, `/newspaper/archives` | *The Lowpass Dispatch* |
| `GET /chat` + `POST /chat/api` | chat agent that navigates the wiki ([`src/chat.ts`](src/chat.ts)) |
| `POST /trigger` | run a cycle synchronously (guarded against concurrent runs) |
| `GET /status`, `GET /health` | liveness / running state |

## Local development

Requires Node 22+ and a Gemini API key. Storage is emulated with [fake-gcs-server](https://github.com/fsouza/fake-gcs-server) — no GCP needed.

```bash
cp .env.example .env   # add GEMINI_API_KEY
docker compose up      # app + fake GCS on :8080
```

Or run the app directly against the emulator / your own GCS:

```bash
npm install
npm run dev            # tsx watch, runs an initial cycle then the cron
```

### CLI

One-off pipeline steps without the server ([`src/cli.ts`](src/cli.ts)):

```bash
npm run ingest         # pull feeds → raw bucket
npm run compile        # categorize + rewrite wiki pages
npm run cycle          # ingest then compile
```

Plus maintenance commands: `newspaper-from-archive`, `rebuild-topic-index`, `clean-wiki-links` (`tsx src/cli.ts <cmd>`).

## Configuration

All via environment variables ([`src/config.ts`](src/config.ts)):

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | **required**; Gemini API key |
| `GEMINI_FLASH_MODEL` | `gemini-2.5-flash` | model for triage/categorization |
| `GEMINI_PRO_MODEL` | `gemini-2.5-pro` | model for `dense` feeds |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project (prod) |
| `STORAGE_EMULATOR_HOST` | — | fake-gcs endpoint (local only) |
| `BUCKET_RAW` / `BUCKET_ARCHIVE` / `BUCKET_WIKI` | `lowpassd-*` | bucket names |
| `CRON_SCHEDULE` | `0 */6 * * *` | in-process cron (unused when driven by Cloud Scheduler) |
| `MAX_LOOKBACK_DAYS` | `7` | ignore feed items older than this |
| `MAX_ARTICLES_PER_CYCLE` | `150` | cap on articles compiled per cycle |
| `RUN_ON_START` | `true` | run a cycle on boot |
| `BASE_PATH` | — | path prefix when served behind a load balancer (e.g. `/lowpassd`) |
| `PORT` | `8080` | server port |

## Deployment

Runs on **Cloud Run** (scale-to-zero), built and deployed on push to `main` via GitHub Actions + Cloud Build ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), [`cloudbuild.yaml`](cloudbuild.yaml)). Storage uses native GCS through the runtime service account (keyless ADC); the Gemini key comes from Secret Manager. A **Cloud Scheduler** job `POST`s `/trigger` every 6 hours — CPU is throttled after the response on a scale-to-zero instance, so the cycle runs synchronously within the request rather than fire-and-forget.

Publicly served at `theforgerealm.com/lowpassd` behind a shared external HTTPS load balancer (serverless NEG → backend service → path-prefix route). `BASE_PATH` makes the app emit links under that prefix.

## Tech stack

TypeScript (Node 22, ESM) · [Hono](https://hono.dev) · Gemini · `@google-cloud/storage` · `rss-parser` · `marked` · `turndown` · `node-cron`.
