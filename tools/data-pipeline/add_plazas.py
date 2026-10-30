#!/usr/bin/env python3
"""Add the toll road service plazas listed in plazas_supplement.json to restareas.json.

Usage:
    add_plazas.py <restareas.json, updated in place> <plazas_supplement.json> <cache dir>

Runs after build_rest_areas.py. For each listed OpenStreetMap object it reads, from the OSM API (cached in
the cache dir, so a rebuild is repeatable):
  * the object's current tags and geometry (its point: the mean of its nodes),
  * everything mapped within about 450 m (the API's map call): the fuel stations, food and chargers within
    300 m of the point (PLAZA_POI_METERS, as for other plazas), and the motorway carriageways, for the side
    of the road it serves (the same rule as build_rest_areas.py: the carriageway it sits to the right of, or
    both directions from the median).
A plaza already in restareas.json keeps everything it has; the fuel, food and chargers found are added, and
it becomes a plaza when fuel is found. A missing one is added with the fields build_rest_areas.py writes.
Amenities, hours and restrooms are only what its own tags say; missing tags stay unknown. Every entry added or
changed records "via": "plazas_supplement" and the date the tags were fetched.
"""
import datetime
import json
import math
import os
import re
import subprocess
import sys
import time

from build_rest_areas import PLAZA_POI_METERS, WELCOME, amenities, bearing, clean_name, side_of_road, xy

API = "https://api.openstreetmap.org/api/0.6"
MAINLINE_METERS = 400
BOX = 0.0045  # degrees around the point for the map call (about 500 m north to south)
FOOD = ("fast_food", "restaurant", "food_court", "cafe")


def get(url, path):
    if not os.path.exists(path):
        res = subprocess.run(["curl", "-fsS", "-m", "120", "-A", "ExitAtlas-data-pipeline/1.0", url],
                             capture_output=True, text=True, check=True)
        with open(path, "w") as fh:
            fh.write(res.stdout)
        time.sleep(2)
    with open(path) as fh:
        return json.load(fh)["elements"]


def point(element, nodes):
    if element["type"] == "node":
        return element["lon"], element["lat"]
    refs = element.get("nodes", [])
    if len(refs) > 1 and refs[0] == refs[-1]:
        refs = refs[:-1]
    pts = [nodes[r] for r in refs if r in nodes]
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def meters(a, b, lat):
    ax, ay = xy(a[0], a[1], lat)
    bx, by = xy(b[0], b[1], lat)
    return math.hypot(ax - bx, ay - by)


def carriageways(lon, lat, elements, nodes):
    """Motorway segments within MAINLINE_METERS as (meters, side, bearing, ref), nearest first."""
    px, py = xy(lon, lat, lat)
    out = []
    for e in elements:
        t = e.get("tags", {})
        if e["type"] != "way" or t.get("highway") != "motorway":
            continue
        refs = e.get("nodes", [])
        if t.get("oneway") == "-1":
            refs = refs[::-1]
        for a, b in zip(refs, refs[1:]):
            if a not in nodes or b not in nodes:
                continue
            ax, ay = xy(nodes[a][0], nodes[a][1], lat)
            bx, by = xy(nodes[b][0], nodes[b][1], lat)
            vx, vy = bx - ax, by - ay
            l2 = vx * vx + vy * vy
            if l2 == 0:
                continue
            k = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / l2))
            d = math.hypot(px - (ax + k * vx), py - (ay + k * vy))
            if d <= MAINLINE_METERS:
                side = "L" if vx * (py - ay) - vy * (px - ax) > 0 else "R"
                out.append((d, side, bearing(ax, ay, bx, by), t.get("ref", "")))
    out.sort()
    return out


def road_name(ref):
    refs = [r.strip() for r in ref.split(";") if r.strip()]
    for r in refs:
        m = re.fullmatch(r"I\s*-?\s*(\d+)", r)
        if m:
            return "I-%s" % m.group(1)
    return "New Jersey Turnpike" if "NJTP" in refs else (refs[0] if refs else "")


