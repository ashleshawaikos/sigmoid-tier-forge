import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SqliteConnection } from '../lib/db.js';
import { TierforgeRepository } from './tierforgeRepository.js';

test('migrates existing store results and scores into the separated schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tierforge-migration-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      total_stores INTEGER NOT NULL, enriched_stores INTEGER NOT NULL,
      failed_stores INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE store_results (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, store_id TEXT NOT NULL,
      store_name TEXT NOT NULL, address TEXT NOT NULL, city TEXT NOT NULL,
      state TEXT NOT NULL, country TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, estimated_monthly_footfall REAL,
      estimated_monthly_revenue REAL, store_size_sqft REAL, failure_reason TEXT,
      UNIQUE(job_id, store_id)
    );
    CREATE TABLE store_scores (
      job_id INTEGER NOT NULL, store_id TEXT NOT NULL, score REAL NOT NULL,
      tier TEXT NOT NULL, PRIMARY KEY(job_id, store_id),
      FOREIGN KEY(job_id, store_id) REFERENCES store_results(job_id, store_id)
    );
    INSERT INTO jobs VALUES (1, 'existing', 'completed', 1, 1, 0, 'now', 'now');
    INSERT INTO store_results VALUES
      (1, 1, 'ST001', 'Existing Store', '1 Main', 'Delhi', 'Delhi', 'India',
       'enriched', 2, 12000, 145000, 5000, NULL);
    INSERT INTO store_scores VALUES (1, 'ST001', 50, 'Medium');
  `);
  legacy.close();

  const connection = new SqliteConnection(databasePath);
  try {
    const repository = new TierforgeRepository(connection);
    const rows = repository.listStores(1, { page: 1, pageSize: 10 });
    assert.equal(rows.total, 1);
    assert.equal(rows.items[0]?.attempts, 2);
    assert.equal(rows.items[0]?.estimated_monthly_revenue, 145000);
    assert.equal(rows.items[0]?.tier, 'Medium');
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
