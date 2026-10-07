import { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import { JobService } from './jobService.js';
import { ScoringService } from './scoringService.js';

export const tierforgeRepository = new TierforgeRepository();
export const jobService = new JobService(tierforgeRepository);
export const scoringService = new ScoringService(tierforgeRepository);
