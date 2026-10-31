#!/usr/bin/env python3
"""Build freeways.eax: exits and services on freeways that are not Interstates (parkways, expressways,
turnpikes, US and state routes built as freeways), from the files extract_freeways.py wrote.

Usage:
    build_freeways.py <interstates.eax> <corridors.eac> <out freeways.eax> <freeways_source.json> <region.json>...

Same EAX1 layout as interstates.eax (see build_interstates.py), so the app reads both the same way:
  * One exit per OSM highway=motorway_junction node on a motorway or trunk carriageway that is not an
    Interstate. Junctions already in interstates.eax are left out, so the Interstate data stays as it is, and
    so are junctions on an interstate corridor (corridors.eac: within 15 m of one, going its way), which are
    interstate junctions whose way lacks the ref. A junction found in two overlapping extracts is kept once.
  * Exit number: the junction's ref (or junction:ref, else the ramp's junction:ref); none when noref=yes.
    Name: the junction's name (or exit:name), else exit_to, else the ramp's destination:ref and destination,
    as OSM has them. A junction with neither a number nor a name is left out (as OpenInterstate leaves out
    unnumbered interstate junctions), and so is one that leads only to a service area or rest area (no
    number, named as one): those are not exits, and the route shows them as rest areas.
  * Bearings: the carriageway's travel bearing at the junction from OSM way geometry (both directions on a
    two way road), distinct ones only, at most two, as in build_interstates.py.
  * highways: the carriageway's first numbered ref ("US-9") and its name ("Taconic State Parkway"). Letter
    only refs ("GSP", "SO") abbreviate the name and are left out.
  * Services: OpenInterstate's rule (schema/derive.sql), so they rank like the interstate data: places in a
    category, nearest first by straight line from the junction, up to 12 per category, within 800 m (1.6 km
    for parks and dog parks), named unless a rest area, park or dog park. A place's name is its brand, else
    its name. Rest areas are left out (on the mainline they are their own rows); a highway=services truck
    stop is a travel center, as build_rest_areas.py classes them. Links carry the straight line distance
    and no drive data (flags 0), so the app estimates the detour and marks it as such.
"""
import collections
import datetime
import json
import math
import re
import struct
import sys

from eaformat import NONE16, StringTable, e7, header, read_eac_parts, read_eax_exit_node_ids
from build_rest_areas import AUTHORITY, PLAZA_NAME, TRUCK_STOP
from extract_freeways import is_interstate

CATEGORIES = {
    "gas": 1, "food": 2, "lodging": 3, "restArea": 4, "evCharging": 5, "park": 6, "dogPark": 7,
    "travelCenter": 8,
}
MAX_RANK = 12
PLACE_METERS = 800
PARK_METERS = 1600
CELL = 0.02
EARTH = 6371008.8
# Cyrillic and Greek lookalikes seen in OSM refs, as in build_interstates.py.
LOOKALIKES = str.maketrans("АВСЕНКМОРТХавсеокмрстхΑΒΕΗΚΜΝΟΡΤΧ",
                           "ABCEHKMOPTXabceokmpctxABEHKMNOPTX")
NOT_AN_EXIT = re.compile(r"service (area|plaza)|travel plaza|rest area|text stop|parking area|welcome center|"
                         r"weigh station|toll plaza|inspection|police|troop|maintenance|authorized|emergency|"
                         r"(express|local) (roadway|lanes)", re.I)
# "Garden State Parkway Southbound", "Cross County Parkway (express lanes)": the road's name without them.
NAME_EXTRA = re.compile(r"\s*\([^)]*\)|\s+(north|south|east|west)bound$", re.I)
MAX_NAME_PARTS = 4
CORRIDOR_METERS = 15
CORRIDOR_DEGREES = 30


