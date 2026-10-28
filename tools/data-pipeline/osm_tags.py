"""Current tags for OSM nodes and ways from the OSM API, in batches, cached on disk.

The multi-fetch endpoints answer an error for the whole batch when one element was deleted or is
hidden, so a failing batch is split in half until the bad ids are isolated; those are recorded as
missing. Partial results are saved after every batch, so an interrupted run resumes.
"""
import collections
import json
import os
import subprocess
import time

API = "https://api.openstreetmap.org/api/0.6"
AGENT = "ExitAtlas-data-pipeline/1.0 (https://github.com/AltecBX/ExitAtlas)"


def _get(kind, nums):
    url = "%s/%ss.json?%ss=%s" % (API, kind, kind, ",".join(nums))
    res = subprocess.run(["curl", "-fsS", "-m", "120", "-A", AGENT, url], capture_output=True, text=True)
    if res.returncode != 0:
        return None
    return json.loads(res.stdout)["elements"]


def fetch_tags(place_ids, cache_path, batch=400, pause=1.5):
    """{"node/123": {"tags", "visible", "version", "timestamp"}} for every id the API returns."""
    out = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    missing = set(out.pop("_missing", []))
    todo = collections.defaultdict(list)
    for pid in place_ids:
        if pid not in out and pid not in missing:
            kind, num = pid.split("/")
            todo[kind].append(num)

    def save():
        tmp = cache_path + ".tmp"
        json.dump({**out, "_missing": sorted(missing)}, open(tmp, "w"))
        os.replace(tmp, cache_path)

    def run(kind, nums):
        elements = _get(kind, nums)
        time.sleep(pause)
        if elements is None:
            if len(nums) == 1:
                missing.add("%s/%s" % (kind, nums[0]))
                return
            half = len(nums) // 2
            run(kind, nums[:half])
            run(kind, nums[half:])
            return
        for e in elements:
            out["%s/%d" % (e["type"], e["id"])] = {
                "tags": e.get("tags", {}), "visible": e.get("visible", True),
                "version": e.get("version"), "timestamp": e.get("timestamp")}

    for kind, nums in todo.items():
        for k in range(0, len(nums), batch):
            run(kind, nums[k:k + batch])
            save()
    save()
    result = dict(out)
    result["_missing"] = sorted(missing)
    return result
