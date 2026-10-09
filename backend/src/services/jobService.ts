import type { EnrichmentMetrics, StoreInput, Tier } from '../lib/db.js';
import { simulatorClient } from '../infrastructure/http/simulatorClient.js';
import type { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import type { WorkItem } from '../repositories/tierforgeRepository.js';
import type { SimulatorInput } from '../infrastructure/http/simulatorClient.js';
import { ApplicationError } from '../lib/applicationError.js';
import { logger } from '../lib/logger.js';
import { parseStoreCsv } from './csvService.js';

export interface EnrichmentGateway {
  enrich(store: SimulatorInput): Promise<EnrichmentMetrics>;
}

export class JobService {
  constructor(
    private readonly repository: TierforgeRepository,
    private readonly enrichment: EnrichmentGateway = simulatorClient,
    private readonly options: {
      workerCount?: number;
      maxAttempts?: number;
      backoffMs?: number;
      maxBackoffMs?: number;
    } = {},
  ) {}

  createJob(name: string, stores: StoreInput[]): number {
    const jobId = this.repository.createJob(name, stores);
    logger.info('job.created', { jobId, totalStores: stores.length });
    return jobId;
  }

  createJobFromCsv(
    fileName: string,
    requestedName: string | undefined,
    source: string,
  ): { jobId: number; totalStores: number } {
    let stores: StoreInput[];
    try {
      stores = parseStoreCsv(source);
    } catch (error) {
      throw new ApplicationError(
        'INVALID_CSV',
        error instanceof Error ? error.message : 'CSV file is invalid.',
      );
    }
    const name =
      requestedName?.trim() ||
      fileName.replace(/\.csv$/i, '') ||
      'Store enrichment';
    return { jobId: this.createJob(name, stores), totalStores: stores.length };
  }

  async runJob(jobId: number): Promise<void> {
    const items = this.repository.listWorkItems(jobId);
    let nextIndex = 0;
    let completedItems = 0;
    const workerCount = Math.min(this.options.workerCount ?? 10, items.length);
    logger.info('job.processing.started', {
      jobId,
      totalStores: items.length,
      workerCount,
    });
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item) {
          await this.processStore(jobId, item);
          completedItems += 1;
          if (completedItems % 100 === 0 || completedItems === items.length) {
            logger.info('job.processing.progress', {
              jobId,
              processedStores: completedItems,
              totalStores: items.length,
            });
          }
        }
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const unexpected = outcomes.find((result) => result.status === 'rejected');
    if (unexpected?.status === 'rejected') {
      const reason =
        unexpected.reason instanceof Error
          ? unexpected.reason.message
          : 'Unexpected job worker failure.';
      logger.error('job.processing.worker_error', { jobId, message: reason });
      this.repository.failPending(jobId, `Job stopped: ${reason}`);
    }
    this.repository.finishJob(jobId);
    const summary = this.repository.getJobSummary(jobId);
    logger.info('job.processing.finished', {
      jobId,
      status: summary?.status ?? 'unknown',
      enrichedStores: summary?.enriched_stores ?? 0,
      failedStores: summary?.failed_stores ?? 0,
    });
  }

  getJob(jobId: number) {
    return this.repository.getJobSummary(jobId);
  }

  listJobs() {
    return this.repository.listJobs();
  }

  listStores(
    jobId: number,
    filters: {
      tier?: Tier;
      status?: 'pending' | 'enriched' | 'failed';
      query?: string;
      page: number;
      pageSize: number;
    },
  ) {
    return this.repository.listStores(jobId, filters);
  }

  getDashboard() {
    return this.repository.latestJobSummary();
  }

  failInterruptedJobs(): void {
    this.repository.failInterruptedJobs();
  }

  failJob(jobId: number, reason: string): void {
    this.repository.failPending(jobId, reason);
    this.repository.finishJob(jobId);
  }

  private async processStore(jobId: number, item: WorkItem): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    let lastError = 'Enrichment failed.';
    let latestAttemptId: number | undefined;
    for (let count = 0; count < maxAttempts; count += 1) {
      const attemptId = this.repository.startAttempt(jobId, item.store_id);
      if (attemptId === undefined) return;
      latestAttemptId = attemptId;
      let metrics: EnrichmentMetrics;
      try {
        metrics = await this.enrichment.enrich({
          store_id: item.store_id,
          store_name: item.store_name,
          address: item.address,
          city: item.city,
          state: item.state,
        });
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : 'Unknown enrichment error.';
        logger.warn('job.store.attempt_failed', {
          jobId,
          storeId: item.store_id,
          attempt: count + 1,
          maxAttempts,
          message: lastError,
        });
        if (count + 1 < maxAttempts) {
          const delay = Math.min(
            (this.options.backoffMs ?? 500) * 2 ** count,
            this.options.maxBackoffMs ?? 8_000,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }
      this.repository.completeAttempt(jobId, item.store_id, attemptId, metrics);
      return;
    }
    if (latestAttemptId !== undefined) {
      const failed = this.repository.failStore(
        jobId,
        item.store_id,
        latestAttemptId,
        `Failed after ${maxAttempts} attempts. Last error: ${lastError}`,
      );
      if (failed) {
        logger.error('job.store.failed', {
          jobId,
          storeId: item.store_id,
          attempts: maxAttempts,
          message: lastError,
        });
      }
    }
  }
}
