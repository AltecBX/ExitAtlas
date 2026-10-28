#!/usr/bin/env python3
"""Build the rest area and service plaza dataset (restareas.json) for the route timeline.

Usage:
    build_rest_areas.py <openinterstate csv dir> <osm tags cache.json> <ntad.json> <out restareas.json> <out classes.json>

What it does:
  * Takes every OpenInterstate place in the restArea category and reads its current OpenStreetMap
    tags (fetched from the OSM API into the cache file when missing).
  * Classifies each one:
      rest     highway=rest_area beside the interstate (public rest area)
      welcome  rest area named or tagged as a welcome or visitor center
      parking  rest area named as a parking area, turnout or text stop
      plaza    unbranded highway=services run by a toll authority or named as a service plaza, or
               within 160 m of the carriageway and in the median, named with a direction, or
               listed by the FHWA survey
      travel   any other highway=services (Love's, Pilot, TA...): reached through an exit
    Weigh stations, closed and deleted objects are dropped.
  * Side of road: the nearest directional carriageway (OpenInterstate corridor edges). In the U.S. a
    facility serves the carriageway it sits to the right of, so the stored bearing is that
    carriageway's travel bearing. A facility to the left of its nearest carriageway sits in the median
    and is stored without a bearing (both directions). Checked against direction words in OSM names:
    414 of 418 agree (2026-10-28).
  * Amenities are stored only where OSM has a tag. Missing tags stay unknown, never "no".
  * Conflates the FHWA Truck Stop Parking survey (NTAD, public domain, 2019) within 1 km on the same
    interstate and side for truck space counts.

classes.json maps OSM place ids to "mainline" (shown as its own timeline row, so its exit links are
dropped) or "travel" (a travel center, shown at its exit). build_interstates.py reads it.
"""
import collections
import csv
import datetime
import json
import math
import os
import re
import subprocess
import sys
import time

csv.field_size_limit(10**9)

EARTH = 6371008.8
CELL = 0.01
MAINLINE_METERS = 400
PLAZA_METERS = 300
# An unnamed or plainly named highway=services this close to the carriageway is a mainline plaza when
# another signal agrees: it sits in the median, names a direction, or the FHWA survey lists it.
PLAZA_EVIDENCE_METERS = 160
FHWA_CONFIRM_METERS = 150
# Gas, food and chargers this close to a service plaza's point are inside it (plazas sit on the
# mainline away from other businesses; median plazas are large, so their stations can be ~300 m out).
PLAZA_POI_METERS = 300
NTAD_METERS = 1000

WEIGH = re.compile(r"weigh|inspection|enforcement|port of entry|scale house|scales\b", re.I)
WELCOME = re.compile(r"welcome|visitor|information center|tourist", re.I)
PARKING = re.compile(r"parking area|turnout|text stop|truck parking|chain[- ]?up|brake check|view ?point|scenic", re.I)
# "Travel plaza" alone is also a common private truck stop name, so it needs a toll authority operator.
PLAZA_NAME = re.compile(r"service (plaza|area)|\boasis\b", re.I)
AUTHORITY = re.compile(r"turnpike|thruway|toll|authority|parkway|tollway|commission|applegreen|hms ?host|areas usa", re.I)
TRUCK_STOP = re.compile(r"truck|flying j|pilot|love'?s|petro\b|\bTA\b|travel cent|buc-ee|sapp|road ranger|quiktrip|speedway", re.I)
CLOSED = re.compile(r"\bclosed\b", re.I)
DIRECTION_WORD = re.compile(r"\s*[-–—─(,]*\s*\b(north|south|east|west)\s*-?\s*bound\b\)?|\s*[,(]?\s*\b[NSEW]BL?\b\)?", re.I)


def xy(lon, lat, lat0):
    return math.radians(lon) * EARTH * math.cos(math.radians(lat0)), math.radians(lat) * EARTH


def bearing(ax, ay, bx, by):
    return (math.degrees(math.atan2(bx - ax, by - ay)) + 360.0) % 360.0


