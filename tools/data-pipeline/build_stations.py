#!/usr/bin/env python3
"""Build stations.json: what OpenStreetMap and the brands' own store listings say about the gas stations in
interstates.eax.

Usage:
    build_stations.py <openinterstate csv dir> <osm tags cache.json> <out stations.json> [<All the Places dir>]

For every OpenInterstate place in the gas category, reads the element's current tags from the OSM API
(osm_tags.py; cached, so a rerun resumes) and keeps only facts that are tagged:

  h    opening_hours as written (the station's hours; "unknown" is dropped)
  hc   the date mappers last checked them (check_date:opening_hours, else check_date)
  t    toilets: true or false, only when tagged
  b    the current brand, when it differs from the one in interstates.eax (rebranded stations)
  gone why the station should not be recommended: "deleted" (removed from OSM), "not fuel" (the
       element is no longer tagged amenity=fuel, for example a disused or converted station)

From All the Places (CC0; weekly scrapes of brand store locators, one GeoJSON file per spider and the
run's latest.json in the directory), for the station of the same brand nearest within 150 m:

  ah   the brand's listed hours for the station (fuel or travel stop features only, never a store's hours)
  at   true when the brand lists a restroom (toilets=yes) at the station or its store
  ab   the brand as the listing names it ("Love's"), for the label "Listed by Love's"

The listing date is the run's start date (meta.brand_collected). A brand listing is what the brand says,
not a visit: the apps label it "Reported", never "Verified", and never show a station restroom as open.

Nothing is inferred from brands or names: a station without these facts has no entry, and the apps say
the hours or restroom are unknown. The tags reflect the fetch date (meta.tags_fetched).
"""
import collections
import csv
import datetime
import json
import math
import os
import re
import sys

from osm_tags import fetch_tags

csv.field_size_limit(10**9)


def facts(row, element):
    if element is None:
        return None
    if not element.get("visible", True):
        return {"gone": "deleted"}
    tags = element.get("tags", {})
    if tags.get("amenity") != "fuel":
        return {"gone": "not fuel"}
    out = {}
    hours = (tags.get("opening_hours") or "").strip()
    if hours and hours.lower() != "unknown":
        out["h"] = hours
        checked = tags.get("check_date:opening_hours") or tags.get("check_date")
        if checked:
            out["hc"] = checked[:10]
    if tags.get("toilets") in ("yes", "no"):
        out["t"] = tags["toilets"] == "yes"
    brand = (tags.get("brand") or "").strip()
    if brand and brand.lower() != (row.get("brand") or "").strip().lower():
        out["b"] = brand
    return out or None


def norm(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def meters(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371000 * math.hypot(x, math.radians(lat2 - lat1))


def brand_listings(rows, items, atp_dir, radius=150):
    """{place_id: {ah, at, ab}} from All the Places: same brand (either name a prefix of the other, after
    normalizing), nearest within `radius` meters. Hours only from fuel or travel stop features."""
    cell = lambda lat, lon: (int(lat * 100), int(lon * 100))
    grid = collections.defaultdict(list)
    for fn in sorted(os.listdir(atp_dir)):
        if not fn.endswith(".geojson"):
            continue
        for f in json.load(open(os.path.join(atp_dir, fn)))["features"]:
            g, p = f.get("geometry") or {}, f.get("properties") or {}
            if g.get("type") != "Point" or p.get("addr:country") not in (None, "US", "USA"):
                continue
            lon, lat = g["coordinates"][:2]
            brand = p.get("brand") or p.get("name")
            station = p.get("amenity") == "fuel" or p.get("highway") == "services"
            hours = (p.get("opening_hours") or "").strip() if station else ""
            grid[cell(lat, lon)].append((lat, lon, norm(brand), brand, hours, p.get("toilets") == "yes"))
    out = {}
    for r in rows:
        lon, lat = json.loads(r["geometry_geojson"])["coordinates"][:2]
        mine = norm(items.get(r["place_id"], {}).get("b") or r.get("brand")) or norm(r.get("name"))
        if not mine:
            continue
        near = []
        cx, cy = cell(lat, lon)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for c in grid.get((cx + dx, cy + dy), []):
                    if c[2] and (mine.startswith(c[2]) or c[2].startswith(mine)):
                        d = meters(lat, lon, c[0], c[1])
                        if d <= radius:
                            near.append((d, c))
        if not near:
            continue
        near.sort(key=lambda x: x[0])
        fact = {}
        hours = next((c[4] for _, c in near if c[4]), "")
        if hours and hours.lower() != "unknown":
            fact["ah"] = hours
        if any(c[5] for _, c in near):
            fact["at"] = True
        if fact:
            fact["ab"] = near[0][1][3]
            out[r["place_id"]] = fact
    return out


def main(csv_dir, cache_path, out_path, atp_dir=None):
    rows = [r for r in csv.DictReader(open(os.path.join(csv_dir, "places.csv"))) if r["category"] == "gas"]
    tags = fetch_tags([r["place_id"] for r in rows], cache_path)
    missing = set(tags.pop("_missing", []))
    items = {}
    for r in rows:
        f = facts(r, tags.get(r["place_id"]))
        if f:
            items[r["place_id"]] = f
    atp_run = None
    if atp_dir:
        atp_run = json.load(open(os.path.join(atp_dir, "latest.json")))
        for pid, fact in brand_listings(rows, items, atp_dir).items():
            if "gone" not in items.get(pid, {}):
                items.setdefault(pid, {}).update(fact)
    fetched = max((e.get("timestamp") or "" for e in tags.values()), default="")[:10]
    stat = os.stat(cache_path)
    meta = {
        "kind": "stations",
        "source": "OpenStreetMap, current tags from the OSM API for the gas stations in interstates.eax",
        "license": "ODbL 1.0",
        "attribution": "© OpenStreetMap contributors",
        "tags_fetched": datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc).strftime("%Y-%m-%d"),
        "data_last_edit": fetched,
        "count": len(rows),
        "with_hours": sum(1 for f in items.values() if "h" in f),
        "with_toilets": sum(1 for f in items.values() if "t" in f),
        "rebranded": sum(1 for f in items.values() if "b" in f),
        "gone": sum(1 for f in items.values() if "gone" in f),
        "unreadable": len(missing),
        "with_brand_hours": sum(1 for f in items.values() if "ah" in f),
        "with_brand_toilets": sum(1 for f in items.values() if "at" in f),
        "with_any_hours": sum(1 for f in items.values() if "h" in f or "ah" in f),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if atp_run:
        meta["source"] = ("OpenStreetMap, current tags from the OSM API for the gas stations in interstates.eax; "
                          "brand store listings from All the Places")
        meta["license"] = "ODbL 1.0 (OpenStreetMap facts); CC0 1.0 (All the Places facts)"
        meta["attribution"] = "© OpenStreetMap contributors; All the Places (alltheplaces.xyz)"
        meta["brand_run"] = atp_run["run_id"]
        meta["brand_collected"] = atp_run["start_time"][:10]
    with open(out_path, "w") as fh:
        json.dump({"meta": meta, "items": dict(sorted(items.items()))}, fh, separators=(",", ":"), ensure_ascii=False)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    main(*sys.argv[1:])
