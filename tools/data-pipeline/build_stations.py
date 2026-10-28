#!/usr/bin/env python3
"""Build stations.json: what OpenStreetMap says today about the gas stations in interstates.eax.

Usage:
    build_stations.py <openinterstate csv dir> <osm tags cache.json> <out stations.json>

For every OpenInterstate place in the gas category, reads the element's current tags from the OSM API
(osm_tags.py; cached, so a rerun resumes) and keeps only facts that are tagged:

  h    opening_hours as written (the station's hours; "unknown" is dropped)
  hc   the date mappers last checked them (check_date:opening_hours, else check_date)
  t    toilets: true or false, only when tagged
  b    the current brand, when it differs from the one in interstates.eax (rebranded stations)
  gone why the station should not be recommended: "deleted" (removed from OSM), "not fuel" (the
       element is no longer tagged amenity=fuel, for example a disused or converted station)

Nothing is inferred from brands or names: a station without these tags has no entry, and the apps say
the hours or restroom are unknown. The tags reflect the fetch date (meta.tags_fetched).
"""
import csv
import datetime
import json
import os
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


def main(csv_dir, cache_path, out_path):
    rows = [r for r in csv.DictReader(open(os.path.join(csv_dir, "places.csv"))) if r["category"] == "gas"]
    tags = fetch_tags([r["place_id"] for r in rows], cache_path)
    missing = set(tags.pop("_missing", []))
    items = {}
    for r in rows:
        f = facts(r, tags.get(r["place_id"]))
        if f:
            items[r["place_id"]] = f
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
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(out_path, "w") as fh:
        json.dump({"meta": meta, "items": dict(sorted(items.items()))}, fh, separators=(",", ":"), ensure_ascii=False)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
