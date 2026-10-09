# TierForge architecture and trade-offs

## Purpose and scope

TierForge accepts a CSV of store records, enriches each store through the supplied local simulator, and derives a configurable score and tier from the returned metrics. The design deliberately keeps enrichment (slow, I/O-bound, and unreliable) separate from scoring (fast and deterministic).

This is a local take-home implementation aimed at the supplied workflow and dataset size, including 5,000 rows. It is not intended to claim production-scale streaming or multi-instance operation.

## Components and flow

1. **Angular frontend** uploads CSV files, displays job progress and store results, and submits scoring settings.
2. **Express API** validates HTTP inputs, returns structured errors, and delegates to application services.
3. **Job service** parses/validates CSV input, coordinates workers, claims units of work, calls the enrichment gateway, and applies retry policy.
4. **Simulator client** calls the separately run enrichment simulator through a timeout-aware HTTP client. It validates response shape and classifies failures.
5. **SQLite repository** persists jobs, individual store work, leases, attempt history, raw enrichment results, and scoring configuration. Its transactions guard claims and state changes.
6. **Scoring service** validates bars, weights, and tier thresholds, then saves the current configuration. Store scores and tiers are derived from stored enrichment metrics and that configuration when results are read; scoring does not call the enrichment service.

## Resilience and concurrency

- Each store is a durable unit of work in SQLite. A worker atomically claims one pending, unleased store, increments its attempt/fencing ID, and writes a lease expiry.
- A worker that disappears leaves an expiring lease; another worker can reclaim the work. Completion is conditional on the current attempt ID, preventing an older response from overwriting a newer attempt.
- Attempt history records outcomes and errors, and successful response metrics. Successful enrichment results and the store's enriched status are saved transactionally.
- HTTP timeouts, network errors, HTTP 408/429/5xx are retryable. Other HTTP 4xx and invalid responses are treated as permanent for that store. Retry delay uses bounded exponential backoff stored as a lease expiry.
- One circuit breaker instance is shared by jobs in a backend process. It counts consecutive retryable failures across jobs, opens at five, and allows one half-open probe after a 30-second cooldown. Permanent row-specific errors do not count toward the breaker. An open breaker prevents new work from being claimed; active requests may finish.
- The simulator client's in-memory rate limiter serializes request starts at approximately 210 ms intervals, keeping one backend process under the simulator's global limit of five requests per second.
- On backend startup, active jobs are resumed from SQLite. Completed store results are retained; pending or expired work can be claimed again.

## Data and scoring

- `jobs` stores job-level status and aggregate counts.
- `job_stores` is the durable work ledger, including status, attempt count, fencing ID, error, and lease expiry.
- `enrichment_attempts` stores per-attempt start/completion, outcome, error, and successful metrics payload.
- `enrichment_results` stores the current raw enrichment metrics for each successfully enriched store.
- `scoring_config` stores one current scoring configuration per job. Legacy score data is retained for schema migration compatibility.

The score is the sum of the weights for metrics whose values meet their corresponding bars. The tier is determined by comparing that score with the configured Large and Medium thresholds. Re-scoring updates the configuration without re-enriching stores or writing a second derived score for each row.

## Deliberate trade-offs and limitations

- **CSV processing is not fully streaming.** The upload is buffered, parsed into an in-memory array, and inserted in a transaction. This is practical for the supplied 5,000-row file and 10 MB upload limit; much larger input would need streaming parsing and bounded/chunked persistence.
- **SQLite targets a local, single-process deployment.** It provides durable state and transactional claims for workers in this application, but its single-writer model and local-file coordination are not a substitute for a distributed queue/database at higher scale or across hosts.
- **At-least-once external calls, not exactly-once.** If a simulator call succeeds but the process dies before persisting the result, the lease can expire and the call may be repeated. Fencing protects stored state; it cannot undo an external request.
- **Lease duration is fixed and there is no heartbeat.** The default lease is 30 seconds and HTTP timeout is 12 seconds. A future client with longer calls or long queue delays may need lease renewal and/or calibrated timeouts.
- **Retry budgets are finite.** Each processing run has a maximum of five attempts per store, with bounded backoff. A terminal job is not automatically rescheduled indefinitely; failed stores can be retried explicitly from the UI.
- **Circuit-breaker state is process-local and not persisted.** It is shared across jobs in one backend process, but resets after restart and is not coordinated across multiple backend instances.
- **An open breaker terminalizes remaining pending stores in the affected run.** Recovery after cooldown requires a new/retried run; the cooldown itself is not a background scheduler. A half-open probe is an ordinary store request, not a separate simulator health probe.
- **Rate limiting is process-local.** It protects the simulator when one backend instance is running. Multiple backend instances could exceed the simulator's shared 5 requests/second limit.
- **Scores are derived at read time.** This avoids stale duplicated score data and makes re-scoring simple. It adds computation to list/summary queries; a materialized score table or cache may be appropriate for much larger datasets.
- **No authentication or authorization is included.** The app is intended to run locally for the exercise, not exposed as a public service.
- **Observability and operations are intentionally small.** The application logs structured events but has no metrics dashboard, external alerting, distributed tracing, or managed queue.
