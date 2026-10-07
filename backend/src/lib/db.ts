import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from '../config.js';

export class SqliteConnection {
  private readonly database: Database.Database;

  constructor(path: string) {
    const databasePath = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:')
      mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.migrate();
  }

  prepare(sql: string): Database.Statement {
    return this.database.prepare(sql);
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const hasTable = (name: string): boolean =>
      Boolean(
        this.database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name),
      );
    if (
      hasTable('store_scores') &&
      (
        this.database.pragma('foreign_key_list(store_scores)') as Array<{
          table: string;
        }>
      ).some(
        (foreignKey: { table: string }) => foreignKey.table === 'store_results',
      )
    ) {
      this.database.exec(
        'ALTER TABLE store_scores RENAME TO legacy_store_scores',
      );
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        total_stores INTEGER NOT NULL DEFAULT 0,
        enriched_stores INTEGER NOT NULL DEFAULT 0,
        failed_stores INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS job_stores (
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        store_id TEXT NOT NULL,
        store_name TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        country TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enriched', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        attempt_id INTEGER NOT NULL DEFAULT 0 CHECK (attempt_id >= 0),
        last_error TEXT,
        PRIMARY KEY (job_id, store_id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_stores_status ON job_stores(job_id, status);

      CREATE TABLE IF NOT EXISTS enrichment_results (
        job_id INTEGER NOT NULL,
        store_id TEXT NOT NULL,
        estimated_monthly_footfall REAL NOT NULL,
        estimated_monthly_revenue REAL NOT NULL,
        store_size_sqft REAL NOT NULL,
        enriched_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (job_id, store_id),
        FOREIGN KEY (job_id, store_id) REFERENCES job_stores(job_id, store_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scoring_config (
        job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        footfall_bar REAL NOT NULL,
        revenue_bar REAL NOT NULL,
        size_bar REAL NOT NULL,
        footfall_weight REAL NOT NULL,
        revenue_weight REAL NOT NULL,
        size_weight REAL NOT NULL,
        large_threshold REAL NOT NULL,
        medium_threshold REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS store_scores (
        job_id INTEGER NOT NULL,
        store_id TEXT NOT NULL,
        score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
        tier TEXT NOT NULL CHECK (tier IN ('Large', 'Medium', 'Small')),
        PRIMARY KEY (job_id, store_id),
        FOREIGN KEY (job_id, store_id) REFERENCES job_stores(job_id, store_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_store_scores_tier ON store_scores(job_id, tier);
    `);

    if (hasTable('store_results')) {
      this.database.exec(`
        INSERT OR IGNORE INTO job_stores
          (job_id, store_id, store_name, address, city, state, country, status, attempt_count, last_error)
        SELECT job_id, store_id, store_name, address, city, state, country, status, attempts, failure_reason
        FROM store_results;

        INSERT OR IGNORE INTO enrichment_results
          (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
        SELECT job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft
        FROM store_results
        WHERE status = 'enriched'
          AND estimated_monthly_footfall IS NOT NULL
          AND estimated_monthly_revenue IS NOT NULL
          AND store_size_sqft IS NOT NULL;
      `);
    }
    if (hasTable('legacy_store_scores')) {
      this.database.exec(`
        INSERT OR IGNORE INTO store_scores (job_id, store_id, score, tier)
        SELECT job_id, store_id, score, tier FROM legacy_store_scores;
        DROP TABLE legacy_store_scores;
      `);
    }
  }
}

export const db = new SqliteConnection(config.databasePath);

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type StoreStatus = 'pending' | 'enriched' | 'failed';
export type Tier = 'Large' | 'Medium' | 'Small';

export type StoreInput = {
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
  country: string;
};

export type JobRow = {
  id: number;
  name: string;
  status: JobStatus;
  total_stores: number;
  enriched_stores: number;
  failed_stores: number;
  created_at: string;
  updated_at: string;
};

export type StoreRow = StoreInput & {
  job_id: number;
  status: StoreStatus;
  attempts: number;
  estimated_monthly_footfall: number | null;
  estimated_monthly_revenue: number | null;
  store_size_sqft: number | null;
  failure_reason: string | null;
  score: number | null;
  tier: Tier | null;
};

export type EnrichmentMetrics = {
  estimated_monthly_footfall: number;
  estimated_monthly_revenue: number;
  store_size_sqft: number;
};
