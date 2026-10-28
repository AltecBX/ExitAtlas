#!/usr/bin/env bash
# Rebuild every bundled dataset from public sources.
#
# Requirements: python3 with shapely, pyshp, pyproj; node (for mapshaper); curl; ~2 GB disk.
#   pip install shapely pyshp pyproj
#   npm install --prefix "$WORK" mapshaper@0.6.102
#
# Usage: tools/data-pipeline/build_all.sh [work dir]
# Outputs: App/ExitAtlas/Resources/Data/{states.eab,timezones.eab,interstates.eax,corridors.eac,vehicles.json,restareas.json,
#          discover.json,stations.json,manifest.json}
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$ROOT/.build/data-pipeline}"
OUT="$ROOT/App/ExitAtlas/Resources/Data"
mkdir -p "$WORK" "$OUT"

TIGER_URL="https://www2.census.gov/geo/tiger/TIGER2026/STATE/tl_2026_us_state.zip"
OI_TAG="release-2026-07-13-gha-33"
OI_URL="https://github.com/tldev/openinterstate/releases/download/$OI_TAG/openinterstate-$OI_TAG.tar.gz"
REACH_URL="https://github.com/tldev/openinterstate-reachability/releases/download/score-20260715-1351876/reachability.csv"
EPA_URL="https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip"
TZ_URL="https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Time_Zones/FeatureServer/0/query?where=1%3D1&outFields=zone,utc&returnGeometry=true&outSR=4326&f=geojson"
# FHWA Truck Stop Parking (Jason's Law survey), public domain. 1,915 rows; two pages, merged by OBJECTID.
NTAD_URL="https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_Truck_Stop_Parking/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&orderByFields=OBJECTID"

# Checksums recorded on 2026-10-27. A mismatch means the upstream file changed: review before updating.
TIGER_SHA="2e17ea40dff3e00163eec87a26efa0b0ff7e8fe364a191bf1a7754dcb49ea326"
OI_SHA="36fd3c2bddb94a11bfc5f6b178e866f341f8a6e779c1bfd4a94def564a829487"
REACH_SHA="5e15f71fd87f0f4ff348cd4ab6c281141b29496fd547326a480939b9405889d4"
# EPA updates vehicles.csv as new models are rated (recorded 2026-10-28).
EPA_SHA="33d32caa0343cdb11c47be631e8a80b7ed7c351ee8503646a4e96485bd67b22f"

fetch() { # url dest [sha256]
  if [ ! -s "$2" ]; then curl -fsSL -o "$2" "$1"; fi
  if [ -n "${3:-}" ]; then echo "$3  $2" | sha256sum -c -; fi
}

MAPSHAPER="$WORK/node_modules/.bin/mapshaper"
[ -x "$MAPSHAPER" ] || npm install --silent --prefix "$WORK" mapshaper@0.6.102

cd "$WORK"
fetch "$TIGER_URL" tl_2026_us_state.zip "$TIGER_SHA"
fetch "$OI_URL" openinterstate.tar.gz "$OI_SHA"
fetch "$REACH_URL" reachability.csv "$REACH_SHA"
fetch "$TZ_URL" timezones.geojson
fetch "$EPA_URL" vehicles.csv.zip "$EPA_SHA"
fetch "$NTAD_URL&resultOffset=0" ntad_0.json
fetch "$NTAD_URL&resultOffset=1000" ntad_1.json
python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); s={f["attributes"]["OBJECTID"]:f for f in a["features"]+json.load(open(sys.argv[2]))["features"]}; a["features"]=[s[k] for k in sorted(s)]; json.dump(a,open(sys.argv[3],"w"))' ntad_0.json ntad_1.json ntad.json
unzip -o -q vehicles.csv.zip -d epa

unzip -o -q tl_2026_us_state.zip -d tiger
mkdir -p oi && tar xzf openinterstate.tar.gz -C oi
OI_CSV="$WORK/oi/$OI_TAG/csv"

# States: drop territories without interstates, topology-preserving 3 m simplification.
"$MAPSHAPER" tiger/tl_2026_us_state.shp -filter "['AS','GU','MP','VI'].indexOf(STUSPS) < 0" \
  -simplify dp interval=3 keep-shapes -o format=geojson precision=0.0000001 states_s3.geojson
"$MAPSHAPER" tiger/tl_2026_us_state.shp -filter "['AS','GU','MP','VI'].indexOf(STUSPS) < 0" \
  -o format=geojson precision=0.0000001 states_full.geojson
"$MAPSHAPER" timezones.geojson -filter "['Samoa','Chamorro'].indexOf(zone) < 0" \
  -simplify dp interval=10 keep-shapes -o format=geojson precision=0.0000001 timezones_s10.geojson

cd "$HERE"
python3 build_regions.py states "$WORK/states_s3.geojson" "$OUT/states.eab" states_source.json
python3 build_regions.py tzones "$WORK/timezones_s10.geojson" "$OUT/timezones.eab" timezones_source.json
# Rest area tags come from the live OSM API (cached in the work dir), so the result reflects the fetch date.
python3 build_rest_areas.py "$OI_CSV" "$WORK/rest_area_tags.json" "$WORK/ntad.json" "$OUT/restareas.json" "$WORK/rest_area_classes.json"
python3 build_interstates.py "$OI_CSV" "$WORK/reachability.csv" "$OUT/interstates.eax" openinterstate_source.json "$WORK/rest_area_classes.json"
python3 build_corridors.py "$OI_CSV" "$OUT/corridors.eac" openinterstate_source.json
# Gas station hours, restrooms, rebrands and closures: current tags from the live OSM API (cached in the work dir).
python3 build_stations.py "$OI_CSV" "$WORK/gas_tags.json" "$OUT/stations.json"
python3 build_vehicles.py "$WORK/epa/vehicles.csv" fuel_tanks.json "$OUT/vehicles.json"
# Discover places come from the live Wikidata query service (cached per category in the work dir).
mkdir -p "$WORK/wikidata"
python3 build_discover.py "$OI_CSV" "$WORK/wikidata" "$OUT/discover.json"
# Last: versions, sizes, hashes and provenance of everything above, for app data updates.
python3 build_manifest.py "$OUT"
echo "Full resolution states for oracle fixtures: $WORK/states_full.geojson"
