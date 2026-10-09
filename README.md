# TierForge

TierForge is a local web application for enriching store records through the supplied simulator, then scoring and assigning tiers from configurable metric bars and weights.

## Prerequisites

- Node.js 24.x (24.15 or newer) and npm 11.16.0
- Python 3.10 or newer
- Git
- On Windows, Visual Studio Build Tools with the C++ workload may be needed to build native npm dependencies such as `better-sqlite3`.

Check your tool versions:

```sh
node --version
npm --version
python --version
```

The repository includes `.nvmrc` for Node version managers that support it. Use any Node version manager or installer that provides the versions above.

## Clone and run

Run each component in its own terminal. Commands below are from the repository root unless noted.

### 1. Start the enrichment simulator

```sh
cd enrichment_simulator/enrichment_simulator
python -m venv .venv
```

Activate the environment:

```sh
# macOS/Linux
source .venv/bin/activate

# Windows PowerShell (use this instead of the command above)
.\.venv\Scripts\Activate.ps1
```

Install and start the simulator:

```sh
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The simulator is ready at `http://localhost:8000`; its health endpoint is `http://localhost:8000/health`.

### 2. Build and start the backend

In a second terminal, from the repository root:

```sh
cd backend
npm ci
```

Optionally copy `.env.example` to `.env` and edit the settings. Defaults work for the local setup:

```dotenv
PORT=4000
SIMULATOR_BASE_URL=http://localhost:8000
DATABASE_PATH=./data/tierforge.sqlite
APP_NAME=TierForge
```

Build and start:

```sh
npm run build
npm start
```

For development with automatic TypeScript reload, use `npm run dev` instead of the build/start commands. The API health endpoint is `http://localhost:4000/health`.

### 3. Start the frontend

In a third terminal, from the repository root:

```sh
cd frontend
npm ci
npm start
```

Open `http://localhost:4200`. The frontend connects to the backend at `http://localhost:4000`.

## Use the application

Upload a UTF-8 CSV with these required columns:

```text
store_id,store_name,address,city,state,country
```

The application validates required values and duplicate store IDs. The upload limit is 10 MB; additional columns are allowed. Sample datasets are intentionally not included in this repository; they are supplied separately.

After enrichment finishes, configure the metric bars, weights (which must total 100), and Large/Medium tier thresholds in the UI. Scoring uses successfully enriched stores and is safe to rerun with updated settings.

## Tests and build

Backend tests (single command):

```sh
cd backend
npm ci
npm test
```

Frontend tests:

```sh
cd frontend
npm ci
npm test -- --watch=false
```

Build checks:

```sh
# From backend/
npm run build

# From frontend/
npm run build
```

## Architecture and limitations

This is a local modular monolith: an Angular frontend, an Express/TypeScript API, a SQLite database, and the separately run enrichment simulator. The backend persists store work and enrichment results before scoring; score/tier values are derived from raw metrics and the current scoring configuration. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design, resilience behavior, and trade-offs.

The implementation is sized for the provided take-home workflow, including the supplied 5,000-row dataset, not as an unlimited streaming ingestion platform. Upload parsing and insertion are not fully streaming. SQLite is a single-process local database; this application does not coordinate multiple backend instances. Circuit-breaker state and simulator rate limiting are in memory and reset when the backend restarts. Retry attempts and leases are bounded; jobs that become terminal with failures require an explicit retry from the UI. There is no authentication or production deployment configuration.
