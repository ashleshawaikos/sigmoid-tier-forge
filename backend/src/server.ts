import app from './app.js';
import { config } from './config.js';
import { jobService } from './services/tierforgeServices.js';

jobService.failInterruptedJobs();
app.listen(config.port, () => {
  console.log(`TierForge backend running on http://localhost:${config.port}`);
});
