import { db, SqliteConnection } from '../lib/db.js';
import type {
  EnrichmentMetrics,
  JobRow,
  StoreInput,
  StoreRow,
  StoreStatus,
  Tier,
} from '../lib/db.js';

export type WorkItem = StoreInput & {
  attempt_id: number;
  attempt_count: number;
};
export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
export type JobSummary = JobRow & {
  pending_stores: number;
  tier_breakdown: Record<Tier, number>;
};
export type ScoredStore = {
  store_id: string;
  estimated_monthly_footfall: number;
  estimated_monthly_revenue: number;
  store_size_sqft: number;
};

export class TierforgeRepository {
  constructor(private readonly connection: SqliteConnection = db) {}

  createJob(name: string, stores: StoreInput[]): number {
    return this.connection.transaction(() => {
      const result = this.connection
        .prepare(
          "INSERT INTO jobs (name, status, total_stores) VALUES (?, 'running', ?)",
        )
        .run(name, stores.length);
      const jobId = Number(result.lastInsertRowid);
      const insertStore = this.connection.prepare(`
        INSERT INTO job_stores
          (job_id, store_id, store_name, address, city, state, country)
        VALUES
          (@job_id, @store_id, @store_name, @address, @city, @state, @country)
      `);
      for (const store of stores) insertStore.run({ job_id: jobId, ...store });
      return jobId;
    });
  }

  getJob(jobId: number): JobRow | undefined {
    return this.connection
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(jobId) as JobRow | undefined;
  }

  listJobs(): JobSummary[] {
    const rows = this.connection
      .prepare('SELECT id FROM jobs ORDER BY id DESC')
      .all() as Array<{ id: number }>;
    return rows.flatMap(({ id }) => {
      const summary = this.getJobSummary(id);
      return summary ? [summary] : [];
    });
  }

  listActiveJobIds(): number[] {
    const rows = this.connection
      .prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running')")
      .all() as Array<{ id: number }>;
    return rows.map(({ id }) => id);
  }

  getJobSummary(jobId: number): JobSummary | undefined {
    const job = this.getJob(jobId);
    if (!job) return undefined;
    const counts = this.connection
      .prepare(
        `
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'enriched' THEN 1 ELSE 0 END) AS enriched,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM job_stores WHERE job_id = ?
    `,
      )
      .get(jobId) as {
      pending: number | null;
      enriched: number | null;
      failed: number | null;
    };
    const breakdown = this.scoreBreakdown(jobId);
    return {
      ...job,
      pending_stores: counts.pending ?? 0,
      enriched_stores: counts.enriched ?? 0,
      failed_stores: counts.failed ?? 0,
      tier_breakdown: breakdown,
    };
  }

  listWorkItems(jobId: number): WorkItem[] {
    return this.connection
      .prepare(
        `
      SELECT store_id, store_name, address, city, state, country, attempt_id, attempt_count
      FROM job_stores WHERE job_id = ? AND status = 'pending' ORDER BY rowid
    `,
      )
      .all(jobId) as WorkItem[];
  }

  startAttempt(jobId: number, storeId: string): number | undefined {
    const result = this.connection
      .prepare(
        `
      UPDATE job_stores
      SET attempt_count = attempt_count + 1, attempt_id = attempt_id + 1
      WHERE job_id = ? AND store_id = ? AND status = 'pending'
    `,
      )
      .run(jobId, storeId);
    if (result.changes === 0) return undefined;
    const row = this.connection
      .prepare(
        'SELECT attempt_id FROM job_stores WHERE job_id = ? AND store_id = ?',
      )
      .get(jobId, storeId) as { attempt_id: number };
    return row.attempt_id;
  }

