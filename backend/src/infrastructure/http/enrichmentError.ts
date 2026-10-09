export class EnrichmentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export function isRetryableEnrichmentError(error: unknown): boolean {
  return !(error instanceof EnrichmentError) || error.retryable;
}
