import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  ApplicationError,
  type ApplicationErrorCode,
} from '../lib/applicationError.js';
import { ApiError } from '../lib/apiError.js';
import { jobService, scoringService } from '../services/tierforgeServices.js';

const jobIdSchema = z.coerce.number().int().positive();
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  tier: z.enum(['Large', 'Medium', 'Small']).optional(),
  status: z.enum(['pending', 'enriched', 'failed']).optional(),
  q: z.string().trim().max(100).optional(),
});
const applicationErrorStatuses: Record<ApplicationErrorCode, number> = {
  INVALID_CSV: 400,
  INVALID_SCORING: 400,
  JOB_NOT_FOUND: 404,
  JOB_ACTIVE: 409,
  NO_FAILED_STORES: 409,
  NO_ENRICHMENT_DATA: 409,
};

function mapApplicationError(error: unknown): never {
  if (error instanceof ApplicationError) {
    throw new ApiError(
      applicationErrorStatuses[error.code],
      error.code,
      error.message,
      error.details,
    );
  }
  throw error;
}

function parseJobId(value: unknown): number {
  const parsed = jobIdSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'INVALID_JOB_ID',
      'Job ID must be a positive integer.',
    );
  return parsed.data;
}

export const jobsController = {
  list(_request: Request, response: Response): void {
    response.json({ data: { jobs: jobService.listJobs() } });
  },

  create(request: Request, response: Response): void {
    if (!request.file)
      throw new ApiError(
        400,
        'FILE_REQUIRED',
        'Upload a CSV file using the "file" form field.',
      );
    const requestedName =
      typeof request.body.name === 'string' ? request.body.name : undefined;
    let created: { jobId: number; totalStores: number };
    try {
      created = jobService.createJobFromCsv(
        request.file.originalname,
        requestedName,
        request.file.buffer.toString('utf8'),
      );
    } catch (error) {
      mapApplicationError(error);
    }
    const { jobId, totalStores } = created;
    void jobService.runJob(jobId).catch((error: unknown) => {
      console.error(`Job ${jobId} failed unexpectedly:`, error);
      try {
        jobService.failJob(
          jobId,
          'Job stopped because of an unexpected worker failure.',
        );
      } catch (persistenceError) {
        console.error(
          `Could not persist the terminal state for job ${jobId}:`,
          persistenceError,
        );
      }
    });
    response.status(202).json({
      data: { jobId, status: 'running', totalStores },
    });
  },

  get(request: Request, response: Response): void {
    const jobId = parseJobId(request.params['jobId']);
    const job = jobService.getJob(jobId);
    if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
    response.json({ data: { job } });
  },

  retryFailed(request: Request, response: Response): void {
    const jobId = parseJobId(request.params['jobId']);
    let retriedStores: number;
    try {
      retriedStores = jobService.retryFailedStores(jobId);
    } catch (error) {
      mapApplicationError(error);
    }
    void jobService.runJob(jobId).catch((error: unknown) => {
      console.error(`Retry for job ${jobId} failed unexpectedly:`, error);
      try {
        jobService.failJob(
          jobId,
          'Retry stopped because of an unexpected worker failure.',
        );
      } catch (persistenceError) {
        console.error(
          `Could not persist the terminal state for retry of job ${jobId}:`,
          persistenceError,
        );
      }
    });
    response.status(202).json({
      data: {
        job: jobService.getJob(jobId),
        retriedStores,
      },
    });
  },

  stores(request: Request, response: Response): void {
    const jobId = parseJobId(request.params['jobId']);
    if (!jobService.getJob(jobId))
      throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
    const parsed = pageSchema.safeParse({
      page: request.query['page'],
      pageSize: request.query['pageSize'],
      tier: request.query['tier'],
      status: request.query['status'],
      q: request.query['q'],
    });
    if (!parsed.success) {
      throw new ApiError(
        400,
        'INVALID_FILTER',
        'Store result filters are invalid.',
        parsed.error.issues,
      );
    }
    response.json({ data: jobService.listStores(jobId, parsed.data) });
  },

  score(request: Request, response: Response): void {
    const jobId = parseJobId(request.params['jobId']);
    let result: ReturnType<typeof scoringService.scoreJob>;
    try {
      result = scoringService.scoreJob(jobId, request.body);
    } catch (error) {
      mapApplicationError(error);
    }
    response.json({ data: result });
  },
};
