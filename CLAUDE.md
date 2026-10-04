# lowpassd

## Storage architecture — DO NOT change without explicit user approval

Storage uses **two backends behind one API** (`src/storage.ts`), selected at
startup by whether `S3_ENDPOINT` is set:

- **Local dev → MinIO** (S3-compatible). `docker-compose.yml` runs MinIO;
  `.env` sets `S3_ENDPOINT=http://localhost:9100`. The S3 client (`@aws-sdk/client-s3`)
  is used.
- **Prod → native GCS**, keyless, authenticating as the Cloud Run runtime
  service account via ADC. `S3_ENDPOINT` is unset in prod (see `cloudbuild.yaml`),
  so the GCS client (`@google-cloud/storage`) is used.

This split is intentional and longstanding: **MinIO locally, GCS in prod.** Do
not replace MinIO with a GCS emulator (fake-gcs-server) or otherwise remove the
S3 path. A prior change did this without authorization and broke local startup;
it has been reverted. If you believe the storage layer should change, ask first.

The exported function API (`ensureBuckets`, `putText`, `getText`,
`objectExists`, `listObjects`, `moveObject`) is backend-agnostic — change
internals, not signatures.

## Running locally

```sh
docker compose up -d minio minio-init   # start MinIO + create buckets
npm run dev                             # tsx watch, reads .env (S3_ENDPOINT=localhost:9100)
```