def angle_diff(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def meters(lat1, lon1, lat2, lon2):
    """Great circle distance (haversine), as PostGIS geography distances in OpenInterstate."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH * math.asin(math.sqrt(h))


def norm_label(label):
    label = (label or "").translate(LOOKALIKES).strip().upper()
    label = re.sub(r"^EXIT\s+", "", label)
    label = re.sub(r"\s*;\s*", "/", label)
    return re.sub(r"\s+", " ", label)


def parts(value):
    return [p.strip() for p in (value or "").split(";") if p.strip()]


def exit_label(j):
    t = j["tags"]
    if t.get("noref") == "yes":
        return ""
    label = norm_label(t.get("ref") or t.get("junction:ref"))
    if not label:
        refs = {norm_label(r.get("junction:ref")) for r in j["ramps"] if r.get("junction:ref")}
        if len(refs) == 1:
            label = refs.pop()
    return label


def exit_name(j):
    t = j["tags"]
    for key in ("name", "exit:name", "exit_to"):
        if t.get(key, "").strip():
            names = parts(t[key])
            break
    else:
        names = parts(t.get("destination:ref")) + parts(t.get("destination"))
        for ramp in j["ramps"]:
            names += parts(ramp.get("destination:ref"))
            names += parts(ramp.get("destination")) or parts(ramp.get("destination:street"))
    out = []
    for n in names:
        if n not in out:
            out.append(n)
    return ";".join(out[:MAX_NAME_PARTS])


class Corridors:
    """Interstate corridor segments in a grid, to find junctions that sit on an interstate carriageway."""

    def __init__(self, path):
        self.cells = collections.defaultdict(list)
        for _, _, pts in read_eac_parts(path):
            for (la1, lo1), (la2, lo2) in zip(pts, pts[1:]):
                seg = (la1, lo1, la2, lo2)
                for cy in range(int(math.floor(min(la1, la2) / CELL)), int(math.floor(max(la1, la2) / CELL)) + 1):
                    for cx in range(int(math.floor(min(lo1, lo2) / CELL)), int(math.floor(max(lo1, lo2) / CELL)) + 1):
                        self.cells[(cy, cx)].append(seg)

    def on_corridor(self, lat, lon, bearings):
        k = math.cos(math.radians(lat)) * math.pi / 180 * EARTH
        m = math.pi / 180 * EARTH
        cy, cx = int(math.floor(lat / CELL)), int(math.floor(lon / CELL))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for la1, lo1, la2, lo2 in self.cells.get((cy + dy, cx + dx), ()):
                    ax, ay, bx, by = (lo1 - lon) * k, (la1 - lat) * m, (lo2 - lon) * k, (la2 - lat) * m
                    vx, vy = bx - ax, by - ay
                    l2 = vx * vx + vy * vy
                    if l2 == 0:
                        continue
                    t = max(0.0, min(1.0, -(ax * vx + ay * vy) / l2))
                    if math.hypot(ax + t * vx, ay + t * vy) > CORRIDOR_METERS:
                        continue
                    seg = (math.degrees(math.atan2(vx, vy)) + 360.0) % 360.0
                    if any(angle_diff(b, seg) <= CORRIDOR_DEGREES for b in bearings):
                        return True
        return False


def ref_label(ref):
    """'US 9' -> 'US-9', 'NY 9A' -> 'NY-9A', as the app writes highway refs; other refs as given."""
    m = re.fullmatch(r"([A-Z]{1,3})[\s-]+(\d+[A-Z]?)(.*)", ref.strip())
    return "%s-%s%s" % (m.group(1), m.group(2), m.group(3)) if m else ref.strip()


def highways(j):
    out = []
    for road in j["roads"]:
        refs = [r for r in parts(road.get("ref")) if re.search(r"\d", r)]
        for value in ([ref_label(refs[0])] if refs else []) + [NAME_EXTRA.sub("", road.get("name", "")).strip()]:
            if value and value not in out:
                out.append(value)
    return out[:3]


def place_category(p):
    """Category id for a place near an exit, or None when it is not linked."""
    cat, tags = p["category"], p["tags"]
    if cat == "restArea":
        if tags.get("highway") != "services":
            return None
        text = " ".join(tags.get(k, "") for k in ("name", "brand", "operator"))
        if PLAZA_NAME.search(text) or AUTHORITY.search(text) or not TRUCK_STOP.search(text):
            return None
        return CATEGORIES["travelCenter"]
    return CATEGORIES[cat]


def place_name(p):
    tags = p["tags"]
    name = (tags.get("brand") or tags.get("name") or "").strip()
    if not name and p["category"] == "restArea":
        name = "Rest Area"
    return name


def main():
    interstates_path, corridors_path, dst, source_json = sys.argv[1:5]
    regions = sys.argv[5:]
    source = json.load(open(source_json))
    on_interstates = read_eax_exit_node_ids(interstates_path)
    corridors = Corridors(corridors_path)

    junctions, places, extracts = {}, {}, []
    stats = collections.Counter()
    for path in regions:
        data = json.load(open(path))
        extracts.append({"extract": data["extract"], "osm_timestamp": data["osm_timestamp"]})
        for j in data["junctions"]:
            if j["id"] in junctions:
                stats["duplicate"] += 1
                continue
            if j["id"] in on_interstates:
                stats["in_interstates"] += 1
                continue
            if any(is_interstate(road) for road in j["roads"]):
                stats["interstate_lanes"] += 1
                continue
            junctions[j["id"]] = j
        for p in data["places"]:
            places.setdefault(p["id"], p)

    exits = []
    for nid, j in junctions.items():
        label, name = exit_label(j), exit_name(j)
        if not label and not name:
            stats["no_number_or_name"] += 1
            continue
        if not label and NOT_AN_EXIT.search(name):
            stats["service_area_ramp"] += 1
            continue
        distinct = []
        for b in j["bearings"]:
            if all(angle_diff(b, d) > 20.0 for d in distinct):
                distinct.append(b)
        if corridors.on_corridor(j["lat"], j["lon"], distinct):
            stats["on_interstate_corridor"] += 1
            continue
        exits.append({"id": nid, "lat": j["lat"], "lon": j["lon"], "label": label, "name": name,
                      "highways": highways(j), "bearings": distinct[:2]})
    exits.sort(key=lambda e: (e["lat"], e["lon"]))

    grid = collections.defaultdict(list)
    for p in places.values():
        cat = place_category(p)
        name = place_name(p)
        if cat is None or (cat not in (CATEGORIES["park"], CATEGORIES["dogPark"]) and name.lower() in ("", "unknown")):
            continue
        grid[(int(math.floor(p["lat"] / CELL)), int(math.floor(p["lon"] / CELL)))].append((p, cat, name))

    used_places = {}
    exit_links = []
    for e in exits:
        cy, cx = int(math.floor(e["lat"] / CELL)), int(math.floor(e["lon"] / CELL))
        by_cat = collections.defaultdict(list)
        for dy in (-1, 0, 1):
            for dx in (-2, -1, 0, 1, 2):
                for p, cat, name in grid.get((cy + dy, cx + dx), ()):
                    d = meters(e["lat"], e["lon"], p["lat"], p["lon"])
                    if d <= PARK_METERS:
                        by_cat[cat].append((d, p["id"], p, name))
        links = []
        for cat, found in by_cat.items():
            found.sort(key=lambda x: (x[0], x[1]))
            limit = PARK_METERS if cat in (CATEGORIES["park"], CATEGORIES["dogPark"]) else PLACE_METERS
            for rank, (d, pid, p, name) in enumerate(found[:MAX_RANK], start=1):
                if d <= limit:
                    links.append((rank, d, pid))
                    used_places[pid] = (p, cat, name)
        links.sort(key=lambda x: (x[0], x[1], x[2]))
        exit_links.append(links)
        stats["with_services" if links else "without_services"] += 1

    place_ids = sorted(used_places)
    place_index = {pid: i for i, pid in enumerate(place_ids)}
    strings = StringTable()
    exit_records, link_records = bytearray(), bytearray()
    link_count = 0
    for e, links in zip(exits, exit_links):
        bs = e["bearings"]
        stats["bearing_%d" % len(bs)] += 1
        stats["numbered" if e["label"] else "unnumbered"] += 1
        stats["named" if e["name"] else "unnamed"] += 1
        b1 = int(round(bs[0] * 10)) % 3600 if len(bs) > 0 else NONE16
        b2 = int(round(bs[1] * 10)) % 3600 if len(bs) > 1 else NONE16
        start = link_count
        for rank, d, pid in links:
            link_records += struct.pack("<IHHHBB", place_index[pid], min(int(round(d)), 65534), NONE16, NONE16,
                                        min(rank, 255), 0)
            link_count += 1
        exit_records += struct.pack(
            "<qiiHHIIIIHH", e["id"], e7(e["lat"]), e7(e["lon"]), b1, b2, strings.ref(e["label"]),
            strings.ref(e["name"]), strings.ref(";".join(e["highways"])), start, min(link_count - start, 65535), 0)

    place_records = bytearray()
    for pid in place_ids:
        p, cat, name = used_places[pid]
        place_records += struct.pack("<iiIIIB3x", e7(p["lat"]), e7(p["lon"]), strings.ref(name),
                                     strings.ref((p["tags"].get("brand") or "").strip()), strings.ref(pid), cat)

    stamps = sorted(x["osm_timestamp"] for x in extracts if x["osm_timestamp"])
    metadata = dict(source)
    metadata.update({
        "kind": "freeways",
        "osm_extract_date": stamps[0][:10] if stamps else None,
        "extracts": extracts,
        "exits": len(exits), "places": len(place_ids), "links": link_count,
        "exits_with_bearing": len(exits) - stats["bearing_0"],
        "exits_numbered": stats["numbered"],
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    })
    with open(dst, "wb") as fh:
        fh.write(header("EAX1", 1, metadata))
        fh.write(strings.encode())
        fh.write(struct.pack("<I", len(exits)))
        fh.write(exit_records)
        fh.write(struct.pack("<I", len(place_ids)))
        fh.write(place_records)
        fh.write(struct.pack("<I", link_count))
        fh.write(link_records)
    print("wrote %s: %d exits, %d places, %d links" % (dst, len(exits), len(place_ids), link_count))
    print(dict(stats))


if __name__ == "__main__":
    main()
