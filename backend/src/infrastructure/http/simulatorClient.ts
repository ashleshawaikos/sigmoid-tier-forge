import { z } from 'zod';

import { config } from '../../config.js';
import type { EnrichmentMetrics, StoreInput } from '../../lib/db.js';
import { EnrichmentError } from './enrichmentError.js';
import { HttpClient } from './httpClient.js';

const responseSchema = z.object({
  store_id: z.string(),
  estimated_monthly_footfall: z.number().finite().nonnegative(),
  estimated_monthly_revenue: z.number().finite().nonnegative(),
  store_size_sqft: z.number().finite().nonnegative(),
});

export type SimulatorInput = Pick<
  StoreInput,
  'store_id' | 'store_name' | 'address' | 'city' | 'state'
>;

export class SimulatorClient {
  private nextStartAt = 0;

  constructor(
    private readonly http: HttpClient = new HttpClient(),
    private readonly minimumIntervalMs = 210,
    private readonly timeoutMs = 12_000,
  ) {}

  async enrich(store: SimulatorInput): Promise<EnrichmentMetrics> {
    await this.waitForTurn();
    let response;
    try {
      response = await this.http.postJson<SimulatorInput, unknown>(
        `${config.simulatorBaseUrl}/enrich`,
        store,
        this.timeoutMs,
      );
    } catch (error) {
      throw new EnrichmentError(
        error instanceof Error ? error.message : 'Enrichment request failed.',
        true,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      throw new EnrichmentError(
        `Enrichment API returned HTTP ${response.status}.`,
        retryable,
      );
    }
    const parsed = responseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.store_id !== store.store_id) {
      throw new EnrichmentError(
        'Enrichment API returned an invalid response.',
        false,
      );
    }
    return {
      estimated_monthly_footfall: parsed.data.estimated_monthly_footfall,
      estimated_monthly_revenue: parsed.data.estimated_monthly_revenue,
      store_size_sqft: parsed.data.store_size_sqft,
    };
  }

  private async waitForTurn(): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = scheduledAt + this.minimumIntervalMs;
    const delay = scheduledAt - now;
    if (delay > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

export const simulatorClient = new SimulatorClient();
