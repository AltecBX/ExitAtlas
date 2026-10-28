#!/usr/bin/env python3
"""Build the vehicle list for the fuel planner from EPA fuel economy data plus a sourced tank table.

Usage:
    build_vehicles.py <vehicles.csv> <fuel_tanks.json> <out vehicles.json>

Inputs:
  * vehicles.csv: EPA / DOE fuel economy data (https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip),
    public domain. Every gasoline, diesel, hybrid, flex fuel and plug-in hybrid version since model year 2000.
    EPA publishes MPG but not fuel tank capacity.
  * fuel_tanks.json: tank capacities by make, EPA base model, model years and optional conditions, each with
    sources (manufacturer, or two reputable sources that agree). Only verified values are included.

Output (compact JSON, loaded by the web app when the vehicle picker opens):
  {"meta": {...}, "tanks": [{"gallons": [17.0], "sources": [...], "basis": "..."}],
   "years": {"2015": {"Toyota": {"Camry": [[label, city, highway, combined, epa_id, tank_index or -1], ...]}}}}
"""
import csv
import datetime
import hashlib
import json
import sys

SKIP_TYPES = {"EV", "FCV", "CNG", "Bifuel (CNG)", "Bifuel (LPG)"}
DRIVE = {
    "Front-Wheel Drive": "FWD", "Rear-Wheel Drive": "RWD", "All-Wheel Drive": "AWD", "4-Wheel Drive": "4WD",
    "4-Wheel or All-Wheel Drive": "4WD/AWD", "Part-time 4-Wheel Drive": "4WD", "2-Wheel Drive": "2WD",
}
TWO_WHEEL = {"Front-Wheel Drive", "Rear-Wheel Drive", "2-Wheel Drive"}


def transmission(t):
    t = t.replace("Automatic", "Auto").replace("(variable gear ratios)", "(CVT)")
    return t.replace("Manual 5-spd", "Manual 5").replace("Manual 6-spd", "Manual 6").replace("Manual 7-spd", "Manual 7")


def label(r):
    parts = []
    if r["model"] != r["baseModel"]:
        parts.append(r["model"])
    if r["cylinders"] and r["displ"]:
        parts.append(f'{r["cylinders"]} cyl {r["displ"]} L')
    if r["tCharger"] == "T":
        parts.append("turbo")
    if r["sCharger"] == "S":
        parts.append("supercharged")
    if r["trany"]:
        parts.append(transmission(r["trany"]))
    if r["drive"]:
        parts.append(DRIVE.get(r["drive"], r["drive"]))
    if r["atvType"] in ("Hybrid", "Plug-in Hybrid") and r["atvType"].lower() not in r["model"].lower():
        parts.append(r["atvType"])
    if r["fuelType"] in ("Premium", "Diesel", "Midgrade"):
        parts.append(f'{r["fuelType"]} fuel')
    return " · ".join(parts)


def matches(entry, r):
    if entry["make"] != r["make"] or entry["baseModel"] != r["baseModel"]:
        return False
    y = int(r["year"])
    if not entry["from"] <= y <= entry["to"]:
        return False
    w = entry.get("when", {})
    # Diesel versions often have a different tank: they match only entries that say so.
    if w.get("diesel", False) != (r["atvType"] == "Diesel" or r["fuelType"] == "Diesel"):
        return False
    if "hybrid" in w and w["hybrid"] != (r["atvType"] in ("Hybrid", "Plug-in Hybrid")):
        return False
    if "drive" in w and (w["drive"] == "2WD") != (r["drive"] in TWO_WHEEL):
        return False
    if "cylinders" in w and str(w["cylinders"]) != r["cylinders"]:
        return False
    if "modelContains" in w and w["modelContains"].lower() not in r["model"].lower():
        return False
    if "modelExcludes" in w and w["modelExcludes"].lower() in r["model"].lower():
        return False
    return True


def main():
    csv_path, tanks_path, out_path = sys.argv[1:4]
    tanks = json.load(open(tanks_path))
    entries = tanks["entries"]
    tank_index = {}
    tank_list = []

    def tank_for(r):
        hits = [e for e in entries if matches(e, r)]
        if not hits:
            return -1
        # Most specific entry wins: more conditions, then the longer model name match; ties keep file order.
        best = max(hits, key=lambda e: (len(e.get("when", {})), len(e.get("when", {}).get("modelContains", ""))))
        key = json.dumps([best["gallons"], best["sources"]])
        if key not in tank_index:
            tank_index[key] = len(tank_list)
            tank_list.append({"gallons": best["gallons"], "sources": best["sources"], "basis": best["basis"]})
        return tank_index[key]

    years = {}
    count = with_tank = 0
    for r in csv.DictReader(open(csv_path, encoding="utf-8", errors="replace")):
        if int(r["year"]) < 2000 or r["atvType"] in SKIP_TYPES:
            continue
        city, hwy, comb = int(r["city08"]), int(r["highway08"]), int(r["comb08"])
        if min(city, hwy, comb) <= 0:
            continue
        models = years.setdefault(r["year"], {}).setdefault(r["make"], {})
        variants = models.setdefault(r["baseModel"], [])
        text = label(r)
        if any(v[0] == text and v[1:4] == [city, hwy, comb] for v in variants):
            continue  # identical label and MPG: same choice for the driver
        if any(v[0] == text for v in variants) and r["eng_dscr"]:
            text = f'{text} · {r["eng_dscr"]}'
        t = tank_for(r)
        with_tank += t >= 0
        variants.append([text, city, hwy, comb, int(r["id"]), t])
        count += 1

    for y in years.values():
        for models in y.values():
            for variants in models.values():
                variants.sort(key=lambda v: v[0])

    out = {
        "meta": {
            "source": "U.S. EPA and DOE fuel economy data (fueleconomy.gov), vehicles.csv",
            "source_url": "https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip",
            "source_sha256": hashlib.sha256(open(csv_path, "rb").read()).hexdigest(),
            "license": "Public domain (U.S. Government work)",
            "tanks": "Tank capacities from manufacturer specifications or two reputable sources that agree; see sources per entry",
            "generated_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
            "versions": count,
            "versions_with_tank": with_tank,
        },
        "tanks": tank_list,
        "years": years,
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"{count} versions, {with_tank} with a verified tank size, {len(tank_list)} tank records")


if __name__ == "__main__":
    main()
