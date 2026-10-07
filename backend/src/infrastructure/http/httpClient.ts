export type HttpResponse<T> = { status: number; body: T };

export class HttpClient {
  constructor(
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async postJson<TRequest, TResponse>(
    url: string,
    body: TRequest,
    timeoutMs: number,
  ): Promise<HttpResponse<TResponse>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseBody = (await response
        .json()
        .catch(() => null)) as TResponse;
      return { status: response.status, body: responseBody };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Enrichment request timed out after ${timeoutMs / 1000} seconds.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
