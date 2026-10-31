#!/usr/bin/env python3
"""Build manifest.json: the version, size, SHA-256 and provenance of every bundled data file.

Usage:
    build_manifest.py <data dir>

Clients use it to download only the files that changed, to check each download against its hash, and
to keep the last set that worked when a download is bad (see docs/05 and docs/11).

  * version: UTC build time as an integer (YYYYMMDDHHMM). Clients never move to a lower version.
    Rebuilding with no file changes keeps the previous version, so the manifest only changes with
    the data.
  * schema: the file formats this manifest describes. Bump it when a format changes so that older
    apps stop at the data they can read.
  * content: SHA-256 over the sorted "name sha256" lines, to compare sets in one step.
"""
import datetime
import hashlib
import json
import os
import struct
import sys

SCHEMA = 1

# name: (required, role). Required files must load for the app to work; the rest add features.
FILES = {
    "states.eab": (True, "State boundaries"),
    "timezones.eab": (True, "Time zones"),
    "interstates.eax": (True, "Exits and services"),
    "corridors.eac": (True, "Interstate corridors (discovery mode)"),
    "freeways.eax": (False, "Exits and services on parkways, turnpikes and other freeways"),
    "restareas.json": (False, "Rest areas and service plazas"),
    "discover.json": (False, "Discover ahead places"),
    "stations.json": (False, "Gas station hours and restrooms"),
    "vehicles.json": (False, "Vehicles, fuel economy and tank sizes"),
}

# Provenance fields copied from each file's own metadata when present.
PROVENANCE = ["kind", "source", "license", "attribution", "generated_at", "osm_extract_date", "tags_fetched", "fetched",
              "data_last_edit", "count"]


def metadata(path):
    """The metadata a file carries: the JSON header of the binary formats, or "meta" of the JSON ones."""
    with open(path, "rb") as fh:
        head = fh.read(12)
        if head[:3] in (b"EAB", b"EAX", b"EAC"):
            _, length = struct.unpack("<II", head[4:12])
            return json.loads(fh.read(length))
    with open(path) as fh:
        return json.load(fh).get("meta", {})


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    data_dir = sys.argv[1]
    dst = os.path.join(data_dir, "manifest.json")
    files = {}
    for name, (required, role) in FILES.items():
        path = os.path.join(data_dir, name)
        if not os.path.exists(path):
            if required:
                sys.exit("missing required file %s" % name)
            continue
        meta = metadata(path)
        entry = {"bytes": os.path.getsize(path), "sha256": sha256(path), "required": required, "role": role}
        entry.update({k: meta[k] for k in PROVENANCE if k in meta})
        files[name] = entry
    content = hashlib.sha256("".join("%s %s\n" % (n, files[n]["sha256"]) for n in sorted(files)).encode()).hexdigest()

    previous = None
    if os.path.exists(dst):
        with open(dst) as fh:
            previous = json.load(fh)
    now = datetime.datetime.now(datetime.timezone.utc)
    if previous and previous.get("content") == content and previous.get("schema") == SCHEMA:
        version, built = previous["version"], previous["generated_at"]
    else:
        version = int(now.strftime("%Y%m%d%H%M"))
        if previous and version <= previous.get("version", 0):
            version = previous["version"] + 1
        built = now.isoformat(timespec="seconds")
    manifest = {"kind": "manifest", "schema": SCHEMA, "version": version, "content": content, "generated_at": built,
                "files": files}
    with open(dst, "w") as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print("wrote %s: version %d, %d files, %.1f MB" % (dst, version, len(files), sum(f["bytes"] for f in files.values()) / 1e6))


if __name__ == "__main__":
    main()
