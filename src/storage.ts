import { Storage } from '@google-cloud/storage';
import { config } from './config.js';

export const storage = new Storage({
  projectId: config.storage.projectId,
  // Set only for local dev (fake-gcs-server). Undefined in prod → real GCS via ADC.
  ...(config.storage.emulatorHost ? { apiEndpoint: config.storage.emulatorHost } : {}),
});

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: number }).code === 404;
}

export async function ensureBucket(bucket: string): Promise<void> {
  const ref = storage.bucket(bucket);
  const [exists] = await ref.exists();
  if (!exists) {
    await storage.createBucket(bucket);
  }
}

export async function ensureBuckets(): Promise<void> {
  await Promise.all([
    ensureBucket(config.storage.buckets.raw),
    ensureBucket(config.storage.buckets.archive),
    ensureBucket(config.storage.buckets.wiki),
  ]);
}

export async function putText(
  bucket: string,
  key: string,
  body: string,
  contentType = 'text/markdown; charset=utf-8',
): Promise<void> {
  await storage.bucket(bucket).file(key).save(body, {
    contentType,
    resumable: false,
  });
}

export async function getText(bucket: string, key: string): Promise<string | null> {
  try {
    const [buf] = await storage.bucket(bucket).file(key).download();
    return buf.toString('utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  const [exists] = await storage.bucket(bucket).file(key).exists();
  return exists;
}

export async function listObjects(bucket: string, prefix = ''): Promise<string[]> {
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  return files.map(f => f.name);
}

export async function moveObject(
  srcBucket: string,
  srcKey: string,
  dstBucket: string,
  dstKey: string,
): Promise<void> {
  const src = storage.bucket(srcBucket).file(srcKey);
  await src.copy(storage.bucket(dstBucket).file(dstKey));
  await src.delete();
}
