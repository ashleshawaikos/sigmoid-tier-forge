# TierForge

TierForge imports store CSVs, enriches each store through the supplied local simulator, and computes configurable scores and tiers. Enrichment and scoring are separate: re-scoring reads only persisted metrics and never calls the simulator.

## Architecture

The application is a local modular monolith:

- Angular provides the upload, job dashboard, scoring form, and searchable/paginated results.
- Express controllers translate HTTP input/output and delegate to application services.
- Job/scoring services own use-case coordination and domain rules.
- A typed repository owns SQL queries and transactions; a SQLite connection wrapper owns initialization and schema migrations.
- A simulator client uses a shared HTTP wrapper and enforces rate limiting, timeout, and response validation.
- Multiple enrichment jobs can run concurrently; they share the simulator client's request rate limit.

The SQLite schema tracks `jobs`, per-store `job_stores`, successful `enrichment_results`, one current `scoring_config` per job, and current `store_scores`. The database is created at `backend/data/tierforge.sqlite` by default. Existing data from the previous `store_results` schema is migrated when the backend starts.

## Requirements

- Node.js 24.15+ and npm 11.16.0 (the repository `.nvmrc` selects Node 24)
- Python 3 and `venv` for the provided simulator
- Committed npm lockfiles are used for repeatable installs (`npm ci`)
- On Windows, install Visual Studio Build Tools with the **Desktop development with C++** workload (including the MSVC C++ build tools and a Windows SDK) so native dependencies such as `better-sqlite3` can build when a prebuilt binary is unavailable.

If a Windows backend install fails with `MSB4019` and `Microsoft.Cpp.Default.props` missing, add the C++ workload in Visual Studio Installer, then reopen the terminal and rerun `npm ci` from `backend`.

## Run locally

Run the initial Node setup from the repository root:

```bash
nvm install
nvm use
npm install --global npm@11.16.0
node --version
npm --version
```

`node --version` should report Node 24.15 or newer in the 24.x line, and `npm --version` should report `11.16.0`. If you do not use nvm, install those Node/npm versions with your preferred version manager or package manager before continuing.

### 1. Install and start the provided simulator

```bash
cd enrichment_simulator/enrichment_simulator
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

The simulator is ready when `http://localhost:8000/health` returns `{"status":"ok"}`.

### 2. Install and start the backend

In a second terminal, from the repository root. `nvm use` is needed in each terminal because nvm selects Node per shell:

```bash
nvm use
cd backend
npm ci
cp .env.example .env  # first run only
npm start
```

The API is ready when `http://localhost:4000/health` returns a `data.status` of `ok`. The database is created at `backend/data/tierforge.sqlite`. `DATABASE_PATH` in `backend/.env` is relative to the backend working directory unless it is absolute.

### 3. Install and start the Angular frontend

In a third terminal, from the repository root:

```bash
nvm use
cd frontend
npm ci
npm start
```

Open `http://localhost:4200`. The frontend calls the API at `http://localhost:4000`.

## CSV format

Upload a UTF-8 CSV up to 10 MB with the following required headers; extra columns are allowed:

```text
store_id,store_name,address,city,state,country
```

Required values must be non-empty and `store_id` values must be unique within the file. Invalid headers, row widths, values, or duplicate IDs return a descriptive validation error.

## API

All successful responses use `{ "data": ... }`; errors use `{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Method and path               | Purpose                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health`                 | Liveness check                                                                      |
| `POST /api/jobs`              | Multipart CSV upload (`file`, optional `name`); returns `202` with job ID           |
| `GET /api/jobs`               | List jobs with status and progress counts                                           |
| `GET /api/jobs/:jobId`        | Job status, enriched/failed/pending counts, and tier breakdown                      |
| `GET /api/jobs/:jobId/stores` | Paginated/filterable stores; supports `page`, `pageSize`, `tier`, `status`, and `q` |
| `POST /api/jobs/:jobId/score` | Compute/replace scores from the supplied scoring configuration                      |
| `GET /api/dashboard`          | Summary for the most recently created job                                           |

Scoring request example:

```json
{
  "bars": {
    "estimated_monthly_footfall": 15000,
    "estimated_monthly_revenue": 150000,
    "store_size_sqft": 8000
  },
  "weights": {
    "estimated_monthly_footfall": 50,
    "estimated_monthly_revenue": 30,
    "store_size_sqft": 20
  },
  "thresholds": { "Large": 70, "Medium": 40 }
}
```

The configured weights must total 100; score is the sum of weights for the metrics that meet their bars. Large and Medium thresholds must be within 0–100, and Large must be greater than Medium.

## Processing and limitations

- One enrichment job runs at a time. An additional upload receives `409` until that job is terminal.
- Up to 10 store workers run concurrently; simulator request starts are serialized at 210 ms intervals.
- Each store receives at most five attempts. Each HTTP request times out after 12 seconds; retry backoff grows exponentially and is capped at 8 seconds.
- Attempt IDs fence off stale writes. Successful metrics and status are persisted transactionally. Terminal failure reasons and attempt counts remain visible in the results.
- A job is `completed` when at least one store enriched successfully, even if other stores failed; it is `failed` when every store failed.
- Scoring can be safely rerun and replaces the prior score/tier rows and configuration for that job.
- Pending work is marked failed with an interruption reason after a backend restart; in-flight work does not resume automatically. Multiple simultaneous jobs and shared limiting across multiple backend processes are not supported.
- No user authentication is included; the app is intended for local use with the provided simulator.

## Build and tests

Backend:

```bash
cd backend
npm run build
npm test

# Optional formatting check (repository has no standalone lint script)
cd ../frontend
./node_modules/.bin/prettier --check --single-quote ../backend/src/app.ts ../backend/src/controllers/*.ts ../backend/src/infrastructure/http/*.ts ../backend/src/lib/*.ts ../backend/src/repositories/*.ts ../backend/src/services/*.ts src/app/*.ts src/app/*.html ../README.md
```

Frontend:

```bash
cd frontend
npm test -- --watch=false
npm run build
```

The sample CSV is `backend/stores_5000.csv`.
# sigmoid-tier-forge
