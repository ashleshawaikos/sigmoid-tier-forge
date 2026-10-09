import type { EnrichmentMetrics, StoreInput, Tier } from '../lib/db.js';
import {
  EnrichmentCircuitBreaker,
  type CircuitBreakerPermit,
} from '../infrastructure/resilience/enrichmentCircuitBreaker.js';
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
      leaseMs?: number;
      leasePollMs?: number;
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
    const maxAttempts = this.options.maxAttempts ?? 5;
    const leaseMs = this.options.leaseMs ?? 30_000;
    const workerCount = Math.min(
      this.options.workerCount ?? 10,
      Math.max(1, this.repository.getJob(jobId)?.total_stores ?? 1),
    );
    let circuitBreakerBlocked = false;
    logger.info('job.processing.started', {
      jobId,
      totalStores: this.repository.getJob(jobId)?.total_stores ?? 0,
      workerCount,
    });
    const workers = Array.from({ length: workerCount }, async () => {
      while (!circuitBreakerBlocked) {
        const permit = this.circuitBreaker.acquirePermit();
        if (!permit) {
          if (this.circuitBreaker.getState() === 'half-open') {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, this.options.leasePollMs ?? 25),
            );
            continue;
          }
          circuitBreakerBlocked = true;
          return;
        }

        let item: WorkItem | undefined;
        try {
          item = this.repository.claimWorkItem(jobId, maxAttempts, leaseMs);
        } catch (error) {
          this.circuitBreaker.recordIgnoredFailure(permit);
          throw error;
        }
        if (!item) {
          this.circuitBreaker.recordIgnoredFailure(permit);
          if (!this.repository.hasPendingWork(jobId)) return;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.options.leasePollMs ?? 25),
          );
          continue;
        }
        const processed = await this.processStore(
          jobId,
          item,
          maxAttempts,
          permit,
        );
        if (!processed) {
          circuitBreakerBlocked = true;
          return;
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
    maxAttempts: number,
    permit: CircuitBreakerPermit,
  ): Promise<boolean> {
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
      const message =
        error instanceof Error ? error.message : 'Unknown enrichment error.';
      logger.warn('job.store.attempt_failed', {
        jobId,
        storeId: item.store_id,
        attempt: item.attempt_count,
        maxAttempts,
        message,
      });
      if (breakerOpened) {
        logger.error('job.circuit_breaker.opened', {
          jobId,
          state: this.circuitBreaker.getState(),
        });
      }
      if (!retryable) {
        const reason = `Permanent enrichment failure: ${message}`;
        const failed = this.repository.failStore(
          jobId,
          item.store_id,
          item.attempt_id,
          reason,
          'permanent_failure',
        );
        if (failed) {
          logger.error('job.store.failed', {
            jobId,
            storeId: item.store_id,
            attempts: item.attempt_count,
            permanentFailure: true,
            message,
          });
        }
        return true;
      }
      if (this.circuitBreaker.getState() === 'open') {
        this.repository.failStore(
          jobId,
          item.store_id,
          item.attempt_id,
          `Enrichment service circuit breaker opened. Last error: ${message}`,
        );
        return false;
      }
      if (item.attempt_count >= maxAttempts) {
        const reason = `Failed after ${maxAttempts} attempts. Last error: ${message}`;
        const failed = this.repository.failStore(
          jobId,
          item.store_id,
          item.attempt_id,
          reason,
          'retry_exhausted',
        );
        if (failed) {
          logger.error('job.store.failed', {
            jobId,
            storeId: item.store_id,
            attempts: item.attempt_count,
            message,
          });
        }
        return true;
      }

      const delay = Math.min(
        (this.options.backoffMs ?? 500) * 2 ** (item.attempt_count - 1),
        this.options.maxBackoffMs ?? 8_000,
      );
      this.repository.deferAttempt(
        jobId,
        item.store_id,
        item.attempt_id,
        message,
        delay,
      );
      return true;
    }

    this.circuitBreaker.recordSuccess(permit);
    const completed = this.repository.completeAttempt(
      jobId,
      item.store_id,
      item.attempt_id,
      metrics,
    );
    if (!completed) {
      logger.warn('job.store.stale_result_discarded', {
        jobId,
        storeId: item.store_id,
        attemptId: item.attempt_id,
      });
    }
    return true;
  }
}
