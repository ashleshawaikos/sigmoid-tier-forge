"""Flaky Enrichment API simulator for the TierForge take-home exercise.

Every candidate runs this locally and points their job engine at it.
See README.md in this folder for the documented contract.

Run:
    pip install fastapi uvicorn
    uvicorn main:app --port 8000
"""

import asyncio
import hashlib
import random
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="TierForge Enrichment API Simulator")

RATE_LIMIT_PER_SECOND = 5
ERROR_RATE = 0.10
HANG_RATE = 0.02
HANG_SECONDS = 50
NORMAL_DELAY_RANGE = (0.2, 0.5)

_window_start = time.monotonic()
_window_count = 0
_lock = asyncio.Lock()


class EnrichRequest(BaseModel):
    store_id: str
    store_name: str
    address: str
    city: str
    state: str


class EnrichResponse(BaseModel):
    store_id: str
    estimated_monthly_footfall: int
    estimated_monthly_revenue: float
    store_size_sqft: int


async def _check_rate_limit() -> None:
    global _window_start, _window_count
    async with _lock:
        now = time.monotonic()
        if now - _window_start >= 1.0:
            _window_start = now
            _window_count = 0
        _window_count += 1
        if _window_count > RATE_LIMIT_PER_SECOND:
            raise HTTPException(status_code=429, detail="Rate limit exceeded: 5 requests/second")


def _deterministic_metrics(store_id: str) -> EnrichResponse:
    seed = int(hashlib.sha256(store_id.encode()).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    return EnrichResponse(
        store_id=store_id,
        estimated_monthly_footfall=rng.randint(500, 50_000),
        estimated_monthly_revenue=round(rng.uniform(5_000, 500_000), 2),
        store_size_sqft=rng.randint(200, 20_000),
    )


@app.post("/enrich", response_model=EnrichResponse)
async def enrich(req: EnrichRequest):
    await _check_rate_limit()

    roll = random.random()

    if roll < HANG_RATE:
        await asyncio.sleep(HANG_SECONDS)
        return _deterministic_metrics(req.store_id)

    if roll < HANG_RATE + ERROR_RATE:
        await asyncio.sleep(random.uniform(*NORMAL_DELAY_RANGE))
        raise HTTPException(status_code=500, detail="Transient upstream error")

    await asyncio.sleep(random.uniform(*NORMAL_DELAY_RANGE))
    return _deterministic_metrics(req.store_id)


@app.get("/health")
async def health():
    return {"status": "ok"}
