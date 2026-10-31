#!/usr/bin/env python3
"""Extract the exits of non Interstate freeways, and the places near them, from an OpenStreetMap extract.

Usage:
    extract_freeways.py <region.osm.pbf> <out.json>

Needs pyosmium (pip install osmium). Standalone (no imports from this folder), so it can run with python3 -I
on a downloaded extract. Reads the extract twice:
  1. tagged objects: highway=motorway_junction nodes; highway=motorway and highway=trunk ways (the
     carriageways) that hold a junction; the motorway_link and trunk_link ramps that leave a junction; and the
     places in OpenInterstate's categories (classify_poi below is OpenInterstate's own rule, from
     schema/osm2pgsql/openinterstate.lua, so the services match the interstate data).
  2. the locations of the untagged nodes it needs: each junction's neighbors on its carriageway (for the
     travel bearing) and the outlines of places mapped as areas (for their center).
Writes every junction that sits on a motorway or trunk carriageway that is not an Interstate (no ref or
int_ref of the form "I 95" on any carriageway through it): its location, its exit number and name tags, the
destination tags of the ramp that leaves it, the carriageways' names and refs, and their travel bearings (both
directions on a two way road). Then every named place within 1.6 km of one of those junctions.
"""
import array
import json
import math
import re
import sys

import osmium

PLACE_RADIUS = 1600.0
CELL = 0.02
EARTH = 6371008.8
# An Interstate ref, alone or with words for its direction or its toll and express lanes ("I 75 Toll", "I 95 EXPR");
# business loops ("I 81 BUS") are other roads.
INTERSTATE = re.compile(r"^I[\s-]*\d+[A-Z]?(?!\s+(BUS|Business|BL)\b)(\s.*)?$", re.I)
INTERSTATE_NAME = re.compile(r"^(I|Interstate)[\s-]*\d+\b", re.I)
JUNCTION_TAGS = ("ref", "junction:ref", "noref", "name", "exit:name", "exit_to", "destination", "destination:ref")
LINK_TAGS = ("destination", "destination:ref", "destination:street", "junction:ref", "exit_to")
ROAD_TAGS = ("highway", "ref", "int_ref", "name", "oneway", "official_name", "alt_name")
PLACE_KEYS = ("amenity", "tourism", "leisure", "shop", "cuisine")


def classify_poi(tags):
    """OpenInterstate's category for a tagged object, or None (schema/osm2pgsql/openinterstate.lua)."""
    amenity, tourism, highway = tags.get("amenity", ""), tags.get("tourism", ""), tags.get("highway", "")
    shop, leisure = tags.get("shop", ""), tags.get("leisure", "")
    if amenity == "fuel" or shop == "gas":
        return "gas"
    if tourism in ("hotel", "motel", "guest_house"):
        return "lodging"
    if amenity in ("restaurant", "fast_food", "cafe") or "cuisine" in tags:
        return "food"
    if highway in ("rest_area", "services"):
        return "restArea"
    if amenity == "toilets":
        return "restroom"
    if amenity == "charging_station":
        return "evCharging"
    if leisure == "dog_park":
        return "dogPark"
    if leisure == "park":
        return "park" if "park" in tags.get("name", "").lower() else None
    return None


def is_interstate(tags):
    for key in ("ref", "int_ref"):
        for token in tags.get(key, "").split(";"):
            if INTERSTATE.match(token.strip()):
                return True
    return bool(INTERSTATE_NAME.match(tags.get("name", "")))