  completeAttempt(
    jobId: number,
    storeId: string,
    attemptId: number,
    metrics: EnrichmentMetrics,
  ): boolean {
    return this.connection.transaction(() => {
      const updated = this.connection
        .prepare(
          `
        UPDATE job_stores SET status = 'enriched', last_error = NULL
        WHERE job_id = ? AND store_id = ? AND status = 'pending' AND attempt_id = ?
      `,
        )
        .run(jobId, storeId, attemptId);
      if (updated.changes === 0) return false;
      this.connection
        .prepare(
          `
        INSERT INTO enrichment_results
          (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(
          jobId,
          storeId,
          metrics.estimated_monthly_footfall,
          metrics.estimated_monthly_revenue,
          metrics.store_size_sqft,
        );
      this.refreshJobCounts(jobId);
      return true;
    });
  }

  failStore(
    jobId: number,
    storeId: string,
    attemptId: number,
    reason: string,
  ): boolean {
    const result = this.connection
      .prepare(
        `
      UPDATE job_stores
      SET status = 'failed', last_error = ?
      WHERE job_id = ? AND store_id = ? AND status = 'pending' AND attempt_id = ?
    `,
      )
      .run(reason, jobId, storeId, attemptId);
    this.refreshJobCounts(jobId);
    return result.changes > 0;
  }

  failPending(jobId: number, reason: string): void {
    this.connection
      .prepare(
        `
      UPDATE job_stores SET status = 'failed', last_error = ?
      WHERE job_id = ? AND status = 'pending'
    `,
      )
      .run(reason, jobId);
    this.refreshJobCounts(jobId);
  }

  retryFailedStores(
    jobId: number,
  ):
    | { status: 'missing' }
    | { status: 'active' }
    | { status: 'none' }
    | { status: 'started'; count: number } {
    return this.connection.transaction(() => {
      const job = this.connection
        .prepare('SELECT status FROM jobs WHERE id = ?')
        .get(jobId) as { status: JobRow['status'] } | undefined;
      if (!job) return { status: 'missing' };
      if (job.status === 'running' || job.status === 'queued')
        return { status: 'active' };

      const result = this.connection
        .prepare(
          `
          UPDATE job_stores
          SET status = 'pending', attempt_count = 0, last_error = NULL
          WHERE job_id = ? AND status = 'failed'
        `,
        )
        .run(jobId);
      if (result.changes === 0) return { status: 'none' };

      this.connection
        .prepare(
          "UPDATE jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?",
        )
        .run(jobId);
      this.refreshJobCounts(jobId);
      return { status: 'started', count: result.changes };
    });
  }

  finishJob(jobId: number): void {
    this.refreshJobCounts(jobId);
    const summary = this.getJobSummary(jobId);
    if (!summary) return;
    const status =
      summary.pending_stores === 0 && summary.enriched_stores === 0
        ? 'failed'
        : 'completed';
    this.connection
      .prepare(
        "UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(status, jobId);
  }

  listStores(
    jobId: number,
    filters: {
      tier?: Tier;
      status?: StoreStatus;
      query?: string;
      page: number;
      pageSize: number;
    },
  ): PageResult<StoreRow> {
    const where = ['s.job_id = ?'];
    const params: Array<string | number> = [jobId];
    if (filters.tier) {
      where.push('sc.tier = ?');
      params.push(filters.tier);
    }
    if (filters.status) {
      where.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.query) {
      where.push('(s.store_name LIKE ? OR s.store_id LIKE ? OR s.city LIKE ?)');
      const search = `%${filters.query}%`;
      params.push(search, search, search);
    }
    const whereSql = where.join(' AND ');
    const total = (
      this.connection
        .prepare(
          `
      SELECT COUNT(*) AS count
      FROM job_stores s LEFT JOIN store_scores sc
        ON sc.job_id = s.job_id AND sc.store_id = s.store_id
      WHERE ${whereSql}
    `,
        )
        .get(...params) as { count: number }
    ).count;
    const rows = this.connection
      .prepare(
        `
      SELECT s.job_id, s.store_id, s.store_name, s.address, s.city, s.state, s.country,
             s.status, s.attempt_count AS attempts, s.last_error AS failure_reason,
             e.estimated_monthly_footfall, e.estimated_monthly_revenue, e.store_size_sqft,
             sc.score, sc.tier
      FROM job_stores s
      LEFT JOIN enrichment_results e ON e.job_id = s.job_id AND e.store_id = s.store_id
      LEFT JOIN store_scores sc ON sc.job_id = s.job_id AND sc.store_id = s.store_id
      WHERE ${whereSql}
      ORDER BY s.store_name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `,
      )
      .all(
        ...params,
        filters.pageSize,
        (filters.page - 1) * filters.pageSize,
      ) as StoreRow[];
    return {
      items: rows,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  listScorableStores(jobId: number): ScoredStore[] {
    return this.connection
      .prepare(
        `
      SELECT s.store_id, e.estimated_monthly_footfall, e.estimated_monthly_revenue, e.store_size_sqft
      FROM job_stores s JOIN enrichment_results e
        ON e.job_id = s.job_id AND e.store_id = s.store_id
      WHERE s.job_id = ? AND s.status = 'enriched'
    `,
      )
      .all(jobId) as ScoredStore[];
  }

  saveScores(
    jobId: number,
    config: {
      bars: Record<string, number>;
      weights: Record<string, number>;
      thresholds: { Large: number; Medium: number };
    },
    scores: Array<{ storeId: string; score: number; tier: Tier }>,
  ): void {
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `
        INSERT INTO scoring_config
          (job_id, footfall_bar, revenue_bar, size_bar, footfall_weight, revenue_weight, size_weight,
           large_threshold, medium_threshold, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(job_id) DO UPDATE SET
          footfall_bar = excluded.footfall_bar, revenue_bar = excluded.revenue_bar,
          size_bar = excluded.size_bar, footfall_weight = excluded.footfall_weight,
          revenue_weight = excluded.revenue_weight, size_weight = excluded.size_weight,
          large_threshold = excluded.large_threshold, medium_threshold = excluded.medium_threshold,
          updated_at = datetime('now')
      `,
        )
        .run(
          jobId,
          config.bars['estimated_monthly_footfall'],
          config.bars['estimated_monthly_revenue'],
          config.bars['store_size_sqft'],
          config.weights['estimated_monthly_footfall'],
          config.weights['estimated_monthly_revenue'],
          config.weights['store_size_sqft'],
          config.thresholds.Large,
          config.thresholds.Medium,
        );
      this.connection
        .prepare('DELETE FROM store_scores WHERE job_id = ?')
        .run(jobId);
      const insert = this.connection.prepare(
        'INSERT INTO store_scores (job_id, store_id, score, tier) VALUES (?, ?, ?, ?)',
      );
      for (const item of scores)
        insert.run(jobId, item.storeId, item.score, item.tier);
    });
  }

  scoreBreakdown(jobId: number): Record<Tier, number> {
    const rows = this.connection
      .prepare(
        `
      SELECT tier, COUNT(*) AS count FROM store_scores WHERE job_id = ? GROUP BY tier
    `,
      )
      .all(jobId) as Array<{ tier: Tier; count: number }>;
    return {
      Large: rows.find((row) => row.tier === 'Large')?.count ?? 0,
      Medium: rows.find((row) => row.tier === 'Medium')?.count ?? 0,
      Small: rows.find((row) => row.tier === 'Small')?.count ?? 0,
    };
  }

  latestJobSummary(): JobSummary | null {
    const job = this.listJobs()[0];
    return job ? (this.getJobSummary(job.id) ?? null) : null;
  }

  private refreshJobCounts(jobId: number): void {
    this.connection
      .prepare(
        `
      UPDATE jobs SET
        enriched_stores = (SELECT COUNT(*) FROM job_stores WHERE job_id = ? AND status = 'enriched'),
        failed_stores = (SELECT COUNT(*) FROM job_stores WHERE job_id = ? AND status = 'failed'),
        updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(jobId, jobId, jobId);
  }
}
