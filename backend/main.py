"""
Scotland Weather Backend
------------------------
FastAPI server that:
  1. Loads the Scotland LAD GeoJSON boundary (topo_lad.json / scotland.geojson)
  2. Builds a grid of lat/lon points filtered to land-only using point-in-polygon
  3. Fetches cloud cover for those points from Open-Meteo
  4. Returns a JSON grid that the React frontend can consume directly

Run locally:
    uvicorn main:app --reload --port 8000

The frontend should call:
    GET http://localhost:8000/cloud-cover
"""

import json
import os
import urllib.request
from datetime import datetime, timezone, timedelta
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from shapely.geometry import shape, Point
from shapely.ops import unary_union

from pathlib import Path
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Scotland bounding box — same values as the React app
LAT_MIN = 54.63
LAT_MAX = 59.4
LON_MIN = -7.6
LON_MAX = -1.6
STEP = 0.15          # degrees — adjust to taste (0.2 for more points, 0.25 for fewer)

# Path to your downloaded GeoJSON file.
# Place topo_lad.json (or rename to scotland.geojson) next to this file.
GEOJSON_PATH = Path(__file__).parent / "scotland.geojson"

# Grid persistence
GRID_PATH = Path(__file__).parent / "land_grid.json"

# Weather cache: stores the last fetched data with timestamp
weather_cache = {}

# Hours ahead for forecast layer (same Open-Meteo hourly run)
FORECAST_HOURS = 11  # indices 0 (now) through 10 (+10h)

# CORS — in production replace "*" with your actual Render frontend URL
# e.g. "https://your-app.onrender.com"
ALLOWED_ORIGINS = os.getenv("FRONTEND_URL", "*").split(",")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Scotland Weather API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def load_scotland_polygon():
    """
    Load and merge all Scottish LAD polygons into a single unified shape.
    Cached so the file is only read once at startup.

    The topo_lad.json from martinjc/UK-GeoJSON contains all UK LADs.
    We filter to Scotland by checking the 'LAD13NM' or 'LAD21NM' property,
    or by the fact that Scottish council codes start with 'S'.
    """
    if not GEOJSON_PATH.exists():
        raise FileNotFoundError(
            f"GeoJSON file not found at {GEOJSON_PATH}. "
            "Please place your topo_lad.json (renamed to scotland.geojson) "
            "next to main.py."
        )

    with open(GEOJSON_PATH, encoding="utf-8") as f:
        geojson = json.load(f)

    features = geojson.get("features", [])
    polygons = []

    for feature in features:
        props = feature.get("properties", {})

        # Scottish LAD codes start with 'S' in the ONS coding system.
        # Try several common property key names used across different versions
        # of the ONS/martinjc GeoJSON files.
        code = (
            props.get("LAD13CD") or
            props.get("LAD21CD") or
            props.get("LAD22CD") or
            props.get("lad13cd") or
            props.get("lad21cd") or
            props.get("code") or
            ""
        )

        if code.startswith("S"):
            try:
                geom = shape(feature["geometry"])
                # British boundary data from TopoJSON often has tiny
                # self-intersections after arc-stitching. buffer(0) is the
                # standard fix — it cleans the geometry without moving any
                # coordinates meaningfully.
                if not geom.is_valid:
                    geom = geom.buffer(0)
                if geom.is_valid and not geom.is_empty:
                    polygons.append(geom)
                else:
                    name = props.get("LAD13NM", code)
                    print(f"  [warning] Could not fix geometry for {name}, skipping")
            except Exception as e:
                name = props.get("LAD13NM", code)
                print(f"  [warning] Failed to load {name}: {e}")

    if not polygons:
        raise ValueError(
            "No Scottish features found in the GeoJSON. "
            "Check that the file contains LAD codes starting with 'S', "
            "or inspect the properties with: python inspect_geojson.py"
        )

    # Merge all council area polygons into one unified Scotland shape.
    # buffer(0) on the union result catches any remaining edge cases
    # from shared boundaries between adjacent councils.
    scotland = unary_union(polygons).buffer(0)
    print(f"[startup] Loaded Scotland polygon from {len(polygons)} council areas")
    return scotland


@lru_cache(maxsize=1)
def build_land_grid():
    """
    Generate all grid points within Scotland's bounding box,
    then filter to only those that fall within the Scotland polygon.
    Persists to file for faster subsequent loads.
    Returns a list of (lat, lon) tuples.
    """
    if GRID_PATH.exists():
        try:
            with open(GRID_PATH, 'r') as f:
                data = json.load(f)
                land_points = [(p['lat'], p['lon']) for p in data['points']]
                print(f"[startup] Loaded land grid from {GRID_PATH} ({len(land_points)} points)")
                return land_points
        except Exception as e:
            print(f"[warning] Failed to load grid from {GRID_PATH}: {e}, rebuilding...")

    scotland = load_scotland_polygon()

    candidates = []
    lat = LAT_MIN
    while lat <= LAT_MAX + 0.001:
        lon = LON_MIN
        while lon <= LON_MAX + 0.001:
            candidates.append((round(lat, 4), round(lon, 4)))
            lon = round(lon + STEP, 4)
        lat = round(lat + STEP, 4)

    # Point-in-polygon test — shapely is fast enough for a few hundred points
    land_points = [
        (lat, lon) for lat, lon in candidates
        if scotland.contains(Point(lon, lat))  # GeoJSON is (lon, lat)
    ]

    print(f"[startup] Grid: {len(candidates)} candidates → {len(land_points)} land points")

    # Save to file
    try:
        data = {'points': [{'lat': lat, 'lon': lon} for lat, lon in land_points]}
        with open(GRID_PATH, 'w') as f:
            json.dump(data, f)
        print(f"[startup] Saved land grid to {GRID_PATH}")
    except Exception as e:
        print(f"[warning] Failed to save grid to {GRID_PATH}: {e}")

    return land_points