class Carriageways:
    """Directional interstate edges in a coarse grid for nearest segment queries."""

    def __init__(self, csv_dir):
        self.segs = []
        self.grid = collections.defaultdict(list)
        for r in csv.DictReader(open(os.path.join(csv_dir, "corridor_edges.csv"))):
            c = json.loads(r["geometry_geojson"])["coordinates"]
            for i in range(len(c) - 1):
                a, b = c[i], c[i + 1]
                sid = len(self.segs)
                self.segs.append((a, b, r["interstate_name"]))
                for gx in range(math.floor(min(a[0], b[0]) / CELL), math.floor(max(a[0], b[0]) / CELL) + 1):
                    for gy in range(math.floor(min(a[1], b[1]) / CELL), math.floor(max(a[1], b[1]) / CELL) + 1):
                        self.grid[(gx, gy)].append(sid)

    def nearest(self, lon, lat, radius):
        """Segments within radius as (meters, side 'L'/'R', bearing, interstate), nearest first."""
        gx, gy = math.floor(lon / CELL), math.floor(lat / CELL)
        seen, out = set(), []
        px, py = xy(lon, lat, lat)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for sid in self.grid.get((gx + dx, gy + dy), ()):
                    if sid in seen:
                        continue
                    seen.add(sid)
                    a, b, hw = self.segs[sid]
                    ax, ay = xy(a[0], a[1], lat)
                    bx, by = xy(b[0], b[1], lat)
                    vx, vy = bx - ax, by - ay
                    l2 = vx * vx + vy * vy
                    if l2 == 0:
                        continue
                    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / l2))
                    d = math.hypot(px - (ax + t * vx), py - (ay + t * vy))
                    if d > radius:
                        continue
                    side = "L" if vx * (py - ay) - vy * (px - ax) > 0 else "R"
                    out.append((d, side, bearing(ax, ay, bx, by), hw))
        out.sort()
        return out


def side_of_road(near):
    """Bearing of the carriageway served, or None for both directions."""
    d, side, brg, _ = near[0]
    # Undivided road: both directions share the geometry, so one of them has the facility on its left.
    for d2, side2, brg2, _ in near[1:]:
        if d2 - d > 3:
            break
        if side2 != side and abs(((brg2 - brg) + 180) % 360 - 180) > 150:
            return None
    return brg if side == "R" else None


def fetch_tags(place_ids, cache_path):
    """Current OSM tags for node/way ids via the OSM API (400 per request), cached on disk."""
    if os.path.exists(cache_path):
        return json.load(open(cache_path))
    ids = collections.defaultdict(list)
    for pid in place_ids:
        kind, num = pid.split("/")
        ids[kind].append(num)
    out = {}
    for kind, nums in ids.items():
        for k in range(0, len(nums), 400):
            url = "https://api.openstreetmap.org/api/0.6/%ss.json?%ss=%s" % (kind, kind, ",".join(nums[k:k + 400]))
            res = subprocess.run(["curl", "-fsS", "-m", "120", "-A", "ExitAtlas-data-pipeline/1.0", url],
                                 capture_output=True, text=True, check=True)
            for e in json.loads(res.stdout)["elements"]:
                out["%s/%d" % (e["type"], e["id"])] = {
                    "tags": e.get("tags", {}), "visible": e.get("visible", True),
                    "version": e.get("version"), "timestamp": e.get("timestamp")}
            time.sleep(2)
    json.dump(out, open(cache_path, "w"))
    return out


def tri(value, yes=("yes", "designated", "customers", "permissive"), no=("no",)):
    """True, False or None from an OSM tag value."""
    if value is None:
        return None
    v = value.split(";")[0].strip().lower()
    if v in yes:
        return True
    if v in no:
        return False
    return None


def amenities(t):
    a = {
        "toilets": tri(t.get("toilets")),
        "water": tri(t.get("drinking_water")),
        "picnic": tri(t.get("picnic_table")),
        "vending": None if "vending" not in t else t["vending"] != "no",
        "pets": tri(t.get("dog") or t.get("pet_area"), yes=("yes", "leashed", "designated")),
        "wifi": tri(t.get("internet_access"), yes=("wlan", "yes", "wifi", "public")),
        "dump": tri(t.get("sanitary_dump_station")),
        "shower": tri(t.get("shower")),
        "accessible": tri(t.get("toilets:wheelchair") or t.get("wheelchair"), yes=("yes", "designated")),
        "trucks": tri(t.get("hgv")),
        "info": True if t.get("tourism") == "information" or t.get("information") == "office" else None,
    }
    return {k: v for k, v in a.items() if v is not None}


