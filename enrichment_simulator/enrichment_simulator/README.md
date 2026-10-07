# TierForge Enrichment API Simulator

A local stand-in for the "third-party" enrichment API used in the TierForge take-home exercise. Every candidate runs the same simulator with the same behavior, so results are comparable.

## Run it

```
pip install -r requirements.txt
uvicorn main:app --port 8000
```

## Contract

### `POST /enrich`

Request:
```json
{
  "store_id": "ST000001",
  "store_name": "Fresh Supermarket #1",
  "address": "71 Church Street",
  "city": "New Delhi",
  "state": "Delhi"
}
```

Success response (`200`):
```json
{
  "store_id": "ST000001",
  "estimated_monthly_footfall": 18234,
  "estimated_monthly_revenue": 142033.50,
  "store_size_sqft": 6210
}
```

Metrics are **deterministic per `store_id`** — calling the same store twice returns the same values.

### Documented failure modes

| Behavior | Rate | Notes |
|---|---|---|
| `429 Too Many Requests` | whenever calls exceed **5 requests/second** globally | Applies across all callers, not per-connection. |
| `500 Internal Server Error` | ~10% of successful-rate-limit calls | Transient — treat as retryable. |
| Hangs **45–60s** before eventually returning `200` | ~2% of successful-rate-limit calls | Simulates a slow/stuck upstream call. Long enough that a system with reasonable timeouts should have already given up on and reclaimed this unit of work before the response arrives — the late response still carries valid data. |

### `GET /health`

Returns `{"status": "ok"}`. Not rate-limited.

## Notes for candidates

- Do not modify this service — treat it as a black box you don't control, exactly like a real third-party API.
- The rate limit is global across the whole simulator process, not per client/IP.
