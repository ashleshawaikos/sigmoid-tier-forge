import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AppModule } from './app-module';
import { App } from './app';

describe('App', () => {
  let httpTesting: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppModule, HttpClientTestingModule],
    }).compileComponents();
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify());

  it('loads jobs and displays the empty dashboard state', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.loading-spinner')).not.toBeNull();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toContain('TierForge');
    expect(element.textContent).toContain('No enrichment jobs yet');
  });

  it('shows a loader while scores and tier breakdown are being computed', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });

    fixture.componentInstance.activeJob = {
      id: 1,
      name: 'Scoring job',
      status: 'completed',
      total_stores: 1,
      enriched_stores: 1,
      failed_stores: 0,
      pending_stores: 0,
      tier_breakdown: { Large: 0, Medium: 0, Small: 0 },
    };
    fixture.componentInstance.scoringBusy = true;
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Recomputing scores and tier breakdown');
    expect(element.querySelector('.loading-message .loading-spinner')).not.toBeNull();
    expect(element.querySelector('.score-btn .loading-spinner')).not.toBeNull();
    fixture.destroy();
  });

  it('refreshes the view when existing jobs arrive asynchronously', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.selectedJobId = 42;
    fixture.detectChanges();

    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({
      data: {
        jobs: [
          {
            id: 7,
            name: 'Existing stores',
            status: 'completed',
            total_stores: 1,
            enriched_stores: 1,
            failed_stores: 0,
            pending_stores: 0,
            tier_breakdown: { Large: 1, Medium: 0, Small: 0 },
          },
        ],
      },
    });
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Existing stores');
    fixture.destroy();
  });

  it('shows all persisted jobs with their status and progress', () => {
    const fixture = TestBed.createComponent(App);
    fixture.componentInstance.selectedJobId = 42;
    fixture.detectChanges();

    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({
      data: {
        jobs: [
          {
            id: 7,
            name: 'Completed upload',
            status: 'completed',
            total_stores: 4,
            enriched_stores: 4,
            failed_stores: 0,
            pending_stores: 0,
            tier_breakdown: { Large: 2, Medium: 1, Small: 1 },
          },
          {
            id: 8,
            name: 'Resumed upload',
            status: 'running',
            total_stores: 10,
            enriched_stores: 3,
            failed_stores: 1,
            pending_stores: 6,
            tier_breakdown: { Large: 0, Medium: 0, Small: 0 },
          },
        ],
      },
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Completed upload');
    expect(element.textContent).toContain('completed');
    expect(element.textContent).toContain('Resumed upload');
    expect(element.textContent).toContain('running');
    expect(element.textContent).toContain('3 / 10');
    expect(element.textContent).toContain('6');
    fixture.destroy();
  });

  it('loads store details for a completed startup job without polling its status', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({
      data: {
        jobs: [
          {
            id: 7,
            name: 'Completed upload',
            status: 'completed',
            total_stores: 1,
            enriched_stores: 1,
            failed_stores: 0,
            pending_stores: 0,
            tier_breakdown: { Large: 1, Medium: 0, Small: 0 },
          },
        ],
      },
    });
    const storesRequest = httpTesting.expectOne(
      'http://localhost:4000/api/jobs/7/stores?page=1&pageSize=25',
    );
    storesRequest.flush({ data: { items: [], total: 0, page: 1, pageSize: 25 } });
    fixture.detectChanges();

    expect(httpTesting.match('http://localhost:4000/api/jobs/7')).toHaveLength(0);
    expect(fixture.componentInstance.activeJob?.status).toBe('completed');
    fixture.destroy();
  });

  it('shows Data Not Available and hides scoring when all stores failed', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({
      data: {
        jobs: [
          {
            id: 9,
            name: 'Unavailable data',
            status: 'failed',
            total_stores: 1,
            enriched_stores: 0,
            failed_stores: 1,
            pending_stores: 0,
            tier_breakdown: { Large: 0, Medium: 0, Small: 0 },
          },
        ],
      },
    });
    httpTesting.expectOne('http://localhost:4000/api/jobs/9/stores?page=1&pageSize=25').flush({
      data: {
        items: [
          {
            store_id: 'ST009',
            store_name: 'Unavailable Store',
            address: '1 Main',
            city: 'Delhi',
            state: 'Delhi',
            country: 'India',
            status: 'failed',
            attempts: 5,
            estimated_monthly_footfall: null,
            estimated_monthly_revenue: null,
            store_size_sqft: null,
            failure_reason: 'Simulator unavailable',
            score: null,
            tier: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      },
    });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Data Not Available');
    expect(text).toContain('Simulator unavailable');
    expect(text).not.toContain('Scoring configuration');
    expect((fixture.nativeElement as HTMLElement).querySelector('input[type="search"]')).toBeNull();
    fixture.destroy();
  });

  it('shows validation feedback when upload is submitted without a file', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });
    fixture.componentInstance.submitUpload();
    fixture.detectChanges();

    expect(fixture.componentInstance.error).toBe('Choose a CSV file before starting a job.');
  });

  it('clears the selected file and restores the upload button after acceptance', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });

    const app = fixture.componentInstance;
    app.selectedFile = new File(['store_id'], 'stores.csv', { type: 'text/csv' });
    app.jobName = 'Test upload';
    fixture.detectChanges();
    app.submitUpload();
    expect(app.busy).toBe(true);

    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({
      data: { jobId: 12, status: 'running', totalStores: 1 },
    });
    fixture.detectChanges();

    expect(app.busy).toBe(false);
    expect(app.selectedFile).toBeNull();
    expect(app.jobName).toBe('');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Start enrichment');
    expect((fixture.nativeElement.querySelector('.job-name') as HTMLInputElement).value).toBe('');
    expect(
      (fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement).value,
    ).toBe('');

    await new Promise((resolve) => setTimeout(resolve, 0));
    httpTesting.expectOne('http://localhost:4000/api/jobs/12').flush({
      data: {
        job: {
          id: 12,
          name: 'Store enrichment',
          status: 'completed',
          total_stores: 1,
          enriched_stores: 1,
          failed_stores: 0,
          pending_stores: 0,
          tier_breakdown: { Large: 0, Medium: 0, Small: 0 },
        },
      },
    });
    httpTesting.expectOne('http://localhost:4000/api/jobs/12/stores?page=1&pageSize=25').flush({
      data: { items: [], total: 0, page: 1, pageSize: 25 },
    });
    for (const request of httpTesting.match('http://localhost:4000/api/jobs')) {
      request.flush({ data: { jobs: [] } });
    }
    fixture.destroy();
  });

  it('cancels the active status poll when the page is being hidden for refresh', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });

    fixture.componentInstance.selectJob(42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTesting.expectOne('http://localhost:4000/api/jobs/42');
    window.dispatchEvent(new Event('pagehide'));

    expect(request.cancelled).toBe(true);
    fixture.destroy();
    httpTesting.verify({ ignoreCancelled: true });
  });

  it('provides page links to the first, nearby, and last result pages', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.totalStores = 5000;
    app.currentPage = 42;

    expect(app.pageCount).toBe(200);
    expect(app.pageLinks).toEqual([
      { page: 1, label: '1' },
      { page: null, label: '…' },
      { page: 41, label: '41' },
      { page: 42, label: '42' },
      { page: 43, label: '43' },
      { page: null, label: '…' },
      { page: 200, label: '200' },
    ]);
    fixture.destroy();
  });
});
