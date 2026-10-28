#!/usr/bin/env python3
"""Build discover.json: notable places near interstates for "Discover ahead".

Usage:
    build_discover.py <openinterstate csv dir> <wikidata cache dir> <out discover.json>

Source: Wikidata (CC0), queried per category from the public query service and cached in the
cache dir. Kept only when:
  * the item is in the United States, has coordinates, an English label and is not marked as
    dissolved, demolished or closed (P576 dissolved/abolished, P3999 closing date, P5817 state of use
    in CLOSED);
  * it belongs to an allowed category (below);
  * it is notable: linked from enough Wikimedia sites (sitelinks: Wikipedia language editions plus
    sister projects such as Wikivoyage and Commons), a quality signal;
  * it lies near an interstate carriageway, straight line: 16 km (10 mi) for parks and natural
    sites, 8 km (5 mi) for city attractions.
Score (0 to 100): sitelinks (3 points each, up to 60), +25 for a national park, national monument or
state park designation, +10 with an English Wikipedia article. Items scoring under 35 are dropped.
"""
import collections
import datetime
import json
import math
import os
import re
import subprocess
import sys
import time

from build_rest_areas import Carriageways

ENDPOINT = "https://query.wikidata.org/sparql"
AGENT = "ExitAtlas-data-pipeline/1.0 (https://github.com/AltecBX/ExitAtlas)"
MIN_SCORE = 35

# category: (Wikidata classes, include subclasses, minimum sitelinks, designation bonus, near meters)
# Parks and natural sites rarely have many site links but are worth a longer detour; city
# attractions need more editions to stand out and must be close to the highway.
CATEGORIES = {
    "nationalPark": (["Q34918903", "Q46169"], False, 1, True, 16000),
    "nationalMonument": (["Q893775"], False, 1, True, 16000),
    # Each state has its own subclass ("Illinois state park"), so subclasses are included.
    "statePark": (["Q1761072"], True, 1, True, 16000),
    "waterfall": (["Q34038"], False, 2, False, 16000),
    "cave": (["Q35509"], False, 2, False, 16000),
    "viewpoint": (["Q6017969"], False, 1, False, 8000),
    "museum": (["Q33506"], True, 8, False, 8000),
    "zoo": (["Q43501"], False, 6, False, 8000),
    "amusementPark": (["Q194195"], False, 8, False, 8000),
    "historicSite": (["Q1081138"], False, 3, False, 8000),
    "landmark": (["Q570116", "Q2319498", "Q4989906"], False, 8, False, 8000),
}

# P5817 state of use values that mean the place cannot be visited (labels checked 2026-10-28):
# permanently closed, demolished or destroyed, cancelled, decommissioned, abandoned, closed to the
# public, proposed, under construction.
CLOSED = ["Q104664889", "Q56556915", "Q30108381", "Q11639308", "Q63065035", "Q55570340", "Q811683", "Q12377751"]

# Descriptions that say the place cannot be visited now ("submerged waterfall", "planned museum").
NOT_VISITABLE = re.compile(r"\b(planned|proposed|former|defunct|demolished|destroyed|submerged|closed|"
                           r"under construction|historical|disestablished)\b", re.I)

