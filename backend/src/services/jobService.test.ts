import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EnrichmentError } from '../infrastructure/http/enrichmentError.js';
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

test('does not retry a permanent enrichment failure', async () => {
  const { connection, repository } = setup();
  try {
    const jobId = repository.createJob('permanent failure', [store]);
    let calls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          calls += 1;
          throw new EnrichmentError('invalid enrichment response', false);
        },
      },
      { workerCount: 1, maxAttempts: 5, backoffMs: 0 },
    );

    await service.runJob(jobId);

    const summary = repository.getJobSummary(jobId);
    const stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(calls, 1);
    assert.equal(summary?.status, 'failed');
    assert.equal(summary?.failed_stores, 1);
    assert.equal(stores.items[0]?.attempts, 1);
    assert.equal(
      stores.items[0]?.failure_reason,
      'Permanent enrichment failure: invalid enrichment response',
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
    assert.match(
      stores.items[0]?.failure_reason ?? '',
      /Last error: upstream unavailable/,
    );

    assert.equal(service.retryFailedStores(jobId), 1);
    await service.runJob(jobId);
    const retriedStores = repository.listStores(jobId, {
      page: 1,
      pageSize: 10,
    });
    assert.equal(calls, 4);
    assert.equal(repository.getJobSummary(jobId)?.status, 'failed');
    assert.equal(retriedStores.items[0]?.attempts, 2);
    assert.match(
      retriedStores.items[0]?.failure_reason ?? '',
      /Failed after 2 attempts\. Last error: upstream unavailable/,
    );
  } finally {
    connection.close();
  }
});

test('retries only failed stores with a fresh attempt budget', async () => {
  const { connection, repository } = setup();
  try {
    const secondStore = {
      ...store,
      store_id: 'ST002',
      store_name: 'North Store',
    };
    const jobId = repository.createJob('failed store retry', [
      store,
      secondStore,
    ]);
    let firstStoreCalls = 0;
    let secondStoreCalls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async ({ store_id }) => {
          if (store_id === store.store_id) {
            firstStoreCalls += 1;
            return metrics;
          }
          secondStoreCalls += 1;
          if (secondStoreCalls <= 2) throw new Error('simulator unavailable');
          return metrics;
        },
      },
      { workerCount: 1, maxAttempts: 2, backoffMs: 0 },
    );

    await service.runJob(jobId);

    let stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(repository.getJobSummary(jobId)?.status, 'completed');
    assert.equal(stores.items[0]?.attempts, 1);
    assert.equal(stores.items[0]?.status, 'enriched');
    assert.equal(stores.items[1]?.attempts, 2);
    assert.equal(stores.items[1]?.status, 'failed');
    assert.match(
      stores.items[1]?.failure_reason ?? '',
      /simulator unavailable/,
    );

    assert.equal(service.retryFailedStores(jobId), 1);
    assert.equal(repository.getJobSummary(jobId)?.status, 'running');
    stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(stores.items[0]?.attempts, 1);
    assert.equal(stores.items[0]?.status, 'enriched');
    assert.equal(stores.items[1]?.attempts, 0);
    assert.equal(stores.items[1]?.status, 'pending');
    assert.equal(stores.items[1]?.failure_reason, null);

    await service.runJob(jobId);

    stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(firstStoreCalls, 1);
    assert.equal(secondStoreCalls, 3);
    assert.equal(repository.getJobSummary(jobId)?.status, 'completed');
    assert.equal(repository.getJobSummary(jobId)?.enriched_stores, 2);
    assert.equal(stores.items[1]?.attempts, 1);
    assert.equal(stores.items[1]?.status, 'enriched');
    assert.equal(stores.items[1]?.failure_reason, null);
    assert.throws(
      () => service.retryFailedStores(jobId),
      /This job has no failed stores to retry/,
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

test('resumes pending stores from the persistent database without repeating completed work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tierforge-resume-'));
  const databasePath = join(directory, 'tierforge.sqlite');
  const secondStore = {
    ...store,
    store_id: 'ST002',
    store_name: 'North Store',
  };
  let connection = new SqliteConnection(databasePath);
  let repository = new TierforgeRepository(connection);
  const jobId = repository.createJob('restart recovery', [store, secondStore]);
  const completedAttempt = repository.startAttempt(jobId, store.store_id);
  assert.ok(completedAttempt !== undefined);
  repository.completeAttempt(jobId, store.store_id, completedAttempt, metrics);
  repository.startAttempt(jobId, secondStore.store_id);
  connection.close();

  try {
    connection = new SqliteConnection(databasePath);
    repository = new TierforgeRepository(connection);
    let calls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          calls += 1;
          return metrics;
        },
      },
      { workerCount: 1, maxAttempts: 3, backoffMs: 0 },
    );

    await service.resumeActiveJobs();

    const summary = repository.getJobSummary(jobId);
    const stores = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(calls, 1);
    assert.equal(summary?.status, 'completed');
    assert.equal(summary?.enriched_stores, 2);
    assert.deepEqual(
      stores.items.map(({ store_id, attempts }) => [store_id, attempts]),
      [
        ['ST001', 1],
        ['ST002', 2],
      ],
    );
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restart recovery does not exceed the persisted attempt limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tierforge-attempt-limit-'));
  const databasePath = join(directory, 'tierforge.sqlite');
  let connection = new SqliteConnection(databasePath);
  let repository = new TierforgeRepository(connection);
  const jobId = repository.createJob('attempt limit recovery', [store]);
  repository.startAttempt(jobId, store.store_id);
  connection.close();

  try {
    connection = new SqliteConnection(databasePath);
    repository = new TierforgeRepository(connection);
    let calls = 0;
    const service = new JobService(
      repository,
      {
        enrich: async () => {
          calls += 1;
          return metrics;
        },
      },
      { workerCount: 1, maxAttempts: 1, backoffMs: 0 },
    );

    await service.resumeActiveJobs();

    const summary = repository.getJobSummary(jobId);
    const result = repository.listStores(jobId, { page: 1, pageSize: 10 });
    assert.equal(calls, 0);
    assert.equal(summary?.status, 'failed');
    assert.equal(result.items[0]?.attempts, 1);
    assert.match(
      result.items[0]?.failure_reason ?? '',
      /Failed after 1 attempts/,
    );
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
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
