import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';

// One storage API, two backends:
//  - Local dev uses an S3-compatible backend (MinIO via docker-compose),
//    selected when S3_ENDPOINT is set.
//  - Prod uses native GCS, authenticating keylessly as the Cloud Run runtime
//    service account via ADC (S3_ENDPOINT unset).
const useS3 = !!config.storage.s3Endpoint;

interface StorageBackend {
  ensureBucket(bucket: string): Promise<void>;
  putText(bucket: string, key: string, body: string, contentType: string): Promise<void>;
  getText(bucket: string, key: string): Promise<string | null>;
  objectExists(bucket: string, key: string): Promise<boolean>;
  listObjects(bucket: string, prefix: string): Promise<string[]>;
  moveObject(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<void>;
}

// --- S3-compatible backend (local MinIO) ---

function makeS3Backend(): StorageBackend {
  const s3 = new S3Client({
    endpoint: config.storage.s3Endpoint,
    region: config.storage.s3Region,
    credentials: {
      accessKeyId: config.storage.s3AccessKey,
      secretAccessKey: config.storage.s3SecretKey,
    },
    forcePathStyle: config.storage.s3ForcePathStyle,
  });

  const isNotFound = (err: unknown): boolean => {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
  };

  return {
    async ensureBucket(bucket) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        // Some S3 implementations return 403 for missing buckets we own — try create anyway.
        try {
          await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (createErr) {
          const name = (createErr as { name?: string }).name;
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
            throw createErr;
          }
        }
      }
    },
    async putText(bucket, key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async getText(bucket, key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!res.Body) return null;
        return await res.Body.transformToString();
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async objectExists(bucket, key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
    async listObjects(bucket, prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const obj of res.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    async moveObject(srcBucket, srcKey, dstBucket, dstKey) {
      await s3.send(new CopyObjectCommand({
        Bucket: dstBucket,
        Key: dstKey,
        CopySource: `/${srcBucket}/${encodeURIComponent(srcKey).replace(/%2F/g, '/')}`,
      }));
      await s3.send(new DeleteObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    },
  };
}

// --- Native GCS backend (prod, keyless ADC) ---

function makeGcsBackend(): StorageBackend {
  const storage = new Storage({ projectId: config.storage.projectId });

  const isNotFound = (err: unknown): boolean => {
    if (typeof err !== 'object' || err === null) return false;
    return (err as { code?: number }).code === 404;
  };

  return {
    async ensureBucket(bucket) {
      const ref = storage.bucket(bucket);
      const [exists] = await ref.exists();
      if (!exists) await storage.createBucket(bucket);
    },
    async putText(bucket, key, body, contentType) {
      await storage.bucket(bucket).file(key).save(body, { contentType, resumable: false });
    },
    async getText(bucket, key) {
      try {
        const [buf] = await storage.bucket(bucket).file(key).download();
        return buf.toString('utf8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async objectExists(bucket, key) {
      const [exists] = await storage.bucket(bucket).file(key).exists();
      return exists;
    },
    async listObjects(bucket, prefix) {
      const [files] = await storage.bucket(bucket).getFiles({ prefix });
      return files.map(f => f.name);
    },
    async moveObject(srcBucket, srcKey, dstBucket, dstKey) {
      const src = storage.bucket(srcBucket).file(srcKey);
      await src.copy(storage.bucket(dstBucket).file(dstKey));
      await src.delete();
    },
  };
}

const backend: StorageBackend = useS3 ? makeS3Backend() : makeGcsBackend();

export function ensureBucket(bucket: string): Promise<void> {
  return backend.ensureBucket(bucket);
}

export async function ensureBuckets(): Promise<void> {
  await Promise.all([
    backend.ensureBucket(config.storage.buckets.raw),
    backend.ensureBucket(config.storage.buckets.archive),
    backend.ensureBucket(config.storage.buckets.wiki),
  ]);
}

export function putText(
  bucket: string,
  key: string,
  body: string,
  contentType = 'text/markdown; charset=utf-8',
): Promise<void> {
  return backend.putText(bucket, key, body, contentType);
}

export function getText(bucket: string, key: string): Promise<string | null> {
  return backend.getText(bucket, key);
}

export function objectExists(bucket: string, key: string): Promise<boolean> {
  return backend.objectExists(bucket, key);
}

export function listObjects(bucket: string, prefix = ''): Promise<string[]> {
  return backend.listObjects(bucket, prefix);
}

export function moveObject(
  srcBucket: string,
  srcKey: string,
  dstBucket: string,
  dstKey: string,
): Promise<void> {
  return backend.moveObject(srcBucket, srcKey, dstBucket, dstKey);
}