def bearing(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def meters(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return EARTH * math.hypot(x, y)


def centroid(points):
    """Area centroid of a closed outline (lat, lon), else the mean of its points."""
    if len(points) >= 4 and points[0] == points[-1]:
        a = cx = cy = 0.0
        lat0, lon0 = points[0]
        for (la1, lo1), (la2, lo2) in zip(points, points[1:]):
            x1, y1, x2, y2 = lo1 - lon0, la1 - lat0, lo2 - lon0, la2 - lat0
            cross = x1 * y2 - x2 * y1
            a += cross
            cx += (x1 + x2) * cross
            cy += (y1 + y2) * cross
        if abs(a) > 1e-14:
            return lat0 + cy / (3 * a), lon0 + cx / (3 * a)
        points = points[:-1]
    return sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)


def tag_dict(obj, keys=None):
    if keys is None:
        return {t.k: t.v for t in obj.tags}
    return {k: obj.tags[k] for k in keys if k in obj.tags}


def oneway_of(tags):
    """1 forward, -1 reversed, 0 both ways. Motorways are one way unless tagged otherwise (as in OSRM)."""
    v = tags.get("oneway", "")
    if v in ("yes", "true", "1"):
        return 1
    if v in ("-1", "reverse"):
        return -1
    if v == "no":
        return 0
    return 1 if tags.get("highway") == "motorway" else 0


def main():
    src, dst = sys.argv[1:3]
    header = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING).header()
    timestamp = header.get("osmosis_replication_timestamp") or header.get("timestamp") or ""

    junctions = {}       # node id -> {lat, lon, tags}
    poi_nodes = []       # (id, lat, lon, category, tags)
    poi_ways = []        # (id, category, tags, node refs)
    carriageways = {}    # way id -> (tags, [(index in way, prev id, node id, next id)])
    links = []           # (junction id, tags)
    keys = osmium.filter.KeyFilter("highway", *PLACE_KEYS)
    fp = osmium.FileProcessor(src, osmium.osm.NODE | osmium.osm.WAY).with_filter(keys)

    def maybe_place(tags, hw):
        return hw in ("rest_area", "services") or any(k in tags for k in PLACE_KEYS)

    for obj in fp:
        tags = obj.tags
        hw = tags.get("highway", "")
        if obj.is_node():
            if hw == "motorway_junction":
                junctions[obj.id] = {"lat": obj.location.lat, "lon": obj.location.lon,
                                     "tags": tag_dict(obj, JUNCTION_TAGS)}
            if maybe_place(tags, hw):
                t = tag_dict(obj)
                cat = classify_poi(t)
                if cat and cat != "restroom":
                    poi_nodes.append((obj.id, obj.location.lat, obj.location.lon, cat, t))
            continue
        if hw in ("motorway", "trunk"):
            refs = [n.ref for n in obj.nodes]
            hits = [(i, refs[i - 1] if i > 0 else None, r, refs[i + 1] if i + 1 < len(refs) else None)
                    for i, r in enumerate(refs) if r in junctions]
            if hits:
                carriageways[obj.id] = (tag_dict(obj, ROAD_TAGS), hits)
        elif hw in ("motorway_link", "trunk_link"):
            t = tag_dict(obj, ROAD_TAGS + LINK_TAGS)
            # The ramp leaves the junction at its first node (its last when drawn against its one way direction).
            first = obj.nodes[len(obj.nodes) - 1 if t.get("oneway") in ("-1", "reverse") else 0].ref
            if first in junctions:
                links.append((first, t))
        if maybe_place(tags, hw):
            t = tag_dict(obj)
            cat = classify_poi(t)
            if cat and cat != "restroom" and len(obj.nodes) > 0:
                poi_ways.append((obj.id, cat, t, array.array("q", (n.ref for n in obj.nodes))))
    print("pass 1: %d junctions, %d carriageway ways with one, %d ramps, %d place nodes, %d place ways"
          % (len(junctions), len(carriageways), len(links), len(poi_nodes), len(poi_ways)), file=sys.stderr)

    # Junctions on a carriageway, and whether any carriageway through them is an Interstate.
    on_road = {}
    for wid, (tags, hits) in carriageways.items():
        for _, prev, node, nxt in hits:
            on_road.setdefault(node, []).append((wid, prev, nxt))
    interstate = {n for n, occ in on_road.items() if any(is_interstate(carriageways[w][0]) for w, _, _ in occ)}
    kept = {n for n in on_road if n not in interstate}

    needed = set()
    for n in kept:
        for _, prev, nxt in on_road[n]:
            needed.update(x for x in (prev, nxt) if x is not None)
    for _, _, _, refs in poi_ways:
        needed.update(refs)
    locations = {n: (j["lat"], j["lon"]) for n, j in junctions.items()}
    for obj in osmium.FileProcessor(src, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(needed)):
        locations[obj.id] = (obj.location.lat, obj.location.lon)
    print("pass 2: %d of %d node locations" % (len(locations) - len(junctions), len(needed)), file=sys.stderr)

    ramps = {}
    for node, tags in links:
        if node in kept:
            ramps.setdefault(node, []).append(tags)
    out_junctions = []
    for n in sorted(kept):
        j = junctions[n]
        bearings, roads = [], []
        for wid, prev, nxt in on_road[n]:
            tags = carriageways[wid][0]
            road = {k: v for k, v in tags.items() if k != "oneway"}
            if road not in roads:
                roads.append(road)
            a = locations.get(prev, (j["lat"], j["lon"])) if prev is not None else (j["lat"], j["lon"])
            z = locations.get(nxt, (j["lat"], j["lon"])) if nxt is not None else (j["lat"], j["lon"])
            if a == z:
                continue
            b = bearing(a[1], a[0], z[1], z[0])
            way = oneway_of(tags)
            bearings += [b] if way == 1 else [(b + 180.0) % 360.0] if way == -1 else [b, (b + 180.0) % 360.0]
        out_junctions.append({"id": n, "lat": round(j["lat"], 7), "lon": round(j["lon"], 7), "tags": j["tags"],
                              "bearings": [round(b, 2) for b in bearings], "roads": roads,
                              "ramps": ramps.get(n, [])})

    cells = set()
    for j in out_junctions:
        cy, cx = int(math.floor(j["lat"] / CELL)), int(math.floor(j["lon"] / CELL))
        for dy in (-1, 0, 1):
            for dx in (-2, -1, 0, 1, 2):
                cells.add((cy + dy, cx + dx))
    near = {}
    for j in out_junctions:
        near.setdefault((int(math.floor(j["lat"] / CELL)), int(math.floor(j["lon"] / CELL))), []).append(j)

    def close(lat, lon):
        cy, cx = int(math.floor(lat / CELL)), int(math.floor(lon / CELL))
        if (cy, cx) not in cells:
            return False
        for dy in (-1, 0, 1):
            for dx in (-2, -1, 0, 1, 2):
                for j in near.get((cy + dy, cx + dx), ()):
                    if meters(lat, lon, j["lat"], j["lon"]) <= PLACE_RADIUS:
                        return True
        return False

    places = []
    keep_tags = ("name", "brand", "highway", "operator", "amenity", "shop", "tourism", "leisure")
    for pid, lat, lon, cat, tags in poi_nodes:
        if close(lat, lon):
            places.append({"id": "node/%d" % pid, "lat": round(lat, 7), "lon": round(lon, 7), "category": cat,
                           "tags": {k: tags[k] for k in keep_tags if k in tags}})
    for wid, cat, tags, refs in poi_ways:
        pts = [locations[r] for r in refs if r in locations]
        if not pts:
            continue
        lat, lon = centroid(pts)
        if close(lat, lon):
            places.append({"id": "way/%d" % wid, "lat": round(lat, 7), "lon": round(lon, 7), "category": cat,
                           "tags": {k: tags[k] for k in keep_tags if k in tags}})
    with open(dst, "w") as fh:
        json.dump({"extract": src.rsplit("/", 1)[-1], "osm_timestamp": timestamp,
                   "junctions": out_junctions, "places": places,
                   "stats": {"junctions_all": len(junctions), "on_carriageway": len(on_road),
                             "on_interstate": len(interstate), "kept": len(out_junctions), "places": len(places)}},
                  fh, separators=(",", ":"))
    print("wrote %s: %d junctions (%d on Interstates left out), %d places"
          % (dst, len(out_junctions), len(interstate), len(places)), file=sys.stderr)


if __name__ == "__main__":
    main()
