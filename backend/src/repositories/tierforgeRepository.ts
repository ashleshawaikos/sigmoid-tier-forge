import { db, SqliteConnection } from '../lib/db.js';
import type {
  EnrichmentMetrics,
  JobRow,
  StoreInput,
  StoreRow,
  StoreStatus,
  Tier,
} from '../lib/db.js';

const scoreExpression = `(
  CASE WHEN e.estimated_monthly_footfall >= c.footfall_bar THEN c.footfall_weight ELSE 0 END +
  CASE WHEN e.estimated_monthly_revenue >= c.revenue_bar THEN c.revenue_weight ELSE 0 END +
  CASE WHEN e.store_size_sqft >= c.size_bar THEN c.size_weight ELSE 0 END
)`;
const scoredStoreRows = `
  SELECT s.job_id, s.store_id, s.store_name, s.address, s.city, s.state, s.country,
         s.status, s.attempt_count AS attempts, s.last_error AS failure_reason,
         e.estimated_monthly_footfall, e.estimated_monthly_revenue, e.store_size_sqft,
         CASE
           WHEN c.job_id IS NULL THEN legacy.score
           WHEN s.status = 'enriched' AND e.store_id IS NOT NULL THEN ${scoreExpression}
           ELSE NULL
         END AS score,
         CASE
           WHEN c.job_id IS NULL THEN legacy.tier
           WHEN s.status != 'enriched' OR e.store_id IS NULL THEN NULL
           WHEN ${scoreExpression} >= c.large_threshold THEN 'Large'
           WHEN ${scoreExpression} >= c.medium_threshold THEN 'Medium'
           ELSE 'Small'
         END AS tier
  FROM job_stores s
  LEFT JOIN enrichment_results e ON e.job_id = s.job_id AND e.store_id = s.store_id
  LEFT JOIN scoring_config c ON c.job_id = s.job_id
  LEFT JOIN legacy_store_scores legacy ON legacy.job_id = s.job_id AND legacy.store_id = s.store_id
`;

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

  claimWorkItem(
    jobId: number,
    maxAttempts: number,
    leaseMs: number,
  ): WorkItem | undefined {
    return this.connection.transaction(() => {
      const exhausted = this.connection
        .prepare(
          `
        UPDATE job_stores
        SET status = 'failed',
            last_error = 'Failed after ' || CAST(? AS INTEGER) || ' attempts. Last error: ' ||
              COALESCE(last_error, 'Worker lease expired after the final attempt.'),
            lease_expires_at = NULL
        WHERE job_id = ? AND status = 'pending' AND attempt_count >= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `,
        )
        .run(maxAttempts, jobId, maxAttempts, Date.now());
      if (exhausted.changes > 0) {
        this.connection
          .prepare(
            `
          UPDATE enrichment_attempts
          SET outcome = 'abandoned', completed_at = datetime('now'),
              error_message = COALESCE(error_message, 'Worker lease expired after the final attempt.')
          WHERE job_id = ? AND outcome = 'running'
            AND EXISTS (
              SELECT 1 FROM job_stores s
              WHERE s.job_id = enrichment_attempts.job_id
                AND s.store_id = enrichment_attempts.store_id
                AND s.attempt_id = enrichment_attempts.attempt_id
                AND s.status = 'failed'
            )
        `,
          )
          .run(jobId);
        this.refreshJobCounts(jobId);
      }

      const claimed = this.connection
        .prepare(
          `
      UPDATE job_stores
      SET attempt_count = attempt_count + 1,
          attempt_id = attempt_id + 1,
          lease_expires_at = ?,
          last_error = NULL
      WHERE rowid = (
        SELECT rowid FROM job_stores
        WHERE job_id = ? AND status = 'pending' AND attempt_count < ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY rowid LIMIT 1
      )
        AND status = 'pending'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      RETURNING store_id, store_name, address, city, state, country, attempt_id, attempt_count
    `,
        )
        .get(
          Date.now() + leaseMs,
          jobId,
          maxAttempts,
          Date.now(),
          Date.now(),
        ) as WorkItem | undefined;
      if (claimed) {
        this.connection
          .prepare(
            `
          UPDATE enrichment_attempts
          SET outcome = 'abandoned', completed_at = datetime('now'),
              error_message = 'Worker lease expired before the attempt completed.'
          WHERE job_id = ? AND store_id = ? AND attempt_id = ?
            AND outcome = 'running'
        `,
          )
          .run(jobId, claimed.store_id, claimed.attempt_id - 1);
        this.connection
          .prepare(
            `
          INSERT INTO enrichment_attempts (job_id, store_id, attempt_id, outcome)
          VALUES (?, ?, ?, 'running')
        `,
          )
          .run(jobId, claimed.store_id, claimed.attempt_id);
      }
      return claimed;
    });
  }

  hasPendingWork(jobId: number): boolean {
    const row = this.connection
      .prepare(
        "SELECT 1 FROM job_stores WHERE job_id = ? AND status = 'pending' LIMIT 1",
      )
      .get(jobId);
    return row !== undefined;
  }

  startAttempt(jobId: number, storeId: string): number | undefined {
    return this.connection.transaction(() => {
      const result = this.connection
        .prepare(
          `
      UPDATE job_stores
      SET attempt_count = attempt_count + 1, attempt_id = attempt_id + 1,
          lease_expires_at = NULL
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
      this.connection
        .prepare(
          `
        INSERT INTO enrichment_attempts (job_id, store_id, attempt_id, outcome)
        VALUES (?, ?, ?, 'running')
      `,
        )
        .run(jobId, storeId, row.attempt_id);
      return row.attempt_id;
    });
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
        UPDATE job_stores
        SET status = 'enriched', last_error = NULL, lease_expires_at = NULL
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
      this.connection
        .prepare(
          `
        UPDATE enrichment_attempts
        SET outcome = 'succeeded', completed_at = datetime('now'), metrics_json = ?
        WHERE job_id = ? AND store_id = ? AND attempt_id = ?
      `,
        )
        .run(JSON.stringify(metrics), jobId, storeId, attemptId);
      this.refreshJobCounts(jobId);
      return true;
    });
  }

  failStore(
    jobId: number,
    storeId: string,
    attemptId: number,
    reason: string,
    outcome: 'permanent_failure' | 'retry_exhausted' = 'retry_exhausted',
  ): boolean {
    const result = this.connection
      .prepare(
        `
      UPDATE job_stores
      SET status = 'failed', last_error = ?, lease_expires_at = NULL
      WHERE job_id = ? AND store_id = ? AND status = 'pending' AND attempt_id = ?
    `,
      )
      .run(reason, jobId, storeId, attemptId);
    this.refreshJobCounts(jobId);
    if (result.changes > 0) {
      this.connection
        .prepare(
          `
        UPDATE enrichment_attempts
        SET outcome = ?, completed_at = datetime('now'), error_message = ?
        WHERE job_id = ? AND store_id = ? AND attempt_id = ?
      `,
        )
        .run(outcome, reason, jobId, storeId, attemptId);
    }
    return result.changes > 0;
  }

  deferAttempt(
    jobId: number,
    storeId: string,
    attemptId: number,
    reason: string,
    retryAfterMs: number,
  ): boolean {
    const result = this.connection
      .prepare(
        `
      UPDATE job_stores
      SET last_error = ?, lease_expires_at = ?
      WHERE job_id = ? AND store_id = ? AND status = 'pending' AND attempt_id = ?
    `,
      )
      .run(reason, Date.now() + retryAfterMs, jobId, storeId, attemptId);
    if (result.changes > 0) {
      this.connection
        .prepare(
          `
        UPDATE enrichment_attempts
        SET outcome = 'retryable_failure', completed_at = datetime('now'), error_message = ?
        WHERE job_id = ? AND store_id = ? AND attempt_id = ?
      `,
        )
        .run(reason, jobId, storeId, attemptId);
    }
    return result.changes > 0;
  }

  failPending(jobId: number, reason: string): void {
    this.connection
      .prepare(
        `
      UPDATE enrichment_attempts
      SET outcome = 'abandoned', completed_at = datetime('now'), error_message = ?
      WHERE job_id = ? AND outcome = 'running'
    `,
      )
      .run(reason, jobId);
    this.connection
      .prepare(
        `
      UPDATE job_stores
      SET status = 'failed', last_error = ?, lease_expires_at = NULL
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
          SET status = 'pending', attempt_count = 0, last_error = NULL,
              lease_expires_at = NULL
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
    if (summary.pending_stores > 0) return;
    const status = summary.enriched_stores === 0 ? 'failed' : 'completed';
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
    const where = ['scored.job_id = ?'];
    const params: Array<string | number> = [jobId];
    if (filters.tier) {
      where.push('scored.tier = ?');
      params.push(filters.tier);
    }
    if (filters.status) {
      where.push('scored.status = ?');
      params.push(filters.status);
    }
    if (filters.query) {
      where.push(
        '(scored.store_name LIKE ? OR scored.store_id LIKE ? OR scored.city LIKE ?)',
      );
      const search = `%${filters.query}%`;
      params.push(search, search, search);
    }
    const whereSql = where.join(' AND ');
    const total = (
      this.connection
        .prepare(
          `
      SELECT COUNT(*) AS count
      FROM (${scoredStoreRows}) AS scored
      WHERE ${whereSql}
    `,
        )
        .get(...params) as { count: number }
    ).count;
    const rows = this.connection
      .prepare(
        `
      SELECT scored.*
      FROM (${scoredStoreRows}) AS scored
      WHERE ${whereSql}
      ORDER BY scored.store_name COLLATE NOCASE
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

  saveScoringConfig(
    jobId: number,
    config: {
      bars: Record<string, number>;
      weights: Record<string, number>;
      thresholds: { Large: number; Medium: number };
    },
  ): void {
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
  }

  scoreBreakdown(jobId: number): Record<Tier, number> {
    const rows = this.connection
      .prepare(
        `
      SELECT tier, COUNT(*) AS count
      FROM (${scoredStoreRows}) AS scored
      WHERE job_id = ? AND tier IS NOT NULL
      GROUP BY tier
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
