export type ApplicationErrorCode =
  | 'INVALID_CSV'
  | 'INVALID_SCORING'
  | 'JOB_NOT_FOUND'
  | 'JOB_ACTIVE'
  | 'NO_FAILED_STORES'
  | 'NO_ENRICHMENT_DATA';

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
