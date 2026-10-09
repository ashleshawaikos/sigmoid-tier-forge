import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { TierforgeApiService } from './tierforge-api.service';

describe('TierforgeApiService', () => {
  let api: TierforgeApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    api = TestBed.inject(TierforgeApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify());

  it('unwraps API job data', () => {
    let jobCount = -1;
    api.listJobs().subscribe((jobs) => (jobCount = jobs.length));
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [{ id: 7 }] } });
    expect(jobCount).toBe(1);
  });

  it('uploads a CSV as multipart form data and unwraps the created job', () => {
    const file = new File(['store_id,store_name'], 'stores.csv', { type: 'text/csv' });
    let createdId = 0;
    api.createJob(file, 'sample stores').subscribe((created) => (createdId = created.jobId));
    const request = httpTesting.expectOne('http://localhost:4000/api/jobs');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.get('file')).toBe(file);
    expect(request.request.body.get('name')).toBe('sample stores');
    request.flush({ data: { jobId: 8, status: 'running', totalStores: 1 } });
    expect(createdId).toBe(8);
  });

  it('sends status and tier filtering with pagination to the API', () => {
    api
      .getStores(7, { tier: 'Large', status: 'failed', page: 2, pageSize: 25 })
      .subscribe((page) => expect(page.total).toBe(0));
    const request = httpTesting.expectOne(
      (candidate) => candidate.url === 'http://localhost:4000/api/jobs/7/stores',
    );
    expect(request.request.params.get('tier')).toBe('Large');
    expect(request.request.params.get('status')).toBe('failed');
    expect(request.request.params.has('q')).toBe(false);
    expect(request.request.params.get('page')).toBe('2');
    request.flush({ data: { items: [], total: 0, page: 2, pageSize: 25 } });
  });

  it('requests a retry of failed stores and unwraps the updated job', () => {
    let retriedStores = 0;
    api.retryFailedStores(7).subscribe((result) => {
      retriedStores = result.retriedStores;
      expect(result.job.status).toBe('running');
    });
    const request = httpTesting.expectOne('http://localhost:4000/api/jobs/7/retry-failed');
    expect(request.request.method).toBe('POST');
    request.flush({
      data: {
        job: {
          id: 7,
          name: 'Retry test',
          status: 'running',
          total_stores: 2,
          enriched_stores: 1,
          failed_stores: 0,
          pending_stores: 1,
          tier_breakdown: { Large: 1, Medium: 0, Small: 0 },
        },
        retriedStores: 1,
      },
    });
    expect(retriedStores).toBe(1);
  });
});
