"""
inspect_geojson.py
------------------
Run this to see what property keys your GeoJSON file uses,
so you can confirm the Scotland-filtering logic in main.py will work.

Usage:
    python inspect_geojson.py
    python inspect_geojson.py path/to/your/file.geojson
"""

import json
import sys
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("scotland.geojson")

with open(path, encoding="utf-8") as f:
    geojson = json.load(f)

features = geojson.get("features", [])
print(f"Total features: {len(features)}\n")

if features:
    print("Properties in first feature:")
    for k, v in features[0].get("properties", {}).items():
        print(f"  {k!r}: {v!r}")

    print("\nSample of all 'code-like' property values (first 10 features):")
    for feat in features[:10]:
        props = feat.get("properties", {})
        print(f"  {props}")

# Count how many features have codes starting with 'S'
code_keys = ["LAD13CD", "LAD21CD", "LAD22CD", "lad13cd", "lad21cd", "code"]
for key in code_keys:
    scottish = [
        f for f in features
        if str(f.get("properties", {}).get(key, "")).startswith("S")
    ]
    if scottish:
        print(f"\nFound {len(scottish)} Scottish features using key '{key}'")
        print("Example names:")
        for f in scottish[:5]:
            print(f"  {f['properties']}")
        break
else:
    print("\nNo Scottish features found with standard code keys.")
    print("Check the property names above and update main.py accordingly.")
