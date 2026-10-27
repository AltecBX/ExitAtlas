#!/usr/bin/env python3
"""Turn an OSRM route response into a test fixture plus independent oracle expectations.

Usage:
    make_route_fixture.py <osrm.json> <route index> <name> <states_full.geojson> <interstates.eax> <out dir>

Writes <name>.route.json (geometry, OSM node ids, per-segment durations, steps) and
<name>.expected.json with:
  * states: ordered state segments computed by shapely + pyproj on the FULL resolution
    TIGER polygons (independent of the Swift engine and of the simplified app data);
  * exits_on_route: exit node ids the route passes through, in order, found by OSM node
    membership (exact, no geometry), which is the ground truth for directional exit matching.
"""
import datetime
import json
import os
import sys

from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree
from pyproj import Geod

from eaformat import read_eax_exit_node_ids

geod = Geod(ellps="WGS84")


def state_segments(coords, states_path):
    feats = json.load(open(states_path))["features"]
    polys = [shape(f["geometry"]) for f in feats]
    codes = [f["properties"]["STUSPS"] for f in feats]
    tree = STRtree(polys)

    def state_at(pt):
        p = Point(pt)
        for i in tree.query(p):
            if polys[i].covers(p):
                return codes[i]
        return None

    pieces, total = [], 0.0
    for a, b in zip(coords, coords[1:]):
        seg = LineString([a, b])
        ts = {0.0, 1.0}
        for i in tree.query(seg):
            inter = polys[i].boundary.intersection(seg)
            if inter.is_empty:
                continue
            for g in getattr(inter, "geoms", [inter]):
                for c in getattr(g, "coords", []):
                    ts.add(seg.project(Point(c), normalized=True))
        ts = sorted(ts)
        for t0, t1 in zip(ts, ts[1:]):
            if t1 <= t0:
                continue
            p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            p1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            _, _, dist = geod.inv(p0[0], p0[1], p1[0], p1[1])
            code = state_at(((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2))
            start = total
            total += dist
            if pieces and pieces[-1]["code"] == code:
                pieces[-1]["end_m"] = total
            else:
                pieces.append({"code": code, "start_m": start, "end_m": total})
    for p in pieces:
        p["length_m"] = p["end_m"] - p["start_m"]
    return pieces, total


def main():
    src, index, name, states_path, eax_path, out_dir = sys.argv[1:7]
    data = json.load(open(src))
    route = data["routes"][int(index)]
    coords = route["geometry"]["coordinates"]
    nodes, durations = [], []
    steps = []
    for leg in route["legs"]:
        nodes += leg["annotation"]["nodes"]
        durations += leg["annotation"]["duration"]
        for s in leg["steps"]:
            steps.append({
                "name": s.get("name", ""), "ref": s.get("ref", ""), "distance_m": s["distance"],
                "duration_s": s["duration"], "maneuver": s["maneuver"]["type"],
                "modifier": s["maneuver"].get("modifier", ""),
            })
    assert len(nodes) == len(coords), (len(nodes), len(coords))
    fixture = {
        "name": name,
        "source": "OSRM demo server router.project-osrm.org, data (c) OpenStreetMap contributors, ODbL 1.0",
        "fetched_at": datetime.date.today().isoformat(),
        "distance_m": route["distance"],
        "duration_s": route["duration"],
        "coordinates": [[round(c[1], 7), round(c[0], 7)] for c in coords],
        "osm_nodes": nodes,
        "segment_durations_s": durations,
        "steps": steps,
    }
    pieces, total = state_segments(coords, states_path)
    exit_ids = read_eax_exit_node_ids(eax_path)
    seen, exits = set(), []
    for n in nodes:
        if n in exit_ids and n not in seen:
            seen.add(n)
            exits.append(n)
    expected = {
        "oracle": "shapely/pyproj on full-resolution TIGER/Line 2026; exits by OSM node membership",
        "geodesic_length_m": total,
        "states": pieces,
        "exits_on_route": exits,
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, name + ".route.json"), "w") as fh:
        json.dump(fixture, fh, separators=(",", ":"))
    with open(os.path.join(out_dir, name + ".expected.json"), "w") as fh:
        json.dump(expected, fh, indent=1)
    print(name, "states:", [(p["code"], round(p["length_m"] / 1609.344, 2)) for p in pieces], "exits:", len(exits))


if __name__ == "__main__":
    main()
