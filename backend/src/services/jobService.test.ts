import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteConnection } from '../lib/db.js';
import { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import { JobService } from './jobService.js';

const store = {
  store_id: 'ST001',
  store_name: 'Central Store',
  address: '1 Main Street',
  city: 'Delhi',
  state: 'Delhi',
  country: 'India',
};
const metrics = {
  estimated_monthly_footfall: 20000,
  estimated_monthly_revenue: 180000,
  store_size_sqft: 9000,
};

function setup(): {
  connection: SqliteConnection;
  repository: TierforgeRepository;
} {
  const connection = new SqliteConnection(':memory:');
  return { connection, repository: new TierforgeRepository(connection) };
}

test('retries failed enrichment requests and completes the job', async () => {
  const { connection, repository } = setup();
  try {
    const jobId = repository.createJob('retry test', [store]);
    let calls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          calls += 1;
          if (calls < 2) throw new Error('temporary upstream failure');
          return metrics;
        },
      },
      { workerCount: 1, maxAttempts: 3, backoffMs: 0 },
    );

    await service.runJob(jobId);

    const summary = repository.getJobSummary(jobId);
    assert.equal(calls, 2);
    assert.equal(summary?.status, 'completed');
    assert.equal(summary?.enriched_stores, 1);
    assert.equal(summary?.pending_stores, 0);
    const stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(stores.items[0]?.attempts, 2);
    assert.equal(
      stores.items[0]?.estimated_monthly_footfall,
      metrics.estimated_monthly_footfall,
    );
  } finally {
    connection.close();
  }
});

test('stops after the configured maximum attempts and stores a terminal failure', async () => {
  const { connection, repository } = setup();
  try {
    const jobId = repository.createJob('bounded failure', [store]);
    let calls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          calls += 1;
          throw new Error('upstream unavailable');
        },
      },
      { workerCount: 1, maxAttempts: 2, backoffMs: 0 },
    );
    await service.runJob(jobId);

    const summary = repository.getJobSummary(jobId);
    const stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(calls, 2);
    assert.equal(summary?.status, 'failed');
    assert.equal(summary?.failed_stores, 1);
    assert.equal(stores.items[0]?.status, 'failed');
    assert.match(
      stores.items[0]?.failure_reason ?? '',
      /Failed after 2 attempts/,
    );
  } finally {
    connection.close();
  }
});

test('attempt fencing prevents a stale response from persisting metrics', () => {
  const { connection, repository } = setup();
  try {
    const jobId = repository.createJob('fencing', [store]);
    const staleAttempt = repository.startAttempt(jobId, store.store_id);
    const currentAttempt = repository.startAttempt(jobId, store.store_id);
    assert.equal(staleAttempt, 1);
    assert.equal(currentAttempt, 2);
    assert.equal(
      repository.completeAttempt(jobId, store.store_id, staleAttempt!, metrics),
      false,
    );
    assert.equal(
      repository.completeAttempt(
        jobId,
        store.store_id,
        currentAttempt!,
        metrics,
      ),
      true,
    );
    assert.equal(repository.listScorableStores(jobId).length, 1);
    assert.equal(repository.getJobSummary(jobId)?.enriched_stores, 1);
  } finally {
    connection.close();
  }
});

test('runs multiple enrichment jobs concurrently', async () => {
  const { connection, repository } = setup();
  try {
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          if (inFlight === 2) signalBothStarted();
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight -= 1;
          return metrics;
        },
      },
      { workerCount: 1 },
    );
    let inFlight = 0;
    let maximumInFlight = 0;
    let signalBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    const releases: Array<() => void> = [];

    const firstJobId = service.createJob('first job', [store]);
    const secondJobId = service.createJob('second job', [store]);
    const firstRun = service.runJob(firstJobId);
    const secondRun = service.runJob(secondJobId);

    await bothStarted;
    assert.equal(maximumInFlight, 2);
    for (const release of releases) release();
    await Promise.all([firstRun, secondRun]);

    assert.equal(repository.getJobSummary(firstJobId)?.status, 'completed');
    assert.equal(repository.getJobSummary(secondJobId)?.status, 'completed');
  } finally {
    connection.close();
  }
});