# ---------------------------------------------------------------------------
# Open-Meteo fetch
# ---------------------------------------------------------------------------

def _parse_om_time(s: str) -> datetime:
    """Parse Open-Meteo hourly time string as UTC."""
    s = (s or "").strip()
    if s.endswith("Z"):
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _closest_time_index(times: list[str], target: datetime) -> int:
    """Index of hourly slot whose time is closest to target."""
    if not times:
        raise ValueError("hourly.time is empty")
    best_i = 0
    best_diff = None
    for i, ts in enumerate(times):
        dt = _parse_om_time(ts)
        diff = abs((dt - target).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff = diff
            best_i = i
    return best_i


def fetch_cloud_cover(land_points: list[tuple[float, float]]) -> tuple[list[dict], int]:
    """
    Fetch hourly cloud cover for all land grid points in one Open-Meteo request.

    Returns tuple of:
      - list of 11 dicts: each dict maps (lat, lon) → int 0–100 for that hour offset
      - now_hour: current UTC hour (0-23)
    """
    if not land_points:
        raise HTTPException(status_code=500, detail="No land grid points available")

    lats = ",".join(str(p[0]) for p in land_points)
    lons = ",".join(str(p[1]) for p in land_points)

    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lats}&longitude={lons}"
        "&hourly=cloud_cover"
    )

    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = json.loads(response.read())
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Open-Meteo request failed: {e}",
        ) from e

    results = data if isinstance(data, list) else [data]
    now_hour = datetime.now(timezone.utc).hour

    # Build one cover map per hour offset
    hourly_maps = [{} for _ in range(FORECAST_HOURS)]

    for i, point in enumerate(land_points):
        try:
            hourly = results[i]["hourly"]["cloud_cover"]
            for offset in range(FORECAST_HOURS):
                hourly_maps[offset][point] = round(float(hourly[now_hour + offset]))
        except (IndexError, KeyError, TypeError):
            for offset in range(FORECAST_HOURS):
                hourly_maps[offset][point] = 100

    return hourly_maps, now_hour


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    """Pre-build the land grid at startup so the first request is fast."""
    try:
        build_land_grid()
    except Exception as e:
        print(f"[startup] WARNING: {e}")


@app.get("/health")
def health():
    """Simple health check — useful for Render's health check setting."""
    return {"status": "ok"}


@app.get("/cloud-cover")
def cloud_cover():
    """
    Returns cloud cover data for all Scottish land grid points.
    Caches data for 30 minutes to reduce API calls.

    Response includes hourly points for 0 to +10h ahead.
    {
        "step": 0.15,
        "generated_at": "...",
        "now_hour_utc": 14,
        "forecast_hours": 11,
        "hourly_points": [
            [ { "lat", "lon", "cloud_cover" }, ... ],  # offset 0
            [ { "lat", "lon", "cloud_cover" }, ... ],  # offset 1
            ...
        ]
    }
    """
    now = datetime.now(timezone.utc)
    cache_key = "cloud_cover"
    if cache_key in weather_cache:
        cached_time, cached_data = weather_cache[cache_key]
        if now - cached_time < timedelta(minutes=30):
            print(f"[cache] Serving cached weather data from {cached_time}")
            return cached_data

    try:
        land_points = build_land_grid()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    hourly_maps, now_hour = fetch_cloud_cover(land_points)

    hourly_points = [
        [
            {"lat": lat, "lon": lon, "cloud_cover": hourly_maps[offset].get((lat, lon), 100)}
            for lat, lon in land_points
        ]
        for offset in range(FORECAST_HOURS)
    ]

    data = {
        "step": STEP,
        "generated_at": now.isoformat(),
        "now_hour_utc": now_hour,
        "forecast_hours": FORECAST_HOURS,
        "hourly_points": hourly_points,
    }

    # Cache the data
    weather_cache[cache_key] = (now, data)
    print(f"[cache] Fetched and cached new weather data at {now}")

    return data


@app.get("/grid-preview")
def grid_preview():
    """
    Land grid points only (no weather). For debugging / GeoJSON viewers.
    """
    try:
        land_points = build_land_grid()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {},
            }
            for lat, lon in land_points
        ],
    }

# Serve the React frontend from the dist folder baked in at Docker build time.
# The catch-all mount must come last — after all API routes — otherwise it
# swallows requests to /cloud-cover, /health, etc.
_dist = Path(__file__).parent / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)