def clean_name(name):
    """Drops the direction words the side-of-road check already covers ("Northbound", "(SB)")."""
    cleaned = DIRECTION_WORD.sub("", name).strip(" -–—─,")
    return re.sub(r"\s{2,}", " ", cleaned) or name


def fhwa_name(raw):
    """A usable name from the FHWA survey, or "" for generic ones ("NHS Rest Stop or Truck Facility 4")."""
    lines = [l.strip() for l in (raw or "").splitlines() if l.strip() and not re.match(r"NHS\b", l.strip())]
    name = lines[-1] if lines else ""
    if re.fullmatch(r"(rest area|welcome center|parking area)\s*#?\s*\d*", name, re.I):
        return ""
    if name.isupper():
        name = " ".join(w if re.fullmatch(r"I-?\d+|US-?\d+|[NSEW]B", w) else w.capitalize() for w in name.split())
    return clean_name(name) if name else ""


def fhwa_listed(ntad, lon, lat, meters):
    """True when the FHWA survey has a public facility (weigh stations already removed) this close."""
    x1, y1 = xy(lon, lat, lat)
    for n in ntad:
        if abs(n["lat"] - lat) < 0.003:
            x2, y2 = xy(n["lon"], n["lat"], lat)
            if math.hypot(x1 - x2, y1 - y2) <= meters:
                return True
    return False


def route_number(text):
    m = re.search(r"\bI\s*-?\s*(\d{1,3})", text or "")
    return int(m.group(1)) if m else None