QUERY = """
SELECT ?item ?itemLabel ?itemDescription ?coord ?sl ?enwiki WHERE {{
  VALUES ?cls {{ {classes} }}
  ?item wdt:P31{path} ?cls; wdt:P17 wd:Q30; wdt:P625 ?coord; wikibase:sitelinks ?sl.
  FILTER(?sl >= {minimum})
  FILTER NOT EXISTS {{ ?item wdt:P576 [] }}
  FILTER NOT EXISTS {{ ?item wdt:P3999 [] }}
  FILTER NOT EXISTS {{ ?item wdt:P5817 ?use. FILTER(?use IN ({closed})) }}
  OPTIONAL {{ ?enwiki schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def fetch(category, cache_dir):
    path = os.path.join(cache_dir, "wikidata_%s.json" % category)
    if os.path.exists(path):
        return json.load(open(path))
    classes, sub, minimum, _, _ = CATEGORIES[category]
    query = QUERY.format(classes=" ".join("wd:" + c for c in classes), path="/wdt:P279*" if sub else "", minimum=minimum,
                         closed=", ".join("wd:" + c for c in CLOSED))
    res = subprocess.run(["curl", "-fsS", "-m", "90", "-G", ENDPOINT, "-H", "Accept: application/sparql-results+json",
                          "-H", "User-Agent: " + AGENT, "--data-urlencode", "query=" + query],
                         capture_output=True, text=True, check=True)
    data = json.loads(res.stdout)
    json.dump(data, open(path, "w"))
    time.sleep(2)
    return data


def point(wkt):
    """(lon, lat) from a WKT point, or None for other globes ("<...Q405> Point(...)") or bad values."""
    m = re.fullmatch(r"Point\(([-+\d.eE]+) ([-+\d.eE]+)\)", wkt.strip())
    return (float(m.group(1)), float(m.group(2))) if m else None


def main():
    csv_dir, cache_dir, dst = sys.argv[1:4]
    os.makedirs(cache_dir, exist_ok=True)
    carriageways = Carriageways(csv_dir)
    items, stats = {}, collections.Counter()
    for category, (_, _, _, designated, near_meters) in CATEGORIES.items():
        for b in fetch(category, cache_dir)["results"]["bindings"]:
            qid = b["item"]["value"].rsplit("/", 1)[1]
            name = b.get("itemLabel", {}).get("value", "")
            if not name or name == qid:
                stats["no_label"] += 1
                continue
            p = point(b["coord"]["value"])
            if p is None:
                stats["bad_coordinate"] += 1
                continue
            lon, lat = p
            sitelinks = int(b["sl"]["value"])
            wiki = b.get("enwiki", {}).get("value")
            score = min(60, 3 * sitelinks) + (25 if designated else 0) + (10 if wiki else 0)
            prev = items.get(qid)
            if prev and prev["score"] >= score:
                continue
            if prev is None:
                near = carriageways.nearest(lon, lat, near_meters)
                if not near:
                    stats["far"] += 1
                    continue
                if score < MIN_SCORE:
                    stats["low_score"] += 1
                    continue
                road, off = near[0][3], round(near[0][0])
            else:
                road, off = prev["road"], prev["offMeters"]
            item = {"id": qid, "name": name, "cat": category, "lat": round(lat, 6), "lon": round(lon, 6),
                    "sitelinks": sitelinks, "score": score, "road": road, "offMeters": off}
            desc = b.get("itemDescription", {}).get("value", "")
            if NOT_VISITABLE.search(desc) or NOT_VISITABLE.search(name):
                stats["not_visitable"] += 1
                items.pop(qid, None)
                continue
            if desc:
                item["desc"] = desc[:120]
            if wiki:
                item["wiki"] = wiki
            items[qid] = item
    out = sorted(items.values(), key=lambda i: (i["lat"], i["lon"]))
    stats.update(collections.Counter(i["cat"] for i in out))
    meta = {
        "kind": "discover", "version": 1,
        "source": "Wikidata (query.wikidata.org), places within 8 to 16 km of an interstate, scored by Wikimedia site links and designation",
        "license": "CC0-1.0", "attribution": "Wikidata (CC0). Descriptions from Wikidata.",
        "fetched": datetime.date.today().isoformat(), "count": len(out), "min_score": MIN_SCORE,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
    with open(dst, "w") as fh:
        json.dump({"meta": meta, "items": out}, fh, separators=(",", ":"), ensure_ascii=False)
    print("wrote %s: %d places" % (dst, len(out)))
    print(dict(stats))


if __name__ == "__main__":
    main()
