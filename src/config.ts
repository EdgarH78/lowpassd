import 'dotenv/config';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  storage: {
    // In prod, the Storage client authenticates as the Cloud Run runtime
    // service account via ADC. Locally, STORAGE_EMULATOR_HOST points the
    // client at the fake-gcs-server container (no credentials needed).
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    emulatorHost: process.env.STORAGE_EMULATOR_HOST,
    buckets: {
      raw: process.env.BUCKET_RAW ?? 'lowpassd-raw',
      archive: process.env.BUCKET_ARCHIVE ?? 'lowpassd-archive',
      wiki: process.env.BUCKET_WIKI ?? 'lowpassd-wiki',
    },
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    flashModel: process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.5-flash',
    proModel: process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro',
  },
  orchestrator: {
    cron: process.env.CRON_SCHEDULE ?? '0 */6 * * *',
    maxLookbackDays: num(process.env.MAX_LOOKBACK_DAYS, 7),
    runOnStart: bool(process.env.RUN_ON_START, true),
    // Cap raw articles compiled per cycle so a run finishes within Cloud Run's
    // request timeout. Oldest-first; a large backlog drains over several runs.
    maxArticlesPerCycle: num(process.env.MAX_ARTICLES_PER_CYCLE, 150),
  },
  server: {
    port: num(process.env.PORT, 8080),
    // Path prefix the app is served under (e.g. "/lowpassd" behind the
    // forgerealm load balancer). Empty for local/root serving. Used to prefix
    // all internal links so navigation stays under the prefix. Normalized to
    // have no trailing slash.
    basePath: (process.env.BASE_PATH ?? '').replace(/\/+$/, ''),
  },
} as const;
