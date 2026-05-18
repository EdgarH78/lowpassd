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
import { config } from './config.js';

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: config.s3.forcePathStyle,
});

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

export async function ensureBucket(bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (!isNotFound(err)) {
      // Some S3 implementations (incl. GCS interop) return 403 for missing buckets we own — try create anyway.
    }
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (createErr) {
      const name = (createErr as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
        throw createErr;
      }
    }
  }
}

export async function ensureBuckets(): Promise<void> {
  await Promise.all([
    ensureBucket(config.s3.buckets.raw),
    ensureBucket(config.s3.buckets.archive),
    ensureBucket(config.s3.buckets.wiki),
  ]);
}

export async function putText(
  bucket: string,
  key: string,
  body: string,
  contentType = 'text/markdown; charset=utf-8',
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function getText(bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    return await res.Body.transformToString();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function listObjects(bucket: string, prefix = ''): Promise<string[]> {
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
}

export async function moveObject(
  srcBucket: string,
  srcKey: string,
  dstBucket: string,
  dstKey: string,
): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: dstBucket,
    Key: dstKey,
    CopySource: `/${srcBucket}/${encodeURIComponent(srcKey).replace(/%2F/g, '/')}`,
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: srcBucket, Key: srcKey }));
}
