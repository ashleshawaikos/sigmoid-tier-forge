import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteConnection } from '../lib/db.js';
import { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import {
  computeStoreScore,
  determineTier,
  scoringSchema,
  ScoringService,
} from './scoringService.js';

test('scores a store by adding the weights for metrics that meet their bars', () => {
  const score = computeStoreScore(
    {
      estimated_monthly_footfall: 20_000,
      estimated_monthly_revenue: 100_000,
      store_size_sqft: 5_000,
    },
    {
      estimated_monthly_footfall: 15_000,
      estimated_monthly_revenue: 150_000,
      store_size_sqft: 8_000,
    },
    {
      estimated_monthly_footfall: 50,
      estimated_monthly_revenue: 30,
      store_size_sqft: 20,
    },
  );
  assert.equal(score, 50);
});

test('uses inclusive tier boundaries', () => {
  assert.equal(determineTier(70, { Large: 70, Medium: 40 }), 'Large');
  assert.equal(determineTier(40, { Large: 70, Medium: 40 }), 'Medium');
  assert.equal(determineTier(39.99, { Large: 70, Medium: 40 }), 'Small');
  assert.equal(determineTier(69.996, { Large: 70, Medium: 40 }), 'Medium');
});

test('validates weight totals and ordered tier thresholds', () => {
  const valid = {
    bars: {
      estimated_monthly_footfall: 100,
      estimated_monthly_revenue: 100,
      store_size_sqft: 100,
    },
    weights: {
      estimated_monthly_footfall: 50,
      estimated_monthly_revenue: 30,
      store_size_sqft: 20,
    },
    thresholds: { Large: 70, Medium: 40 },
  };
  assert.equal(scoringSchema.safeParse(valid).success, true);
  assert.equal(
    scoringSchema.safeParse({
      ...valid,
      weights: { ...valid.weights, store_size_sqft: 10 },
    }).success,
    false,
  );
  assert.equal(
    scoringSchema.safeParse({
      ...valid,
      thresholds: { Large: 40, Medium: 40 },
    }).success,
    false,
  );
});

test('re-scoring replaces prior tiers using only stored enrichment metrics', () => {
  const connection = new SqliteConnection(':memory:');
  try {
    const repository = new TierforgeRepository(connection);
    const store = {
      store_id: 'ST001',
      store_name: 'Example',
      address: '1 Main',
      city: 'Delhi',
      state: 'Delhi',
      country: 'India',
    };
    const jobId = repository.createJob('scoring test', [store]);
    const attemptId = repository.startAttempt(jobId, store.store_id);
    assert.ok(attemptId !== undefined);
    assert.equal(
      repository.completeAttempt(jobId, store.store_id, attemptId, {
        estimated_monthly_footfall: 20000,
        estimated_monthly_revenue: 200000,
        store_size_sqft: 9000,
      }),
      true,
    );
    repository.finishJob(jobId);
    const scoring = new ScoringService(repository);
    const config = {
      bars: {
        estimated_monthly_footfall: 10000,
        estimated_monthly_revenue: 100000,
        store_size_sqft: 5000,
      },
      weights: {
        estimated_monthly_footfall: 50,
        estimated_monthly_revenue: 30,
        store_size_sqft: 20,
      },
      thresholds: { Large: 70, Medium: 40 },
    };

    assert.deepEqual(scoring.scoreJob(jobId, config).tierBreakdown, {
      Large: 1,
      Medium: 0,
      Small: 0,
    });
    assert.deepEqual(
      scoring.scoreJob(jobId, {
        ...config,
        bars: {
          estimated_monthly_footfall: 50000,
          estimated_monthly_revenue: 500000,
          store_size_sqft: 20000,
        },
      }).tierBreakdown,
      { Large: 0, Medium: 0, Small: 1 },
    );
    assert.equal(
      repository.listStores(jobId, { page: 1, pageSize: 5 }).items[0]?.tier,
      'Small',
    );
  } finally {
    connection.close();
  }
});