def main():
    csv_dir, tags_path, ntad_path, dst, classes_dst = sys.argv[1:6]
    carriageways = Carriageways(csv_dir)

    candidates, pois = [], collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(csv_dir, "places.csv"))):
        lon, lat = json.loads(r["geometry_geojson"])["coordinates"][:2]
        if r["category"] == "restArea":
            candidates.append((r["place_id"], lon, lat))
        elif r["category"] in ("gas", "food", "evCharging"):
            pois[(math.floor(lon / CELL), math.floor(lat / CELL))].append(
                (lon, lat, r["category"], (r["brand"] or r["display_name"] or r["name"]).strip()))

    osm = fetch_tags([c[0] for c in candidates], tags_path)
    fetched_at = datetime.datetime.fromtimestamp(os.path.getmtime(tags_path), datetime.timezone.utc).date().isoformat()

    ntad = []
    for f in json.load(open(ntad_path))["features"]:
        a = f["attributes"]
        if WEIGH.search(a["nhs_rest_stop"] or "") or a["latitude"] is None:
            continue
        near = carriageways.nearest(a["longitude"], a["latitude"], NTAD_METERS)
        ntad.append({"lon": a["longitude"], "lat": a["latitude"], "spots": a["number_of_spots"],
                     "name": fhwa_name(a["nhs_rest_stop"]),
                     "route": route_number(a["highway_route"]), "id": a["OBJECTID"],
                     "bearing": side_of_road(near) if near else None})

    stats = collections.Counter()
    items, classes = [], {}
    for pid, lon, lat in candidates:
        e = osm.get(pid)
        t = e["tags"] if e else {}
        if not e or not e.get("visible", True) or not t:
            stats["deleted"] += 1
            continue
        hw = t.get("highway")
        name = (t.get("name") or t.get("official_name") or "").strip()
        lifecycle = any(k.startswith(("disused:", "abandoned:", "was:", "demolished:", "razed:")) for k in t)
        if hw not in ("rest_area", "services") or lifecycle or CLOSED.search(name) or t.get("access") == "no" \
                or t.get("opening_hours", "").strip().lower() in ("off", "closed"):
            stats["closed_or_other"] += 1
            continue
        if WEIGH.search(name):
            stats["weigh_station"] += 1
            continue
        near = carriageways.nearest(lon, lat, MAINLINE_METERS)
        brand = t.get("brand", "").strip()
        if hw == "services":
            plain = not brand and not TRUCK_STOP.search(name) and near
            plaza = plain and near[0][0] <= PLAZA_METERS and (
                AUTHORITY.search(t.get("operator", "")) or PLAZA_NAME.search(name))
            if plain and not plaza and near[0][0] <= PLAZA_EVIDENCE_METERS:
                plaza = near[0][1] == "L" or DIRECTION_WORD.search(name) or WELCOME.search(name) \
                    or fhwa_listed(ntad, lon, lat, FHWA_CONFIRM_METERS)
                stats["plaza_by_evidence"] += 1 if plaza else 0
            if not plaza:
                classes[pid] = "travel"
                stats["travel"] += 1
                continue
            kind = "welcome" if WELCOME.search(name) else "rest" if re.search(r"rest area", name, re.I) else "plaza"
        elif not near:
            stats["rest_area_off_mainline"] += 1
            continue
        elif WELCOME.search(name) or t.get("tourism") == "information":
            kind = "welcome"
        elif PARKING.search(name):
            kind = "parking"
        else:
            kind = "rest"
        classes[pid] = "mainline"
        stats[kind] += 1

        brg = side_of_road(near)
        route = route_number(near[0][3])
        item = {"id": pid, "lat": round(lat, 6), "lon": round(lon, 6), "kind": kind,
                "name": clean_name(name) if name else "", "road": near[0][3]}
        if brg is not None:
            item["bearing"] = round(brg, 1)
        else:
            stats["both_directions"] += 1
        am = amenities(t)
        if am:
            item["amenities"] = am
        hours = t.get("opening_hours", "").strip()
        if hours:
            item["hours"] = hours
        cap = t.get("capacity:hgv")
        if cap and cap.isdigit():
            item["truckSpaces"] = int(cap)
        check = t.get("check_date") or t.get("survey:date")
        if check and re.match(r"\d{4}", check):
            item["checked"] = check[:10]
        best = None
        for n in ntad:
            if abs(n["lat"] - lat) > 0.012 or n["route"] != route:
                continue
            if brg is not None and n["bearing"] is not None and abs(((n["bearing"] - brg) + 180) % 360 - 180) > 60:
                continue
            x1, y1 = xy(lon, lat, lat)
            x2, y2 = xy(n["lon"], n["lat"], lat)
            d = math.hypot(x1 - x2, y1 - y2)
            if d <= NTAD_METERS and (best is None or d < best[0]):
                best = (d, n)
        if best:
            item["fhwa"] = {"id": best[1]["id"], "truckSpaces": best[1]["spots"]}
            if not item["name"] and best[1]["name"]:
                item["name"] = best[1]["name"]
                item["nameSource"] = "fhwa"
                stats["name_from_fhwa"] += 1
                if kind in ("rest", "plaza") and WELCOME.search(item["name"]):
                    item["kind"] = "welcome"
                elif kind == "rest" and PARKING.search(item["name"]):
                    item["kind"] = "parking"
                elif kind == "plaza" and re.search(r"rest area", item["name"], re.I):
                    item["kind"] = "rest"
            stats["ntad_matched"] += 1
        if kind == "plaza":
            found = {"gas": set(), "food": set(), "ev": set()}
            gx, gy = math.floor(lon / CELL), math.floor(lat / CELL)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for plon, plat, cat, label in pois.get((gx + dx, gy + dy), ()):
                        x1, y1 = xy(lon, lat, lat)
                        x2, y2 = xy(plon, plat, lat)
                        if label and math.hypot(x1 - x2, y1 - y2) <= PLAZA_POI_METERS:
                            found["ev" if cat == "evCharging" else cat].add(label)
            for k, v in found.items():
                if v:
                    item[k] = sorted(v)
        items.append(item)
        stats["amenities_any"] += 1 if am else 0
        stats["toilets_known"] += 1 if "toilets" in am else 0

    items.sort(key=lambda i: (i["lat"], i["lon"]))
    meta = {
        "kind": "restareas", "version": 1,
        "source": "OpenStreetMap via OpenInterstate release-2026-07-13-gha-33 places, tags from the OSM API",
        "tags_fetched": fetched_at,
        "fhwa_source": "FHWA Truck Stop Parking (NTAD, Jason's Law survey, compiled 2019-04-09), public domain",
        "license": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors. Truck parking counts: FHWA (public domain).",
        "count": len(items),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
    with open(dst, "w") as fh:
        json.dump({"meta": meta, "items": items}, fh, separators=(",", ":"), ensure_ascii=False)
    with open(classes_dst, "w") as fh:
        json.dump(classes, fh, separators=(",", ":"), sort_keys=True)
    print("wrote %s: %d items" % (dst, len(items)))
    print(dict(stats))


if __name__ == "__main__":
    main()
