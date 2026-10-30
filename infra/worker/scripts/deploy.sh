#!/usr/bin/env bash
# Deploys the ExitAtlas proxy to the owner's Cloudflare account on the Workers Free plan (README):
#   1. creates the KV namespace (budget counters) and the D1 database (shared price reports) if missing
#   2. applies the D1 schema (idempotent)
#   3. deploys the Worker, sets CLIENT_SALT once (a random secret used to hash addresses and install ids)
#   4. checks the deployed endpoints with real requests (scripts/smoke.mjs), then deletes the test reports
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (or a `wrangler login`).
# It never adds a payment method or changes the plan; on the Free plan, use past a limit fails instead of
# being billed (docs/17).
set -euo pipefail
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4"
DB=exitatlas-prices
KV=exitatlas-budget
ORIGIN=https://altecbx.github.io

db_id() { $W d1 list --json 2>/dev/null | jq -r --arg n "$DB" '.[] | select(.name == $n) | .uuid' | head -1; }
kv_id() { $W kv namespace list 2>/dev/null | jq -r --arg t "$KV" '.[] | select(.title == $t) | .id' | head -1; }

id=$(db_id)
if [ -z "$id" ]; then echo "Creating D1 database $DB"; $W d1 create "$DB" >/dev/null; id=$(db_id); fi
kv=$(kv_id)
if [ -z "$kv" ]; then echo "Creating KV namespace $KV"; $W kv namespace create "$KV" >/dev/null; kv=$(kv_id); fi
[ -n "$id" ] && [ -n "$kv" ] || { echo "Could not find or create the D1 database or KV namespace" >&2; exit 1; }
echo "D1 $DB: $id"
echo "KV $KV: $kv"

# The committed wrangler.toml keeps placeholders; the deploy uses a filled in copy.
sed -e "s/REPLACE_WITH_KV_NAMESPACE_ID/$kv/" \
    -e 's/^# \[\[d1_databases\]\]/[[d1_databases]]/' \
    -e 's/^# binding = "PRICES_DB"/binding = "PRICES_DB"/' \
    -e 's/^# database_name = "exitatlas-prices"/database_name = "exitatlas-prices"/' \
    -e "s/^# database_id = \"REPLACE_WITH_D1_DATABASE_ID\"/database_id = \"$id\"/" \
    wrangler.toml > wrangler.deploy.toml
grep -q "database_id = \"$id\"" wrangler.deploy.toml || { echo "wrangler.toml no longer has the expected D1 block" >&2; exit 1; }

$W d1 execute "$DB" --remote --yes --file schema.sql --config wrangler.deploy.toml >/dev/null
echo "Schema applied"

out=$($W deploy --config wrangler.deploy.toml 2>&1) || { echo "$out" >&2; exit 1; }
url=$(printf '%s\n' "$out" | grep -o 'https://[A-Za-z0-9.-]*\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "$out"; echo "Deployed, but no workers.dev URL was printed (is the workers.dev subdomain on?)" >&2; exit 1; }
echo "Deployed: $url"

if ! $W secret list --config wrangler.deploy.toml 2>/dev/null | grep -q '"CLIENT_SALT"'; then
  openssl rand -hex 32 | $W secret put CLIENT_SALT --config wrangler.deploy.toml >/dev/null
  echo "CLIENT_SALT set"
fi

sleep 5
status=0
node scripts/smoke.mjs "$url/" "$ORIGIN" | tee smoke.log || status=$?
station=$(grep -o 'test:smoke-[a-z0-9]*' smoke.log | head -1 || true)
if [ -n "$station" ]; then
  $W d1 execute "$DB" --remote --yes --config wrangler.deploy.toml --command "DELETE FROM reports WHERE station = '$station'" >/dev/null
  echo "Test reports deleted ($station)"
fi
rm -f smoke.log
echo "Proxy URL for ExitAtlas Settings: $url"
exit $status
