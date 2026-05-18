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
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'lowpassd',
    secretKey: process.env.S3_SECRET_KEY ?? 'lowpassd-secret',
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
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
  },
  server: {
    port: num(process.env.PORT, 8080),
  },
} as const;
