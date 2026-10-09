import assert from 'node:assert/strict';
import test from 'node:test';

import { EnrichmentError } from './enrichmentError.js';
import { HttpClient } from './httpClient.js';
import { SimulatorClient } from './simulatorClient.js';

test('aborts requests that exceed their timeout', async () => {
  const http = new HttpClient(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );

  await assert.rejects(
    http.postJson('http://example.test', {}, 5),
    /timed out after 0.005 seconds/,
  );
});

test('serializes outbound calls by the configured minimum interval', async () => {
  const startedAt: number[] = [];
  const http = new HttpClient(async () => {
    startedAt.push(Date.now());
    return new Response(
      JSON.stringify({
        store_id: 'ST001',
        estimated_monthly_footfall: 1,
        estimated_monthly_revenue: 2,
        store_size_sqft: 3,
      }),
      { status: 200 },
    );
  });
  const client = new SimulatorClient(http, 15, 1000);
  const input = {
    store_id: 'ST001',
    store_name: 'A',
    address: '1 Main',
    city: 'Delhi',
    state: 'Delhi',
  };

  await Promise.all([client.enrich(input), client.enrich(input)]);

  assert.equal(startedAt.length, 2);
  assert.ok(startedAt[1]! - startedAt[0]! >= 10);
});

test('classifies client errors as permanent and rate limits/server failures as retryable', async () => {
  const input = {
    store_id: 'ST001',
    store_name: 'A',
    address: '1 Main',
    city: 'Delhi',
    state: 'Delhi',
  };

  for (const [status, retryable] of [
    [400, false],
    [429, true],
    [500, true],
  ] as const) {
    const client = new SimulatorClient(
      new HttpClient(async () => new Response('{}', { status })),
      0,
      1000,
    );
    await assert.rejects(client.enrich(input), (error: unknown) => {
      assert.ok(error instanceof EnrichmentError);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});
