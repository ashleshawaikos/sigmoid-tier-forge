import { z } from 'zod';

import { ApplicationError } from '../lib/applicationError.js';
import type { Tier } from '../lib/db.js';
import type { TierforgeRepository } from '../repositories/tierforgeRepository.js';

const metricSchema = z.object({
  estimated_monthly_footfall: z.number().finite().nonnegative(),
  estimated_monthly_revenue: z.number().finite().nonnegative(),
  store_size_sqft: z.number().finite().nonnegative(),
});

export const scoringSchema = z
  .object({
    bars: metricSchema,
    weights: z.object({
      estimated_monthly_footfall: z.number().finite().min(0).max(100),
      estimated_monthly_revenue: z.number().finite().min(0).max(100),
      store_size_sqft: z.number().finite().min(0).max(100),
    }),
    thresholds: z.object({
      Large: z.number().finite().min(0).max(100),
      Medium: z.number().finite().min(0).max(100),
    }),
  })
  .superRefine((value, context) => {
    const weightTotal = Object.values(value.weights).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    if (Math.abs(weightTotal - 100) > 0.001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Metric weights must sum to 100.',
      });
    }
    if (value.thresholds.Large <= value.thresholds.Medium) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Large threshold must be greater than Medium threshold.',
      });
    }
  });

export type ScoringConfig = z.infer<typeof scoringSchema>;

export function computeStoreScore(
  metrics: z.infer<typeof metricSchema>,
  bars: ScoringConfig['bars'],
  weights: ScoringConfig['weights'],
): number {
  let score = 0;
  if (metrics.estimated_monthly_footfall >= bars.estimated_monthly_footfall)
    score += weights.estimated_monthly_footfall;
  if (metrics.estimated_monthly_revenue >= bars.estimated_monthly_revenue)
    score += weights.estimated_monthly_revenue;
  if (metrics.store_size_sqft >= bars.store_size_sqft)
    score += weights.store_size_sqft;
  return Math.min(score, 100);
}

export function determineTier(
  score: number,
  thresholds: ScoringConfig['thresholds'],
): Tier {
  if (score >= thresholds.Large) return 'Large';
  if (score >= thresholds.Medium) return 'Medium';
  return 'Small';
}

export class ScoringService {
  constructor(private readonly repository: TierforgeRepository) {}

  scoreJob(
    jobId: number,
    input: unknown,
  ): {
    scoredStores: number;
    tierBreakdown: Record<Tier, number>;
    scoring: ScoringConfig;
  } {
    const parsed = scoringSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApplicationError(
        'INVALID_SCORING',
        'Invalid scoring configuration.',
        parsed.error.issues,
      );
    }
    const job = this.repository.getJob(jobId);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Job not found.');
    if (job.status === 'running' || job.status === 'queued') {
      throw new ApplicationError(
        'JOB_ACTIVE',
        'Wait for enrichment to finish before scoring this job.',
      );
    }

    if (job.status !== 'completed') {
      throw new ApplicationError(
        'NO_ENRICHMENT_DATA',
        'Data not available: no stores were successfully enriched.',
      );
    }

    const { bars, weights, thresholds } = parsed.data;
    const scorableStores = this.repository.listScorableStores(jobId);
    if (scorableStores.length === 0) {
      throw new ApplicationError(
        'NO_ENRICHMENT_DATA',
        'Data not available: no stores were successfully enriched.',
      );
    }
    const scores = scorableStores.map((store) => {
      const score = computeStoreScore(store, bars, weights);
      return {
        storeId: store.store_id,
        score,
        tier: determineTier(score, thresholds),
      };
    });
    this.repository.saveScores(jobId, parsed.data, scores);
    return {
      scoredStores: scores.length,
      tierBreakdown: this.repository.scoreBreakdown(jobId),
      scoring: parsed.data,
    };
  }
}
