# polyrich

Production-ready Polymarket scanner + signal engine.

## File structure

```
src/
  config.js          – env vars + defaults
  fetcher.js         – Polymarket API fetch with retry/timeout and partial-failure tolerance
  normalizer.js      – normalizeMarket, quantile, formatters, grouping helpers
  persistence.js     – Mongoose models, TTL/unique indexes, idempotent upsert helpers
  signal_engine.js   – buildIdeas: watchlist → signals → diversified trade candidates
  html_renderer.js   – renderCandidate, renderBreakdown
server.js            – HTTP routes, scan loop (mutex + wait-then-sleep), /health, /metrics
test/
  sanity.test.js     – unit tests for normalizer, quantile, grouping, idempotent insert
```

## Routes

| Route        | Description                                        |
|--------------|----------------------------------------------------|
| `/`          | Index with links                                   |
| `/scan`      | Trigger a manual scan and show top 30 results      |
| `/snapshots` | Last 100 saved market snapshots                    |
| `/ideas`     | Scanner dashboard: trade candidates, movers, mispricing |
| `/health`    | JSON: `{ ok, mongoConnected, lastScanAt, scanRunning }` |
| `/metrics`   | JSON: last scan stats, counts, DB document counts  |

## Environment variables

| Variable                  | Default            | Description                                      |
|---------------------------|--------------------|--------------------------------------------------|
| `MONGO_URL`               | *(required)*       | MongoDB connection string                        |
| `PORT`                    | `3000`             | HTTP listen port                                 |
| `SCAN_INTERVAL_MS`        | `300000` (5 min)   | Sleep between background scans                  |
| `HISTORY_K`               | `6`                | Max price history points per market              |
| `WATCHLIST_SIZE`          | `200`              | Max markets to keep after activity ranking       |
| `SIGNALS_SIZE`            | `80`               | Max signals to score                             |
| `FINAL_CANDIDATES_SIZE`   | `20`               | Max trade candidates shown                       |
| `MOVERS_SIZE`             | `15`               | Max movers shown                                 |
| `SAVED_PER_SCAN`          | `200`              | Max markets saved per scan                       |
| `NOVELTY_LOOKBACK_SCANS`  | `5`                | How many prior shown-candidate records to track  |
| `SNAPSHOT_TTL_DAYS`       | `14`               | Auto-expire MarketSnapshot documents after N days|
| `SHOWN_CANDIDATE_TTL_DAYS`| `30`               | Auto-expire ShownCandidate documents after N days|
| `FEE_SLIPPAGE_BUFFER`     | `0.02`             | Added to spread before costPenalty computation   |
| `MAX_SPREAD_HARD`         | `0.5`              | Guardrail: markets with spread > this are filtered|
| `MISPRICING_MAX_SPREAD_PCT_STATIC` | `0.30` | Static spreadPct ceiling for mispricing flags     |
| `FETCH_TIMEOUT_MS`        | `15000`            | Timeout per Polymarket API request               |
| `FETCH_RETRY_COUNT`       | `2`                | Retry attempts per API page before giving up     |

## Node version

Production is pinned to **Node 20.x** via `engines` in `package.json` and `.nvmrc`.  
CI sandbox may run Node 24; the prestart check in `server.js` logs a warning if the
running major version differs from 20 but does **not** crash.

## Local run

```bash
# Install dependencies
npm install

# Run server (requires MONGO_URL in environment or .env loader)
MONGO_URL=mongodb://localhost:27017/polyrich npm start

# Run sanity tests (no DB needed)
npm test
```

## Retention behaviour

- **MarketSnapshot** documents expire automatically after `SNAPSHOT_TTL_DAYS` days (default 14).  
  MongoDB TTL index on `createdAt`.
- **ShownCandidate** records expire after `SHOWN_CANDIDATE_TTL_DAYS` days (default 30).  
  Used for novelty tracking so the same market isn't shown every scan.
- **Scan** records are kept indefinitely (small documents; one per scan run).

## Data model notes

- New snapshots store numeric fields only (`priceYesNum`, `spreadNum`, etc.).
- Legacy string fields (`priceYes`, `spread`, …) are kept in the schema for backward-compatible reads from older documents but are **not written** by new code.
- A unique compound index on `(scanId, marketSlug)` guarantees idempotent re-runs of the same scan never create duplicates.
