#!/usr/bin/env python3
"""Build foodbrands.json: chain restaurants near exits that the exit data (OpenInterstate, from OpenStreetMap) is
missing, from the chains' own store locators as collected by All the Places (CC0).

Usage:
    build_food_brands.py <interstates.eax> <freeways.eax> <All the Places dir> <run id> <out foodbrands.json>

Why: OpenInterstate links at most the 12 nearest food places within 1,600 m to an exit, and OpenStreetMap does not
map every restaurant, so a busy exit can list a Taco Bell and miss the Chick-fil-A and Wendy's next to it.

What it does, for every US feature of the chain spiders in the directory (one GeoJSON file per spider) whose
amenity is fast_food, restaurant, cafe or ice_cream:
  * finds the exits within 1,600 m (the OpenInterstate radius), keeps the nearest interchange only (exits within
    400 m of the nearest one, which covers both carriageways and the ramps of one interchange), and
  * adds it to each, unless that exit already lists the same chain (brand or name, one a prefix of the other after
    lowercasing and dropping punctuation) within 400 m, or the same chain was already added there within 150 m.

A spider file whose dataset_attributes say it was collected against the chain's robots.txt
("spider:robots_txt": "ignored") is skipped and listed in meta.skipped_robots_txt.

Output: "brands" (names), "places" ([brand index, lat, lon], each restaurant once) and "exits" (exit OSM node id to a
flat list of place index, straight line meters, nearest first). The apps show each as a food place with a straight
line round trip estimate (no drive time) and say it comes from the chain's store list. A store list is what the
chain publishes, not a visit; nothing is inferred and nothing else is added.
"""
import collections
import datetime
import json
import math
import os
import re
import struct
import sys

from eaformat import read_header

RADIUS = 1600
SAME_INTERCHANGE = 400
SAME_PLACE_OSM = 400
SAME_PLACE_ATP = 150
FOOD_AMENITIES = {"fast_food", "restaurant", "cafe", "ice_cream"}
FOOD = 2


def meters(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371008.8 * math.hypot(x, y)


def simple(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("&", "and"))


def same_chain(a, b):
    a, b = simple(a), simple(b)
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


def read_eax(path):
    """Exits (node id, lat, lon) and, per exit, its linked food places (brand or name, lat, lon)."""
    data = open(path, "rb").read()
    magic, _, _, off = read_header(data)
    assert magic == "EAX1", magic
    count, total = struct.unpack_from("<II", data, off)
    offsets = struct.unpack_from("<%dI" % (count + 1), data, off + 8)
    blob = off + 8 + 4 * (count + 1)

    def string(i):
        if i == 0xFFFFFFFF or i >= count:
            return ""
        return data[blob + offsets[i]:blob + offsets[i + 1]].decode("utf-8")

    off = blob + total
    (n_exits,) = struct.unpack_from("<I", data, off)
    off += 4
    raw_exits = [struct.unpack_from("<qiiHHIIIIHH", data, off + 40 * i) for i in range(n_exits)]
    off += 40 * n_exits
    (n_places,) = struct.unpack_from("<I", data, off)
    off += 4
    places = [struct.unpack_from("<iiIIIB3x", data, off + 24 * i) for i in range(n_places)]
    off += 24 * n_places
    (n_links,) = struct.unpack_from("<I", data, off)
    off += 4
    exits = []
    for node, lat, lon, _, _, _, _, _, start, nlinks, _ in raw_exits:
        food = []
        for k in range(start, start + nlinks):
            pi = struct.unpack_from("<IHHHBB", data, off + 12 * k)[0]
            plat, plon, name, brand, _, cat = places[pi]
            if cat == FOOD:
                food.append((string(brand) or string(name), plat / 1e7, plon / 1e7))
        exits.append((node, lat / 1e7, lon / 1e7, food))
    return exits


def features(directory, skipped):
    for fn in sorted(os.listdir(directory)):
        if not fn.endswith(".geojson"):
            continue
        doc = json.load(open(os.path.join(directory, fn)))
        # A list the spider collected against the chain's robots.txt is not used (nothing taken against a site's
        # terms), whatever its license.
        if (doc.get("dataset_attributes") or {}).get("spider:robots_txt") == "ignored":
            skipped.append(fn[:-len(".geojson")])
            continue
        for f in doc.get("features", []):
            g, p = f.get("geometry"), f.get("properties") or {}
            if not g or g.get("type") != "Point":
                continue
            lon, lat = g["coordinates"][:2]
            if not (-170 < lon < -60 and 17 < lat < 72) or p.get("addr:country") not in ("US", None):
                continue
            if p.get("amenity") not in FOOD_AMENITIES:
                continue
            brand = p.get("brand") or p.get("name")
            if not brand:
                continue
            yield brand, lat, lon


def main():
    interstates, freeways, atp_dir, run_id, out = sys.argv[1:6]
    exits = read_eax(interstates) + read_eax(freeways)
    cell = 0.02
    grid = collections.defaultdict(list)
    for i, (_, lat, lon, _) in enumerate(exits):
        grid[(int(lat // cell), int(lon // cell))].append(i)

    brands, brand_index = [], {}
    places = []
    added = collections.defaultdict(list)
    seen = 0
    per_brand = collections.Counter()
    skipped = []
    for brand, lat, lon in features(atp_dir, skipped):
        seen += 1
        cy, cx = int(lat // cell), int(lon // cell)
        near = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for i in grid.get((cy + dy, cx + dx), ()):
                    d = meters(lat, lon, exits[i][1], exits[i][2])
                    if d <= RADIUS:
                        near.append((d, i))
        if not near:
            continue
        d0 = min(d for d, _ in near)
        took = False
        for d, i in near:
            if d > d0 + SAME_INTERCHANGE:
                continue
            node, _, _, food = exits[i]
            if any(same_chain(brand, b) and meters(lat, lon, blat, blon) <= SAME_PLACE_OSM for b, blat, blon in food):
                continue
            if any(same_chain(brand, brands[places[pi][0]]) and meters(lat, lon, places[pi][1], places[pi][2]) <= SAME_PLACE_ATP for pi, _ in added[node]):
                continue
            if brand not in brand_index:
                brand_index[brand] = len(brands)
                brands.append(brand)
            if not took:
                places.append([brand_index[brand], round(lat, 5), round(lon, 5)])
            added[node].append((len(places) - 1, int(round(d))))
            took = True
        if took:
            per_brand[brand] += 1

    flat = {}
    for node, links in sorted(added.items()):
        flat[str(node)] = [x for pi, d in sorted(links, key=lambda e: e[1]) for x in (pi, d)]
    collected = run_id[:10]
    doc = {
        "kind": "foodbrands",
        "schema": 1,
        "meta": {
            "source": f"All the Places run {run_id}",
            "source_url": "https://www.alltheplaces.xyz/",
            "license": "CC0-1.0",
            "collected": collected,
            "built": datetime.date.today().isoformat(),
            "radius_m": RADIUS,
            "note": "Chain restaurants from the chains' own store locators, near exits that do not already list them. A store list, not a visit.",
            "skipped_robots_txt": skipped,
        },
        "brands": brands,
        "places": places,
        "exits": flat,
    }
    with open(out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"{seen} chain restaurants read, {len(places)} added near {len(added)} exits ({sum(len(v) for v in added.values())} exit links)")
    print("most added:", per_brand.most_common(15))
    print("skipped (collected against robots.txt):", skipped)


if __name__ == "__main__":
    main()
