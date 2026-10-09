import app from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { jobService } from './services/tierforgeServices.js';

void jobService.resumeActiveJobs().catch((error: unknown) => {
  logger.error('job.recovery.startup_failed', {
    message:
      error instanceof Error
        ? error.message
        : 'Unknown startup recovery error.',
  });
});
app.listen(config.port, () => {
  console.log(`TierForge backend running on http://localhost:${config.port}`);
});
