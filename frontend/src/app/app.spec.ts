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
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toContain('TierForge');
    expect(element.textContent).toContain('No enrichment jobs yet');
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

  it('shows validation feedback when upload is submitted without a file', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    httpTesting.expectOne('http://localhost:4000/api/jobs').flush({ data: { jobs: [] } });
    fixture.componentInstance.submitUpload();
    fixture.detectChanges();

    expect(fixture.componentInstance.error).toBe('Choose a CSV file before starting a job.');
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
