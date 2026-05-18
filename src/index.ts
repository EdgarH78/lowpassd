import cron from 'node-cron';
import { config } from './config.js';
import { cycle } from './orchestrator.js';
import { startServer } from './server.js';
import { ensureBuckets } from './storage.js';

async function main(): Promise<void> {
  console.log('[lowpassd] booting');
  await ensureBuckets();

  startServer();

  if (config.orchestrator.runOnStart) {
    console.log('[lowpassd] running initial cycle');
    void cycle().then(r => console.log('[lowpassd] initial cycle', r));
  }

  if (!cron.validate(config.orchestrator.cron)) {
    throw new Error(`invalid CRON_SCHEDULE: ${config.orchestrator.cron}`);
  }
  cron.schedule(config.orchestrator.cron, () => {
    console.log('[lowpassd] cron tick');
    void cycle().then(r => console.log('[lowpassd] cycle', r));
  });
  console.log(`[lowpassd] cron scheduled: ${config.orchestrator.cron}`);
}

main().catch(err => {
  console.error('[lowpassd] fatal', err);
  process.exit(1);
});
