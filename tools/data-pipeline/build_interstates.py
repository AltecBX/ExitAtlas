#!/usr/bin/env python3
"""Build the EAX1 interstate exit + services dataset from an OpenInterstate release.

Usage:
    build_interstates.py <openinterstate csv dir> <reachability.csv> <out.eax> <source.json>

What it does:
  * Collapses OpenInterstate exit rows to one record per physical OSM exit node.
    Rows like node/123:4AB are aliases of node/123 (same point, combined label).
    A node can appear on several corridors (concurrencies, noisy corridor assignment),
    so corridor membership is stored only as a weak hint (highways string).
  * Computes the carriageway travel bearing at each exit node from corridor_edges
    geometry. Directional matching on the app side depends on this bearing: an exit
    node on the opposite carriageway has a bearing about 180 degrees off the route.
  * Keeps only places that are linked to at least one exit, and stores the
    straight-line distance plus the OSRM drive distance/duration from the
    reachability release when available.

EAX1 layout after the common header:
    string table
    u32 exitCount,  exitCount  * 40-byte records '<qiiHHIIIIHH'
        osmNodeId, lat, lon, bearing1*10, bearing2*10, label, name, highways, linkStart, linkCount, reserved
    u32 placeCount, placeCount * 24-byte records '<iiIIIB3x'
        lat, lon, name, brand, osmId, category
    u32 linkCount,  linkCount  * 12-byte records '<IHHHBB'
        placeIndex, straightMeters, driveMeters, driveSeconds, rank, flags
        flags bit0: drive data present, bit1: reachable
"""
import collections
import csv
import datetime
import json
import math
import os
import re
import struct
import sys

from eaformat import NONE16, NONE32, StringTable, e7, header

csv.field_size_limit(10**9)

CATEGORIES = {
    "gas": 1, "food": 2, "lodging": 3, "restArea": 4, "evCharging": 5, "park": 6, "dogPark": 7,
}

# Cyrillic and Greek lookalikes seen in OSM refs (for example a Cyrillic A in "8A").
LOOKALIKES = str.maketrans("АВСЕНКМОРТХавсеокмрстхΑΒΕΗΚΜΝΟΡΤΧ", "ABCEHKMOPTXabceokmpctxABEHKMNOPTX")


def base_id(exit_id):
    return exit_id.split(":", 1)[0]


def norm_label(label):
    label = (label or "").translate(LOOKALIKES).strip().upper()
    return re.sub(r"\s+", " ", label)


def display_label(base_label, alias_labels):
    """Prefer a combined alias ('4AB') when it extends the base label, shown as '4A-B'."""
    for alias in sorted(alias_labels, key=len, reverse=True):
        m = re.fullmatch(r"(\d+)([A-Z])([A-Z]+)", alias)
        if m and (not base_label or base_label.startswith(m.group(1))):
            return "%s%s-%s" % (m.group(1), m.group(2), m.group(3)[-1])
    if base_label:
        return base_label
    return alias_labels[0] if alias_labels else ""


