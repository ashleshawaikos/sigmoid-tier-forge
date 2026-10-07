import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { Subject, Subscription, timer } from 'rxjs';
import { debounceTime, exhaustMap, takeWhile } from 'rxjs/operators';

import {
  Job,
  ScoringConfig,
  StoreResult,
  StoreStatus,
  Tier,
  TierforgeApiService,
} from './tierforge-api.service';

type ApiErrorBody = { error?: { message?: string; details?: Array<{ message?: string }> } };

@Component({
  selector: 'app-root',
  standalone: false,
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  readonly title = 'TierForge';
  readonly tiers: Tier[] = ['Large', 'Medium', 'Small'];
  readonly statuses: StoreStatus[] = ['pending', 'enriched', 'failed'];
  readonly pageSize = 25;
  jobs: Job[] = [];
  activeJob: Job | null = null;
  stores: StoreResult[] = [];
  selectedFile: File | null = null;
  selectedJobId: number | null = null;
  selectedTier: Tier | '' = '';
  selectedStatus: StoreStatus | '' = '';
  searchTerm = '';
  currentPage = 1;
  totalStores = 0;
  jobName = '';
  error = '';
  notice = '';
  busy = false;
  jobsLoading = false;
  storesLoading = false;
  scoringBusy = false;
  readonly scoring: ScoringConfig = {
    bars: {
      estimated_monthly_footfall: 15000,
      estimated_monthly_revenue: 150000,
      store_size_sqft: 8000,
    },
    weights: {
      estimated_monthly_footfall: 50,
      estimated_monthly_revenue: 30,
      store_size_sqft: 20,
    },
    thresholds: { Large: 70, Medium: 40 },
  };

  private polling?: Subscription;
  private searchSubscription?: Subscription;
  private readonly searchChanges = new Subject<void>();
  private lastStoreRefreshKey = '';

  constructor(private readonly api: TierforgeApiService) {}

  ngOnInit(): void {
    this.searchSubscription = this.searchChanges.pipe(debounceTime(300)).subscribe(() => {
      this.currentPage = 1;
      this.loadStores();
    });
    this.loadJobs();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.searchSubscription?.unsubscribe();
  }

  @HostListener('window:pagehide')
  stopPolling(): void {
    this.polling?.unsubscribe();
    this.polling = undefined;
  }

  get weightTotal(): number {
    return Object.values(this.scoring.weights).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  get pageCount(): number {
    return Math.max(1, Math.ceil(this.totalStores / this.pageSize));
  }

  get pageLinks(): Array<{ page: number | null; label: string }> {
    const pages = new Set<number>([1, this.pageCount]);
    for (let page = this.currentPage - 1; page <= this.currentPage + 1; page += 1) {
      if (page > 1 && page < this.pageCount) pages.add(page);
    }

    const sortedPages = [...pages].sort((left, right) => left - right);
    const links: Array<{ page: number | null; label: string }> = [];
    let previous = 0;
    for (const page of sortedPages) {
      if (page - previous > 1) links.push({ page: null, label: '…' });
      links.push({ page, label: String(page) });
      previous = page;
    }
    return links;
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedFile = input.files?.[0] ?? null;
    this.jobName = this.selectedFile?.name.replace(/\.csv$/i, '') ?? '';
    this.error = '';
    this.notice = '';
  }

  submitUpload(): void {
    this.error = '';
    this.notice = '';
    if (!this.selectedFile) {
      this.error = 'Choose a CSV file before starting a job.';
      return;
    }
    if (!this.selectedFile.name.toLowerCase().endsWith('.csv')) {
      this.error = 'Choose a CSV file.';
      return;
    }

    this.busy = true;
    this.api.createJob(this.selectedFile, this.jobName.trim() || 'Store enrichment').subscribe({
      next: (created) => {
        this.busy = false;
        this.notice = `Job #${created.jobId} accepted with ${created.totalStores.toLocaleString()} stores.`;
        this.currentPage = 1;
        this.selectedTier = '';
        this.selectedStatus = '';
        this.selectJob(created.jobId);
        this.loadJobs();
      },
      error: (error: unknown) => {
        this.busy = false;
        this.error = this.errorMessage(error, 'Could not start the enrichment job.');
      },
    });
  }

  loadJobs(): void {
    this.jobsLoading = true;
    this.api.listJobs().subscribe({
      next: (jobs) => {
        this.jobsLoading = false;
        this.jobs = jobs;
        if (this.selectedJobId === null && jobs.length) this.selectJob(jobs[0]!.id);
      },
      error: (error: unknown) => {
        this.jobsLoading = false;
        this.error = this.errorMessage(
          error,
          'Could not connect to the backend. Confirm it is running on port 4000.',
        );
      },
    });
  }

  selectJob(jobId: number): void {
    this.selectedJobId = jobId;
    this.activeJob = null;
    this.stores = [];
    this.totalStores = 0;
    this.currentPage = 1;
    this.lastStoreRefreshKey = '';
    this.polling?.unsubscribe();
    this.polling = timer(0, 4000)
      .pipe(
        exhaustMap(() => this.api.getJob(jobId)),
        takeWhile((job) => job.status === 'running' || job.status === 'queued', true),
      )
      .subscribe({
        next: (job) => {
          this.activeJob = job;
          this.updateListedJob(job);
          const refreshKey = this.getStoreRefreshKey(job);
          if (refreshKey !== this.lastStoreRefreshKey) {
            this.lastStoreRefreshKey = refreshKey;
            this.loadStores();
          }
          if (job.status === 'completed' || job.status === 'failed') {
            this.loadJobs();
          }
        },
        error: (error: unknown) => {
          this.error = this.errorMessage(error, `Could not load job #${jobId}.`);
          this.polling?.unsubscribe();
        },
      });
  }

  setTierFilter(tier: unknown): void {
    this.selectedTier =
      typeof tier === 'string' ? (this.tiers.find((candidate) => candidate === tier) ?? '') : '';
    this.currentPage = 1;
    this.loadStores();
  }

  setStatusFilter(status: unknown): void {
    this.selectedStatus =
      typeof status === 'string'
        ? (this.statuses.find((candidate) => candidate === status) ?? '')
        : '';
    this.currentPage = 1;
    this.loadStores();
  }

  searchStores(): void {
    this.searchChanges.next();
  }

  changePage(page: number): void {
    this.currentPage = Math.max(1, Math.min(this.pageCount, page));
    this.loadStores();
  }

  runScoring(): void {
    if (
      !this.activeJob ||
      this.activeJob.status === 'running' ||
      this.activeJob.status === 'queued'
    ) {
      this.error = 'Scoring is available after enrichment finishes.';
      return;
    }
    if (
      !Object.values(this.scoring.bars).every((value) => Number.isFinite(value) && value >= 0) ||
      !Object.values(this.scoring.weights).every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      ) ||
      Math.abs(this.weightTotal - 100) > 0.001
    ) {
      this.error =
        'Metric bars must be non-negative and weights must be between 0 and 100%, totaling 100%.';
      return;
    }
    if (
      this.scoring.thresholds.Large <= this.scoring.thresholds.Medium ||
      this.scoring.thresholds.Large > 100 ||
      this.scoring.thresholds.Medium < 0
    ) {
      this.error = 'Tier thresholds must be between 0 and 100, with Large higher than Medium.';
      return;
    }

    this.error = '';
    this.notice = '';
    this.scoringBusy = true;
    const jobId = this.activeJob.id;
    this.api.scoreJob(jobId, this.scoring).subscribe({
      next: (result) => {
        this.scoringBusy = false;
        this.notice = `Scoring complete for ${result.scoredStores.toLocaleString()} enriched stores.`;
        this.loadJobSnapshot(jobId);
      },
      error: (error: unknown) => {
        this.scoringBusy = false;
        this.error = this.errorMessage(error, 'Could not score this job.');
      },
    });
  }

  private loadJobSnapshot(jobId: number): void {
    this.api.getJob(jobId).subscribe({
      next: (job) => {
        this.activeJob = job;
        this.loadStores();
      },
      error: (error: unknown) => {
        this.error = this.errorMessage(error, 'Could not refresh the job summary.');
      },
    });
  }

  private updateListedJob(job: Job): void {
    this.jobs = this.jobs.map((listedJob) => (listedJob.id === job.id ? job : listedJob));
  }

  private getStoreRefreshKey(job: Job): string {
    return JSON.stringify({
      jobId: job.id,
      status: job.status,
      enriched: job.enriched_stores,
      failed: job.failed_stores,
      pending: job.pending_stores,
      tiers: job.tier_breakdown,
      tier: this.selectedTier,
      storeStatus: this.selectedStatus,
      query: this.searchTerm.trim(),
      page: this.currentPage,
    });
  }

  private loadStores(): void {
    if (this.selectedJobId === null) return;
    if (this.activeJob) this.lastStoreRefreshKey = this.getStoreRefreshKey(this.activeJob);
    this.storesLoading = true;
    this.api
      .getStores(this.selectedJobId, {
        tier: this.selectedTier || undefined,
        status: this.selectedStatus || undefined,
        query: this.searchTerm.trim() || undefined,
        page: this.currentPage,
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (page) => {
          this.storesLoading = false;
          this.stores = page.items;
          this.totalStores = page.total;
        },
        error: (error: unknown) => {
          this.storesLoading = false;
          this.error = this.errorMessage(error, 'Could not load stores for this job.');
        },
      });
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as ApiErrorBody;
      const validation = body?.error?.details
        ?.map((item) => item.message)
        .filter(Boolean)
        .join(' ');
      return validation || body?.error?.message || fallback;
    }
    return fallback;
  }
}
