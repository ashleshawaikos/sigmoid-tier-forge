import { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import { EnrichmentCircuitBreaker } from '../infrastructure/resilience/enrichmentCircuitBreaker.js';
import { JobService } from './jobService.js';
import { ScoringService } from './scoringService.js';

export const tierforgeRepository = new TierforgeRepository();
export const enrichmentCircuitBreaker = new EnrichmentCircuitBreaker();
export const jobService = new JobService(
  tierforgeRepository,
  undefined,
  undefined,
  enrichmentCircuitBreaker,
);
export const scoringService = new ScoringService(tierforgeRepository);
