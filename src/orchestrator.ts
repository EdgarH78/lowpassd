import { compile, type CompileResult } from './compiler.js';
import { ingest, type IngestResult } from './ingest.js';

let running = false;

export interface CycleResult {
  ok: boolean;
  durationMs: number;
  skipped?: boolean;
  ingest?: IngestResult;
  compile?: CompileResult;
  error?: string;
}

export function isRunning(): boolean {
  return running;
}

export async function cycle(): Promise<CycleResult> {
  if (running) {
    return { ok: false, durationMs: 0, skipped: true };
  }
  running = true;
  const start = Date.now();
  try {
    const ingestRes = await ingest();
    const compileRes = await compile();
    return {
      ok: true,
      durationMs: Date.now() - start,
      ingest: ingestRes,
      compile: compileRes,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    running = false;
  }
}
