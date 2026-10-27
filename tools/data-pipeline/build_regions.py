#!/usr/bin/env python3
"""Convert a simplified region GeoJSON (states or time zones) into the EAB1 binary format.

Usage:
    build_regions.py states  <states.geojson> <out.eab> <source.json>
    build_regions.py tzones  <timezones.geojson> <out.eab> <source.json>

EAB1 layout after the common header:
    u32 regionCount
    per region:
        str8 code | str16 name | str8 extra
        i32 minLat, minLon, maxLat, maxLon (e7)
        u32 polygonCount
        per polygon: u32 ringCount, per ring: u32 pointCount, pointCount * (i32 lat, i32 lon)
Ring 0 of each polygon is the outer ring, the rest are holes. Readers use the even-odd rule.
"""
import datetime
import json
import struct
import sys

from eaformat import e7, header, ring_bytes, str8, str16


def polygons_of(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError("unsupported geometry " + geometry["type"])


def region_record(code, name, extra, geometry):
    polys = polygons_of(geometry)
    lats = [pt[1] for poly in polys for ring in poly for pt in ring]
    lons = [pt[0] for poly in polys for ring in poly for pt in ring]
    out = bytearray()
    out += str8(code) + str16(name) + str8(extra)
    out += struct.pack("<iiii", e7(min(lats)), e7(min(lons)), e7(max(lats)), e7(max(lons)))
    out += struct.pack("<I", len(polys))
    points = 0
    for poly in polys:
        out += struct.pack("<I", len(poly))
        for ring in poly:
            out += ring_bytes(ring)
            points += len(ring)
    return bytes(out), points


def main():
    kind, src, dst, source_json = sys.argv[1:5]
    features = json.load(open(src))["features"]
    source = json.load(open(source_json))
    records = []
    total_points = 0
    for f in features:
        p = f["properties"]
        if kind == "states":
            code, name, extra = p["STUSPS"], p["NAME"], p["STATEFP"]
        else:
            code, name, extra = p["zone"], p["zone"], p["utc"]
        rec, pts = region_record(code, name, extra, f["geometry"])
        records.append((code, rec))
        total_points += pts
    records.sort(key=lambda r: r[0])
    metadata = dict(source)
    metadata.update({
        "kind": kind,
        "regions": len(records),
        "points": total_points,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    })
    with open(dst, "wb") as fh:
        fh.write(header("EAB1", 1, metadata))
        fh.write(struct.pack("<I", len(records)))
        for _, rec in records:
            fh.write(rec)
    print("wrote %s: %d regions, %d points" % (dst, len(records), total_points))


if __name__ == "__main__":
    main()
