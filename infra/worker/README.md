# ExitAtlas key proxy (Cloudflare Worker)

Keeps the Google Maps and NREL keys off the phone and caps what they can spend. Without it, gas prices need each driver's own Google key (Settings, Gas prices) and charger lookups use NREL's shared demo key (10 an hour).

**Status:** written and tested here (`npm test`), not deployed. Deploying needs a Cloudflare account and the keys, which only the owner can create.

## What it does

| Endpoint | Upstream | Stored | Budget |
|---|---|---|---|
| `POST /v1/gas-prices` with `{lat, lon}` | Google Places API (New) Nearby Search, gas stations within 1.6 km with fuel prices | Never (Google's terms do not allow caching prices) | `DAILY_PRICES` for everyone, `CLIENT_DAILY_PRICES` per client |
| `POST /v1/chargers` with the AFDC form fields | U.S. DOE AFDC nearby-route (public domain) | Cloudflare cache, 1 day | `DAILY_CHARGERS`, `CLIENT_DAILY_CHARGERS`; cache hits are free |
| `GET /v1/config` | none | 5 minutes in browsers | none |

* Only pages listed in `ALLOWED_ORIGINS` get an answer. A script outside a browser can fake the Origin header, so the budgets, and Google's own quota on the key, are the real limits.
* The request shapes are fixed: a client cannot widen the search radius, ask for other Google fields, or send its own AFDC key.
* Clients are counted by a salted hash of their IP address; addresses are not stored. Counters expire after two days.
* KV counters are approximate: KV is eventually consistent and accepts at most one write per second per key, so under bursts a few calls go uncounted (a failed counter write never fails the request). Set a hard daily quota on the Google key in Google Cloud Console (APIs, Places API (New), Quotas) as the backstop.
* Each counted call writes two KV keys. The Workers Free plan allows 1,000 KV writes a day ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)), so the default budgets (200 price and 200 charger calls a day) fit it; larger budgets need Workers Paid.
* `/v1/config` lets the owner switch off a service for everyone without an app update (`DISABLED = "prices"`), as the Nominatim usage policy asks of apps that use it.

## Deploy

1. Cloudflare account, then `npm install -g wrangler` and `wrangler login`.
2. `wrangler kv namespace create BUDGET`; put the id in `wrangler.toml`.
3. `wrangler secret put GOOGLE_KEY` (a key restricted to Places API (New), with a daily quota), `wrangler secret put NREL_KEY` (free at developer.nlr.gov), `wrangler secret put CLIENT_SALT` (any long random string).
4. Set the budgets in `wrangler.toml`, then `wrangler deploy`.
5. In ExitAtlas, Settings, Data and keys, enter the Worker URL (for example `https://exitatlas-proxy.<account>.workers.dev`).

Cost at personal scale: the Workers Free plan (100,000 requests a day, [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) covers it. Google bills Places calls with fuel prices after its monthly free allowance; `DAILY_PRICES = 200` caps the worst case at about 6,000 calls a month. Check current Google pricing before raising it. (Cloudflare limits checked 2026-10-28.)

## Test

```
cd infra/worker
npm test
```