def main():
    dst, supplement_path, cache = sys.argv[1:4]
    os.makedirs(cache, exist_ok=True)
    data = json.load(open(dst))
    items = {i["id"]: i for i in data["items"]}
    listed = json.load(open(supplement_path))["facilities"]
    fetched = None
    added = changed = 0
    for f in listed:
        kind, num = f["osm"].split("/")
        full = get("%s/%s/%s%s.json" % (API, kind, num, "" if kind == "node" else "/full"),
                   os.path.join(cache, "%s_%s.json" % (kind, num)))
        fetched = fetched or datetime.datetime.fromtimestamp(
            os.path.getmtime(os.path.join(cache, "%s_%s.json" % (kind, num))), datetime.timezone.utc).date().isoformat()
        nodes = {e["id"]: (e["lon"], e["lat"]) for e in full if e["type"] == "node"}
        me = next(e for e in full if e["type"] == kind and e["id"] == int(num))
        lon, lat = point(me, nodes)
        bbox = "%.5f,%.5f,%.5f,%.5f" % (lon - BOX * 1.3, lat - BOX, lon + BOX * 1.3, lat + BOX)
        around = get("%s/map.json?bbox=%s" % (API, bbox), os.path.join(cache, "map_%s_%s.json" % (kind, num)))
        nodes.update({e["id"]: (e["lon"], e["lat"]) for e in around if e["type"] == "node"})
        found = {"gas": set(), "food": set(), "ev": set()}
        for e in around:
            t = e.get("tags", {})
            a = t.get("amenity")
            key = "gas" if a == "fuel" else "ev" if a == "charging_station" else "food" if a in FOOD else None
            if not key:
                continue
            label = (t.get("brand") or t.get("name") or (t.get("operator") if key == "ev" else "") or "").strip()
            p = point(e, nodes)
            if label and p and meters(p, (lon, lat), lat) <= PLAZA_POI_METERS:
                found[key].add(label)
        t = me.get("tags", {})
        item = items.get(f["osm"])
        near = carriageways(lon, lat, around, nodes)
        new = item is None
        if new:
            name = (t.get("name") or t.get("official_name") or "").strip()
            item = {"id": f["osm"], "lat": round(lat, 6), "lon": round(lon, 6),
                    "kind": "plaza" if found["gas"] else "welcome" if WELCOME.search(name) else "rest",
                    "name": clean_name(name) if name else "", "road": road_name(near[0][3]) if near else f["road"]}
            brg = side_of_road(near) if near else None
            if brg is not None:
                item["bearing"] = round(brg, 1)
            am = amenities(t)
            if am:
                item["amenities"] = am
            hours = t.get("opening_hours", "").strip()
            if hours:
                item["hours"] = hours
            check = t.get("check_date") or t.get("survey:date")
            if check and re.match(r"\d{4}", check):
                item["checked"] = check[:10]
            data["items"].append(item)
            items[f["osm"]] = item
        before = json.dumps(item, sort_keys=True)
        if found["gas"] and item["kind"] in ("rest", "plaza"):
            item["kind"] = "plaza"
        for k, v in found.items():
            if v and not item.get(k):
                item[k] = sorted(v)
        side = side_of_road(near) if near else None
        # build_rest_areas.py takes the side from the nearest OpenInterstate corridor, which is another road where
        # the toll road is not an interstate (Walt Whitman was put on I-295 northbound): the toll road's own
        # carriageway decides when the two disagree on the direction served.
        old = item.get("bearing")
        if near and ((old is None) != (side is None) or (old is not None and abs(((side - old) + 180) % 360 - 180) > 60)):
            item.pop("bearing", None)
            if side is not None:
                item["bearing"] = round(side, 1)
            item["road"] = road_name(near[0][3])
        status = "added" if new else "updated" if json.dumps(item, sort_keys=True) != before else "unchanged"
        print("%-9s %-16s %-34s %-6s bearing=%s (OSM carriageway: %s) gas=%s" % (
            status, f["osm"], item["name"], item["kind"], item.get("bearing"), None if side is None else round(side, 1), item.get("gas")))
        if status == "unchanged":
            continue
        added += new
        changed += not new
        item["via"] = "plazas_supplement"
        item["fetched"] = fetched
    data["items"].sort(key=lambda i: (i["lat"], i["lon"]))
    meta = data["meta"]
    meta["supplement"] = ("Toll road service plazas from tools/data-pipeline/plazas_supplement.json: tags, geometry and "
                          "the fuel, food and chargers around them from the OSM API, fetched %s (entries marked via)" % fetched)
    meta["count"] = len(data["items"])
    with open(dst, "w") as fh:
        json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
    print("restareas.json: %d added, %d updated, %d items" % (added, changed, len(data["items"])))


if __name__ == "__main__":
    main()
