import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type Tier = 'Large' | 'Medium' | 'Small';
export type StoreStatus = 'pending' | 'enriched' | 'failed';
export type TierCounts = Record<Tier, number>;
type ApiResponse<T> = { data: T };

export type Job = {
  id: number;
  name: string;
  status: JobStatus;
  total_stores: number;
  enriched_stores: number;
  failed_stores: number;
  pending_stores: number;
  tier_breakdown: TierCounts;
};

export type StoreResult = {
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  status: StoreStatus;
  attempts: number;
  estimated_monthly_footfall: number | null;
  estimated_monthly_revenue: number | null;
  store_size_sqft: number | null;
  failure_reason: string | null;
  score: number | null;
  tier: Tier | null;
};

export type StorePage = {
  items: StoreResult[];
  total: number;
  page: number;
  pageSize: number;
};

export type ScoringConfig = {
  bars: {
    estimated_monthly_footfall: number;
    estimated_monthly_revenue: number;
    store_size_sqft: number;
  };
  weights: {
    estimated_monthly_footfall: number;
    estimated_monthly_revenue: number;
    store_size_sqft: number;
  };
  thresholds: {
    Large: number;
    Medium: number;
  };
};

@Injectable({ providedIn: 'root' })
export class TierforgeApiService {
  private readonly baseUrl = 'http://localhost:4000/api';

  constructor(private readonly http: HttpClient) {}

  listJobs(): Observable<Job[]> {
    return this.http
      .get<ApiResponse<{ jobs: Job[] }>>(`${this.baseUrl}/jobs`)
      .pipe(map(({ data }) => data.jobs));
  }

  createJob(
    file: File,
    name: string,
  ): Observable<{ jobId: number; status: JobStatus; totalStores: number }> {
    const form = new FormData();
    form.set('file', file);
    form.set('name', name);
    return this.http
      .post<ApiResponse<{ jobId: number; status: JobStatus; totalStores: number }>>(
        `${this.baseUrl}/jobs`,
        form,
      )
      .pipe(map(({ data }) => data));
  }

  getJob(jobId: number): Observable<Job> {
    return this.http
      .get<ApiResponse<{ job: Job }>>(`${this.baseUrl}/jobs/${jobId}`)
      .pipe(map(({ data }) => data.job));
  }

  getStores(
    jobId: number,
    filters: { tier?: Tier; status?: StoreStatus; query?: string; page: number; pageSize: number },
  ): Observable<StorePage> {
    let params = new HttpParams().set('page', filters.page).set('pageSize', filters.pageSize);
    if (filters.tier) params = params.set('tier', filters.tier);
    if (filters.status) params = params.set('status', filters.status);
    if (filters.query) params = params.set('q', filters.query);
    return this.http
      .get<ApiResponse<StorePage>>(`${this.baseUrl}/jobs/${jobId}/stores`, { params })
      .pipe(map(({ data }) => data));
  }

  scoreJob(
    jobId: number,
    scoring: ScoringConfig,
  ): Observable<{
    scoredStores: number;
    tierBreakdown: TierCounts;
    scoring: ScoringConfig;
  }> {
    return this.http
      .post<
        ApiResponse<{
          scoredStores: number;
          tierBreakdown: TierCounts;
          scoring: ScoringConfig;
        }>
      >(`${this.baseUrl}/jobs/${jobId}/score`, scoring)
      .pipe(map(({ data }) => data));
  }
}
