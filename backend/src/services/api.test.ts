import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

test('API supports upload, job progress, scoring, dashboard, and store results', async (context) => {
  process.env['DATABASE_PATH'] = ':memory:';
  const simulator = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        store_id: 'ST001',
        estimated_monthly_footfall: 20000,
        estimated_monthly_revenue: 180000,
        store_size_sqft: 9000,
      }),
    );
  });
  await new Promise<void>((resolve) =>
    simulator.listen(0, '127.0.0.1', resolve),
  );
  const simulatorAddress = simulator.address();
  assert.ok(simulatorAddress && typeof simulatorAddress !== 'string');
  process.env['SIMULATOR_BASE_URL'] =
    `http://127.0.0.1:${simulatorAddress.port}`;
  const { default: app } = await import('../app.js');
  const server = app.listen(0);
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          simulator.close();
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { data: { status: 'ok' } });

  const jobs = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.headers.get('cache-control'), 'no-store');
  assert.equal(jobs.headers.get('etag'), null);
  assert.deepEqual(await jobs.json(), { data: { jobs: [] } });

  const refreshedJobs = await fetch(`${baseUrl}/api/jobs`, {
    headers: { 'If-None-Match': '"cached-jobs"' },
  });
  assert.equal(refreshedJobs.status, 200);
  assert.deepEqual(await refreshedJobs.json(), { data: { jobs: [] } });

  const invalid = await fetch(`${baseUrl}/api/jobs/invalid`);
  assert.equal(invalid.status, 400);
  const invalidBody = (await invalid.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(invalidBody.error.code, 'INVALID_JOB_ID');
  assert.match(invalidBody.error.message, /positive integer/);

  const invalidForm = new FormData();
  invalidForm.append('file', new Blob(['not,a,valid,header']), 'invalid.csv');
  const invalidUpload = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    body: invalidForm,
  });
  assert.equal(invalidUpload.status, 400);
  const invalidUploadBody = (await invalidUpload.json()) as {
    error: { code: string };
  };
  assert.equal(invalidUploadBody.error.code, 'INVALID_CSV');

  const form = new FormData();
  form.append(
    'file',
    new Blob([
      'store_id,store_name,address,city,state,country\nST001,Test Store,1 Main,Delhi,Delhi,India',
    ]),
    'stores.csv',
  );
  const accepted = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    body: form,
  });
  assert.equal(accepted.status, 202);
  const acceptedBody = (await accepted.json()) as {
    data: { jobId: number; totalStores: number };
  };
  const jobId = acceptedBody.data.jobId;
  assert.equal(acceptedBody.data.totalStores, 1);

  let jobStatus = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    const body = (await response.json()) as {
      data: { job: { status: string } };
    };
    jobStatus = body.data.job.status;
    if (jobStatus === 'completed' || jobStatus === 'failed') break;
  }
  assert.equal(jobStatus, 'completed');

  const scoring = {
    bars: {
      estimated_monthly_footfall: 10000,
      estimated_monthly_revenue: 100000,
      store_size_sqft: 5000,
    },
    weights: {
      estimated_monthly_footfall: 50,
      estimated_monthly_revenue: 30,
      store_size_sqft: 20,
    },
    thresholds: { Large: 70, Medium: 40 },
  };
  const scored = await fetch(`${baseUrl}/api/jobs/${jobId}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scoring),
  });
  assert.equal(scored.status, 200);
  const scoredBody = (await scored.json()) as {
    data: { scoredStores: number; tierBreakdown: { Large: number } };
  };
  assert.equal(scoredBody.data.scoredStores, 1);
  assert.equal(scoredBody.data.tierBreakdown.Large, 1);

  const stores = await fetch(
    `${baseUrl}/api/jobs/${jobId}/stores?page=1&pageSize=1&tier=Large`,
  );
  const storesBody = (await stores.json()) as {
    data: { items: Array<{ store_id: string; tier: string }>; total: number };
  };
  assert.equal(storesBody.data.items[0]?.store_id, 'ST001');
  assert.equal(storesBody.data.items[0]?.tier, 'Large');
  assert.equal(storesBody.data.total, 1);

  const dashboard = await fetch(`${baseUrl}/api/dashboard`);
  const dashboardBody = (await dashboard.json()) as {
    data: { latestJob: { id: number } };
  };
  assert.equal(dashboardBody.data.latestJob.id, jobId);

  const missingEndpoint = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(missingEndpoint.status, 404);
  assert.deepEqual(await missingEndpoint.json(), {
    error: { code: 'NOT_FOUND', message: 'API endpoint not found.' },
  });
});