def bearing(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angle_diff(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def key(lon, lat):
    return (int(round(lon * 1e7)), int(round(lat * 1e7)))


def main():
    csv_dir, reach_path, dst, source_json = sys.argv[1:5]
    source = json.load(open(source_json))

    # 1. Exits collapsed to physical nodes.
    nodes = collections.OrderedDict()
    for r in csv.DictReader(open(os.path.join(csv_dir, "corridor_exits.csv"))):
        b = base_id(r["exit_id"])
        n = nodes.setdefault(b, {
            "lat": float(r["lat"]), "lon": float(r["lon"]), "base_label": None,
            "aliases": set(), "names": collections.Counter(), "highways": set(),
        })
        label = norm_label(r["exit_number"])
        if ":" in r["exit_id"]:
            if label:
                n["aliases"].add(label)
        elif label:
            n["base_label"] = label
        if r["exit_name"].strip():
            n["names"][r["exit_name"].strip()] += 1
        n["highways"].add(r["interstate_name"])

    # 2. Carriageway bearings at exit nodes from directional corridor edges.
    wanted = {key(n["lon"], n["lat"]): b for b, n in nodes.items()}
    bearings = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(csv_dir, "corridor_edges.csv"))):
        coords = json.loads(r["geometry_geojson"])["coordinates"]
        for i, c in enumerate(coords):
            k = key(c[0], c[1])
            if k not in wanted:
                continue
            a = coords[i - 1] if i > 0 else c
            z = coords[i + 1] if i + 1 < len(coords) else c
            if a == z:
                continue
            bearings[wanted[k]].append(bearing(a[0], a[1], z[0], z[1]))
    for b, values in bearings.items():
        distinct = []
        for v in values:
            if all(angle_diff(v, d) > 20.0 for d in distinct):
                distinct.append(v)
        nodes[b]["bearings"] = distinct[:2]

    # 3. Links, deduplicated per (physical exit, place).
    links = collections.defaultdict(dict)
    for r in csv.DictReader(open(os.path.join(csv_dir, "exit_place_links.csv"))):
        b = base_id(r["exit_id"])
        if b not in nodes:
            continue
        prev = links[b].get(r["place_id"])
        cur = (float(r["distance_m"]), int(r["rank"]))
        if prev is None or cur < prev:
            links[b][r["place_id"]] = cur

    # 4. Drive distance and time from the reachability release (exit -> place, one way).
    reach = {}
    if reach_path != "-":
        for r in csv.DictReader(open(reach_path)):
            k = (base_id(r["exit_id"]), r["place_id"])
            if r["reachable"] == "t" and r["route_distance_m"] and r["route_duration_s"]:
                reach[k] = (int(float(r["route_distance_m"])), int(float(r["route_duration_s"])), True)
            elif k not in reach:
                reach[k] = (None, None, r["reachable"] == "t")

    # 5. Places that are linked to at least one exit.
    linked_places = {p for d in links.values() for p in d}
    places = {}
    for r in csv.DictReader(open(os.path.join(csv_dir, "places.csv"))):
        if r["place_id"] not in linked_places:
            continue
        lon, lat = json.loads(r["geometry_geojson"])["coordinates"][:2]
        places[r["place_id"]] = {
            "lat": lat, "lon": lon, "category": CATEGORIES.get(r["category"], 0),
            "name": (r["display_name"] or r["name"]).strip(), "brand": r["brand"].strip(),
        }
    place_ids = sorted(places)
    place_index = {p: i for i, p in enumerate(place_ids)}

    strings = StringTable()
    exit_records = bytearray()
    link_records = bytearray()
    link_count = 0
    stats = collections.Counter()
    ordered = sorted(nodes.items(), key=lambda kv: (kv[1]["lat"], kv[1]["lon"]))
    for b, n in ordered:
        label = display_label(n["base_label"], sorted(n["aliases"]))
        name = n["names"].most_common(1)[0][0] if n["names"] else ""
        bs = n.get("bearings", [])
        stats["bearing_%d" % len(bs)] += 1
        b1 = int(round(bs[0] * 10)) % 3600 if len(bs) > 0 else NONE16
        b2 = int(round(bs[1] * 10)) % 3600 if len(bs) > 1 else NONE16
        start = link_count
        node_links = sorted(links.get(b, {}).items(), key=lambda kv: (kv[1][1], kv[1][0]))
        for pid, (dist, rank) in node_links:
            if pid not in place_index:
                stats["link_missing_place"] += 1
                continue
            drive_m, drive_s, reachable = reach.get((b, pid), (None, None, None))
            flags = 0
            if drive_m is not None:
                flags |= 1
            if reachable:
                flags |= 2
            link_records += struct.pack(
                "<IHHHBB", place_index[pid], min(int(round(dist)), 65534),
                min(drive_m, 65534) if drive_m is not None else NONE16,
                min(drive_s, 65534) if drive_s is not None else NONE16,
                min(rank, 255), flags)
            link_count += 1
        node_id = int(b.split("/", 1)[1]) if b.startswith("node/") else 0
        exit_records += struct.pack(
            "<qiiHHIIIIHH", node_id, e7(n["lat"]), e7(n["lon"]), b1, b2,
            strings.ref(label), strings.ref(name), strings.ref(";".join(sorted(n["highways"]))),
            start, min(link_count - start, 65535), 0)

    place_records = bytearray()
    for pid in place_ids:
        p = places[pid]
        place_records += struct.pack(
            "<iiIIIB3x", e7(p["lat"]), e7(p["lon"]), strings.ref(p["name"]),
            strings.ref(p["brand"]), strings.ref(pid), p["category"])

    metadata = dict(source)
    metadata.update({
        "kind": "interstates",
        "exits": len(ordered), "places": len(place_ids), "links": link_count,
        "exits_with_bearing": len(ordered) - stats["bearing_0"],
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    })
    with open(dst, "wb") as fh:
        fh.write(header("EAX1", 1, metadata))
        fh.write(strings.encode())
        fh.write(struct.pack("<I", len(ordered)))
        fh.write(exit_records)
        fh.write(struct.pack("<I", len(place_ids)))
        fh.write(place_records)
        fh.write(struct.pack("<I", link_count))
        fh.write(link_records)
    print("wrote %s: %d exits, %d places, %d links" % (dst, len(ordered), len(place_ids), link_count))
    print(dict(stats))


if __name__ == "__main__":
    main()
