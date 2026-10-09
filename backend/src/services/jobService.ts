import type { EnrichmentMetrics, StoreInput, Tier } from '../lib/db.js';
import { EnrichmentCircuitBreaker } from '../infrastructure/resilience/enrichmentCircuitBreaker.js';
import { simulatorClient } from '../infrastructure/http/simulatorClient.js';
import type { TierforgeRepository } from '../repositories/tierforgeRepository.js';
import type { WorkItem } from '../repositories/tierforgeRepository.js';
import type { SimulatorInput } from '../infrastructure/http/simulatorClient.js';
import { isRetryableEnrichmentError } from '../infrastructure/http/enrichmentError.js';
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
    private readonly circuitBreaker = new EnrichmentCircuitBreaker(),
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
    let circuitBreakerBlocked = false;
    let completedItems = 0;
    const workerCount = Math.min(this.options.workerCount ?? 10, items.length);
    logger.info('job.processing.started', {
      jobId,
      totalStores: items.length,
      workerCount,
    });
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length && !circuitBreakerBlocked) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item) {
          const processed = await this.processStore(jobId, item);
          if (!processed) {
            circuitBreakerBlocked = true;
            return;
          }
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
    if (circuitBreakerBlocked) {
      this.repository.failPending(
        jobId,
        `Enrichment service circuit breaker is ${this.circuitBreaker.getState()}. Remaining stores were not attempted.`,
      );
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

  retryFailedStores(jobId: number): number {
    const result = this.repository.retryFailedStores(jobId);
    if (result.status === 'missing')
      throw new ApplicationError('JOB_NOT_FOUND', 'Job not found.');
    if (result.status === 'active')
      throw new ApplicationError(
        'JOB_ACTIVE',
        'Wait for the current enrichment run to finish before retrying failed stores.',
      );
    if (result.status === 'none')
      throw new ApplicationError(
        'NO_FAILED_STORES',
        'This job has no failed stores to retry.',
      );

    logger.info('job.failed_stores.retry_started', {
      jobId,
      retriedStores: result.count,
    });
    return result.count;
  }

  async resumeActiveJobs(): Promise<void> {
    const jobIds = this.repository.listActiveJobIds();
    if (jobIds.length === 0) return;

    logger.info('job.recovery.started', { jobIds: jobIds.join(',') });
    await Promise.all(
      jobIds.map(async (jobId) => {
        try {
          await this.runJob(jobId);
        } catch (error) {
          logger.error('job.recovery.failed', {
            jobId,
            message:
              error instanceof Error
                ? error.message
                : 'Unknown job recovery error.',
          });
        }
      }),
    );
  }

  failJob(jobId: number, reason: string): void {
    this.repository.failPending(jobId, reason);
    this.repository.finishJob(jobId);
  }

  private async processStore(
    jobId: number,
    item: WorkItem,
  ): Promise<boolean> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    let permanentFailure = false;
    let lastError =
      item.attempt_count >= maxAttempts
        ? 'Backend restarted before the final attempt completed.'
        : 'Enrichment failed.';
    let attemptsMade = item.attempt_count;
    let latestAttemptId: number | undefined =
      item.attempt_id > 0 ? item.attempt_id : undefined;
    let blockedByCircuitBreaker = false;
    for (let count = item.attempt_count; count < maxAttempts; count += 1) {
      const permit = this.circuitBreaker.acquirePermit();
      if (!permit) {
        if (latestAttemptId === undefined) return false;
        blockedByCircuitBreaker = true;
        break;
      }
      const attemptId = this.repository.startAttempt(jobId, item.store_id);
      if (attemptId === undefined) {
        this.circuitBreaker.recordIgnoredFailure(permit);
        return true;
      }
      attemptsMade += 1;
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
        const retryable = isRetryableEnrichmentError(error);
        let breakerOpened = false;
        if (retryable) breakerOpened = this.circuitBreaker.recordFailure(permit);
        else this.circuitBreaker.recordIgnoredFailure(permit);
        lastError =
          error instanceof Error ? error.message : 'Unknown enrichment error.';
        logger.warn('job.store.attempt_failed', {
          jobId,
          storeId: item.store_id,
          attempt: attemptsMade,
          maxAttempts,
          message: lastError,
        });
        if (breakerOpened)
          logger.error('job.circuit_breaker.opened', {
            jobId,
            state: this.circuitBreaker.getState(),
          });
        if (!retryable) {
          permanentFailure = true;
          break;
        }
        if (this.circuitBreaker.getState() === 'open') {
          blockedByCircuitBreaker = true;
          break;
        }
        if (count + 1 < maxAttempts) {
          const delay = Math.min(
            (this.options.backoffMs ?? 500) * 2 ** count,
            this.options.maxBackoffMs ?? 8_000,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }
      this.circuitBreaker.recordSuccess(permit);
      this.repository.completeAttempt(jobId, item.store_id, attemptId, metrics);
      return true;
    }
    if (latestAttemptId !== undefined) {
      let failureReason: string;
      if (permanentFailure) {
        failureReason = `Permanent enrichment failure: ${lastError}`;
      } else if (blockedByCircuitBreaker) {
        failureReason = `Enrichment service circuit breaker is ${this.circuitBreaker.getState()}. Last error: ${lastError}`;
      } else {
        failureReason = `Failed after ${maxAttempts} attempts. Last error: ${lastError}`;
      }
      const failed = this.repository.failStore(
        jobId,
        item.store_id,
        latestAttemptId,
        failureReason,
      );
      if (failed) {
        logger.error('job.store.failed', {
          jobId,
          storeId: item.store_id,
          attempts: attemptsMade,
          permanentFailure,
          message: lastError,
        });
      }
    }
    return !blockedByCircuitBreaker;
  }
}
