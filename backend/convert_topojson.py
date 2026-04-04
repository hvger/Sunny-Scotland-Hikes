"""
convert_topojson.py
-------------------
Converts topo_lad.json (TopoJSON format) to scotland.geojson (standard GeoJSON),
filtering to Scottish councils only (LAD13CD starting with 'S').

This script manually decodes TopoJSON arcs without needing the topojson library.

Run:
    python convert_topojson.py
    python convert_topojson.py path/to/topo_lad.json
"""

import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("topo_lad.json")
output_path = Path("scotland.geojson")

if not input_path.exists():
    print(f"ERROR: Input file not found: {input_path}")
    sys.exit(1)

print(f"Reading {input_path}...")
with open(input_path, encoding="utf-8") as f:
    topo = json.load(f)

# ---------------------------------------------------------------------------
# TopoJSON manual decoder
# ---------------------------------------------------------------------------

def decode_arcs(topo):
    """
    Decode TopoJSON arcs into absolute coordinate lists.
    TopoJSON stores arcs as delta-encoded sequences - each point is relative
    to the previous one. We also apply the scale/translate transform if present.
    """
    raw_arcs = topo.get("arcs", [])
    transform = topo.get("transform")

    if transform:
        sx, sy = transform["scale"]
        tx, ty = transform["translate"]
    else:
        sx, sy, tx, ty = 1, 1, 0, 0

    decoded = []
    for arc in raw_arcs:
        x, y = 0, 0
        coords = []
        for dx, dy in arc:
            x += dx
            y += dy
            coords.append([x * sx + tx, y * sy + ty])
        decoded.append(coords)

    return decoded


def arc_to_coords(arc_index, decoded_arcs):
    """
    Resolve a single arc index to its coordinate list.
    Negative indices mean the arc is reversed (TopoJSON convention).
    """
    if arc_index < 0:
        return list(reversed(decoded_arcs[~arc_index]))
    return decoded_arcs[arc_index]


def stitch_ring(arc_indices, decoded_arcs):
    """
    Stitch together a ring from a list of arc indices into a single
    closed coordinate list.
    """
    coords = []
    for arc_index in arc_indices:
        segment = arc_to_coords(arc_index, decoded_arcs)
        if coords:
            coords.extend(segment[1:])
        else:
            coords.extend(segment)
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def geometry_to_geojson(geometry, decoded_arcs):
    """
    Convert a single TopoJSON geometry object to a GeoJSON geometry dict.
    Handles Polygon and MultiPolygon.
    """
    geom_type = geometry.get("type")
    arcs = geometry.get("arcs", [])

    if geom_type == "Polygon":
        rings = [stitch_ring(ring, decoded_arcs) for ring in arcs]
        return {"type": "Polygon", "coordinates": rings}

    elif geom_type == "MultiPolygon":
        polygons = [
            [stitch_ring(ring, decoded_arcs) for ring in polygon]
            for polygon in arcs
        ]
        return {"type": "MultiPolygon", "coordinates": polygons}

    else:
        return None


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------

decoded_arcs = decode_arcs(topo)

objects = topo.get("objects", {})
object_name = next(iter(objects))
print(f"Found TopoJSON object: '{object_name}'")

geometries = objects[object_name].get("geometries", [])
print(f"Total geometries: {len(geometries)}")

scottish_features = []
for geom in geometries:
    props = geom.get("properties", {})
    code = (
        props.get("LAD13CD") or
        props.get("LAD21CD") or
        props.get("LAD22CD") or
        ""
    )

    if not code.startswith("S"):
        continue

    geojson_geom = geometry_to_geojson(geom, decoded_arcs)
    if geojson_geom is None:
        print(f"  WARNING: Skipping unsupported geometry type for {code}")
        continue

    scottish_features.append({
        "type": "Feature",
        "properties": props,
        "geometry": geojson_geom,
    })

print(f"Scottish features found: {len(scottish_features)}")

if not scottish_features:
    print("\nERROR: No Scottish features found.")
    print("Sample properties from first geometry:")
    if geometries:
        print(json.dumps(geometries[0].get("properties", {}), indent=2))
    sys.exit(1)

output_geojson = {
    "type": "FeatureCollection",
    "features": scottish_features,
}

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(output_geojson, f)

size_kb = output_path.stat().st_size / 1024
print(f"\nSaved to {output_path} ({size_kb:.1f} KB)")
print("Council areas included:")
for feat in scottish_features:
    print(f"  {feat['properties'].get('LAD13NM', '?')}")
print("\nDone! You can now run: uvicorn main:app --reload --port 8000")