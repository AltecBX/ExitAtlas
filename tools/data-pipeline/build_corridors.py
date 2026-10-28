#!/usr/bin/env python3
"""Build the EAC1 directional corridor dataset used by discovery mode (no destination).

Usage:
    build_corridors.py <openinterstate csv dir> <out.eac> <source.json> [tolerance_deg]

Source: OpenInterstate reference_routes.csv, one directional route per interstate and
direction (for example I-95 Northbound). Each MultiLineString part is kept as its own
run because parts are separated by real gaps in the corridor.

EAC1 layout after the common header:
    string table
    u32 corridorCount
    per corridor: u32 highway, u32 directionCode, u32 displayName, f32 distanceMeters,
                  f32 durationSeconds, u32 partCount,
                  per part: u32 pointCount, pointCount * (i32 lat, i32 lon)
"""
import csv
import datetime
import json
import os
import struct
import sys

from shapely.geometry import LineString

from eaformat import StringTable, e7, header

csv.field_size_limit(10**9)


def main():
    csv_dir, dst, source_json = sys.argv[1:4]
    tolerance = float(sys.argv[4]) if len(sys.argv) > 4 else 0.00004  # about 4 m
    source = json.load(open(source_json))
    strings = StringTable()
    body = bytearray()
    count = 0
    points_in = points_out = 0
    for r in csv.DictReader(open(os.path.join(csv_dir, "reference_routes.csv"))):
        g = json.loads(r["geometry_geojson"])
        parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        kept = []
        for part in parts:
            if len(part) < 2:
                continue
            simple = list(LineString(part).simplify(tolerance, preserve_topology=False).coords)
            points_in += len(part)
            points_out += len(simple)
            kept.append(simple)
        if not kept:
            continue
        body += struct.pack(
            "<IIIffI", strings.ref(r["interstate_name"]), strings.ref(r["direction_code"]),
            strings.ref(r["display_name"]), float(r["distance_m"]), float(r["duration_s"]), len(kept))
        for part in kept:
            body += struct.pack("<I", len(part))
            for lon, lat in part:
                body += struct.pack("<ii", e7(lat), e7(lon))
        count += 1
    metadata = dict(source)
    metadata.update({
        "kind": "corridors", "corridors": count, "points": points_out, "source_points": points_in,
        "simplify_tolerance_deg": tolerance,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    })
    with open(dst, "wb") as fh:
        fh.write(header("EAC1", 1, metadata))
        fh.write(strings.encode())
        fh.write(struct.pack("<I", count))
        fh.write(body)
    print("wrote %s: %d corridors, %d -> %d points" % (dst, count, points_in, points_out))


if __name__ == "__main__":
    main()
