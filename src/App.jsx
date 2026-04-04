import React, { useEffect, useState, useCallback, useRef } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import hillsCsv from "./all_hills_with_coords.csv?raw";

/** Category,Mountain,Alt,User Rating,Ascents,URL,Latitude,Longitude — parse from the right so commas in Mountain are OK */
function parseHillLine(line) {
  const parts = line.split(",");
  if (parts.length < 8) return null;
  const lon = parseFloat(parts.pop());
  const lat = parseFloat(parts.pop());
  const url = parts.pop();
  const ascents = parseInt(parts.pop(), 10);
  const userRating = parseFloat(parts.pop());
  const alt = parseFloat(parts.pop());
  const category = parts.shift();
  const mountain = parts.join(",");
  if (!category || !mountain || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { category, name: mountain, alt, userRating, ascents, url, lat, lon };
}

function parseHillsCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseHillLine(lines[i]);
    if (row) out.push(row);
  }
  return out;
}

const HILLS_DATA = parseHillsCsv(hillsCsv);

function computeHillMetricBounds(hills) {
  let ascMin = Infinity, ascMax = -Infinity;
  let ratMin = Infinity, ratMax = -Infinity;
  for (const h of hills) {
    if (h.ascents < ascMin) ascMin = h.ascents;
    if (h.ascents > ascMax) ascMax = h.ascents;
    if (Number.isFinite(h.userRating)) {
      if (h.userRating < ratMin) ratMin = h.userRating;
      if (h.userRating > ratMax) ratMax = h.userRating;
    }
  }
  if (ascMin === Infinity) ascMin = ascMax = 0;
  if (ratMin === Infinity) { ratMin = 0; ratMax = 5; }
  return { ascMin, ascMax, ratMin, ratMax };
}

const HILL_METRIC_BOUNDS = computeHillMetricBounds(HILLS_DATA);

function hillPassesMetricFilters(hill, ascMin, ascMax, ratMin, ratMax, bounds) {
  if (hill.ascents < ascMin || hill.ascents > ascMax) return false;
  if (!Number.isFinite(hill.userRating))
    return ratMin <= bounds.ratMin + 1e-6 && ratMax >= bounds.ratMax - 1e-6;
  return hill.userRating >= ratMin - 1e-9 && hill.userRating <= ratMax + 1e-9;
}

// --- Scotland bounding box ---
const LAT_MIN = 54.63, LAT_MAX = 59.4, LON_MIN = -7.6, LON_MAX = -1.6, STEP = 0.15;
const SCOTLAND_BOUNDS = [[LAT_MIN, LON_MIN], [LAT_MAX, LON_MAX]];
const SCOTLAND_CENTER = [(LAT_MIN + LAT_MAX) / 2, (LON_MIN + LON_MAX) / 2];

function hillStyle(category) {
  const c = (category || "").toLowerCase();
  if (c.startsWith("munro")) return { r: 5, color: "#ff6b3d" };
  if (c.startsWith("corbett")) return { r: 4, color: "#ffaa44" };
  return { r: 3, color: "#ffe066" };
}
function hillCategoryLabel(category) {
  const c = (category || "").toLowerCase();
  if (c.startsWith("munro")) return "Munro";
  if (c.startsWith("corbett")) return "Corbett";
  return category || "Hill";
}

// Get cloud cover at a grid point
function getCloudCoverAtPoint(lat, lon, weatherData) {
  if (!weatherData) return 100;
  const { grid, lats, lons } = weatherData;
  const li = Math.round((lat - LAT_MIN) / STEP);
  const lo = Math.round((lon - LON_MIN) / STEP);
  const safeL = Math.max(0, Math.min(li, lats.length - 1));
  const safeO = Math.max(0, Math.min(lo, lons.length - 1));
  return grid[safeL]?.[safeO] ?? 100;
}

// --- Real weather data via Open-Meteo --- Call from backend
import { fetchWeatherGrid } from "./weatherApi"

// --- Colour: sunny = vivid golden, cloudy = steel blue, stronger alpha curve ---
function cloudCoverToRGBA(cover, dimFactor = 1, shimmerBoost = 0) {
  // RGB colour stops: [cloudPct, r, g, b]
  const stops = [
    [0,   255, 220,  40],   // bright golden sun
    [15,  255, 205,  55],   // warm yellow
    [30,  235, 185,  75],   // amber
    [50,  170, 160, 175],   // neutral lavender transition
    [70,  100, 125, 165],   // cool steel blue
    [85,   70, 100, 150],   // deeper blue-grey
    [100,  55,  80, 130],   // overcast dark blue
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (cover >= stops[i][0] && cover <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const t = (cover - lo[0]) / Math.max(1, hi[0] - lo[0]);
  const r = Math.round(lo[1] + t * (hi[1] - lo[1]));
  const g = Math.round(lo[2] + t * (hi[2] - lo[2]));
  const b = Math.round(lo[3] + t * (hi[3] - lo[3]));
  // Sharper alpha ramp — sunny areas pop, overcast areas stay subtle
  let baseAlpha;
  if (cover <= 15)      baseAlpha = 0.82 + shimmerBoost * 0.12;
  else if (cover <= 30) baseAlpha = 0.68;
  else if (cover <= 50) baseAlpha = 0.50;
  else if (cover <= 70) baseAlpha = 0.32;
  else                  baseAlpha = 0.18;
  return [r, g, b, Math.round(Math.min(1, baseAlpha) * dimFactor * 255)];
}

function bilinear(q00, q10, q01, q11, tx, ty) {
  return q00 * (1 - tx) * (1 - ty) + q10 * tx * (1 - ty) + q01 * (1 - tx) * ty + q11 * tx * ty;
}

function getNearestGridPoint(lat, lon, weatherData) {
  if (!weatherData) return null;
  const { grid, lats, lons } = weatherData;
  const li = Math.max(0, Math.min(Math.round((lat - LAT_MIN) / STEP), lats.length - 1));
  const lo = Math.max(0, Math.min(Math.round((lon - LON_MIN) / STEP), lons.length - 1));
  if (li >= grid.length || lo >= grid[0].length) return null;
  return { lat: lats[li], lon: lons[lo], cloudCover: grid[li][lo] };
}

/** Sunny hills only; same visibility as canvas markers (cloud + popularity/rating filters) */
function pickSunnyHillAtScreen(map, weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax, clientX, clientY, pickRadius = 14) {
  if (!weatherData) return null;
  const rect = map.getContainer().getBoundingClientRect();
  let closest = null, closestDist = Infinity;
  for (let i = 0; i < HILLS_DATA.length; i++) {
    const h = HILLS_DATA[i];
    if (getCloudCoverAtPoint(h.lat, h.lon, weatherData) > maxCloud) continue;
    if (!hillPassesMetricFilters(h, filterAscMin, filterAscMax, filterRatMin, filterRatMax, HILL_METRIC_BOUNDS)) continue;
    const pt = map.latLngToContainerPoint([h.lat, h.lon]);
    const sx = rect.left + pt.x, sy = rect.top + pt.y;
    const dist = Math.hypot(clientX - sx, clientY - sy);
    if (dist < pickRadius && dist < closestDist) { closest = h; closestDist = dist; }
  }
  return closest;
}

// --- Canvas heatmap overlay ---
function HeatmapOverlay({ weatherData, maxCloud, showAll }) {
  const map = useMap();
  const canvasRef = useRef(null);
  const drawRef = useRef(null);

  const draw = useCallback(() => {
    if (!canvasRef.current || !weatherData) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const { grid, lats, lons } = weatherData;
    const latCount = lats.length, lonCount = lons.length;
    const size = map.getSize();
    canvas.width = size.x; canvas.height = size.y;
    const imageData = ctx.createImageData(size.x, size.y);
    const data = imageData.data;
    for (let px = 0; px < size.x; px++) {
      for (let py = 0; py < size.y; py++) {
        const latlng = map.containerPointToLatLng([px, py]);
        const lat = latlng.lat, lon = latlng.lng;
        if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;
        const latIdx = (lat - LAT_MIN) / STEP, lonIdx = (lon - LON_MIN) / STEP;
        const li0 = Math.floor(latIdx), li1 = Math.min(li0 + 1, latCount - 1);
        const lo0 = Math.floor(lonIdx), lo1 = Math.min(lo0 + 1, lonCount - 1);
        if (li0 < 0 || lo0 < 0 || li0 >= latCount || lo0 >= lonCount) continue;
        const tx = latIdx - li0, ty = lonIdx - lo0;
        const cover = bilinear(grid[li0][lo0], grid[li1][lo0], grid[li0][lo1], grid[li1][lo1], tx, ty);
        if (!showAll && cover > maxCloud) continue;
        const dimFactor = showAll && cover > maxCloud ? 0.25 : 1.0;
        // No shimmer boost
        const sBoost = 0;
        const [r, g, b, a] = cloudCoverToRGBA(cover, dimFactor, sBoost);
        if (a === 0) continue;
        const idx = (py * size.x + px) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = a;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [map, weatherData, maxCloud, showAll]);

  drawRef.current = draw;

  useEffect(() => {
    const container = map.getPanes().overlayPane;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:400;";
    container.appendChild(canvas);
    canvasRef.current = canvas;
    const reposition = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      canvas.style.transform = `translate(${topLeft.x}px,${topLeft.y}px)`;
    };
    const redraw = () => { reposition(); drawRef.current?.(); };
    map.on("moveend zoomend resize", redraw);
    redraw();

    return () => {
      map.off("moveend zoomend resize", redraw);
      canvas.remove();
    };
  }, [map]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    canvasRef.current.style.transform = `translate(${topLeft.x}px,${topLeft.y}px)`;
    draw();
  }, [draw]);

  return null;
}

// --- Hills marker overlay ---
function HillsOverlay({ weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax }) {
  const map = useMap();
  const canvasRef = useRef(null);
  const drawRef = useRef(null);

  const draw = useCallback(() => {
    if (!canvasRef.current || !weatherData) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const size = map.getSize();
    canvas.width = size.x; canvas.height = size.y;
    ctx.clearRect(0, 0, size.x, size.y);

    // Draw a marker for each hill that falls in a sunny grid cell (nearest cell to true position)
    HILLS_DATA.forEach(hill => {
      const cover = getCloudCoverAtPoint(hill.lat, hill.lon, weatherData);
      if (cover > maxCloud) return;
      if (!hillPassesMetricFilters(hill, filterAscMin, filterAscMax, filterRatMin, filterRatMax, HILL_METRIC_BOUNDS)) return;

      const pt = map.latLngToContainerPoint([hill.lat, hill.lon]);
      if (pt.x < -10 || pt.y < -10 || pt.x > size.x + 10 || pt.y > size.y + 10) return;

      const { r, color } = hillStyle(hill.category);

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.90;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    });
  }, [map, weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax]);

  drawRef.current = draw;

  useEffect(() => {
    const container = map.getPanes().overlayPane;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:450;";
    container.appendChild(canvas);
    canvasRef.current = canvas;
    const redraw = () => {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      canvas.style.transform = `translate(${topLeft.x}px,${topLeft.y}px)`;
      drawRef.current?.();
    };
    map.on("moveend zoomend resize", redraw);
    redraw();
    return () => { map.off("moveend zoomend resize", redraw); canvas.remove(); };
  }, [map]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    canvasRef.current.style.transform = `translate(${topLeft.x}px,${topLeft.y}px)`;
    draw();
  }, [draw]);

  return null;
}

// --- Mouse tracker ---
function MouseTracker({ weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax, onHover, onHillClick }) {
  const map = useMap();
  useMapEvents({
    mousemove(e) {
      const { lat, lng } = e.latlng;
      const cx = e.originalEvent.clientX, cy = e.originalEvent.clientY;
      const container = map.getContainer();

      if (lat < LAT_MIN || lat > LAT_MAX || lng < LON_MIN || lng > LON_MAX) {
        container.style.cursor = "default";
        onHover(null);
        return;
      }

      if (weatherData) {
        const overHill = pickSunnyHillAtScreen(map, weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax, cx, cy, 14);
        if (overHill) {
          container.style.cursor = "pointer";
          onHover({ type: "hill", hill: overHill, px: cx, py: cy });
          return;
        }
      }

      const point = getNearestGridPoint(lat, lng, weatherData);
      if (point) {
        container.style.cursor = "pointer";
        onHover({ type: "weather", ...point, px: cx, py: cy });
      } else {
        container.style.cursor = "default";
        onHover(null);
      }
    },
    mouseout() {
      map.getContainer().style.cursor = "default";
      onHover(null);
    },
    click(e) {
      if (!onHillClick || !weatherData) return;
      const { lat, lng } = e.latlng;
      if (lat < LAT_MIN || lat > LAT_MAX || lng < LON_MIN || lng > LON_MAX) {
        onHillClick(null);
        return;
      }
      const cx = e.originalEvent.clientX, cy = e.originalEvent.clientY;
      const hill = pickSunnyHillAtScreen(map, weatherData, maxCloud, filterAscMin, filterAscMax, filterRatMin, filterRatMax, cx, cy, 14);
      onHillClick(hill);
    },
  });
  return null;
}

// --- Fit map to Scotland ---
function BoundsFitter() {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(SCOTLAND_BOUNDS, { padding: [0, 0] });
    map.setMaxBounds([[LAT_MIN - 0.5, LON_MIN - 0.5], [LAT_MAX + 0.5, LON_MAX + 0.5]]);
  }, [map]);
  return null;
}

// --- Helpers ---
function getSunnyPercent(grid, threshold) {
  if (!grid) return 0;
  let total = 0, clear = 0;
  grid.forEach(row => row.forEach(v => { total++; if (v <= threshold) clear++; }));
  return Math.round((clear / total) * 100);
}
function isDaylight() { const h = new Date().getHours(); return h >= 6 && h <= 21; }
function cloudLabel(val) {
  if (val <= 20) return "Clear"; if (val <= 45) return "Partly cloudy";
  if (val <= 70) return "Mostly cloudy"; return "Overcast";
}

function StatBadge({ value, label }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#f5d060", fontFamily: "\'DM Serif Display\', Georgia, serif", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#a0b0c0", marginTop: 3, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}

function QuickFilter({ label, value, current, onClick }) {
  const active = current === value;
  return (
    <button onClick={() => onClick(value)} style={{
      padding: "5px 11px", borderRadius: 20,
      border: `1px solid ${active ? "#f5d060" : "rgba(255,255,255,0.15)"}`,
      background: active ? "rgba(245,208,96,0.15)" : "transparent",
      color: active ? "#f5d060" : "#8899aa", cursor: "pointer", fontSize: 12,
      fontFamily: "inherit", fontWeight: active ? 600 : 400, transition: "all 0.2s", whiteSpace: "nowrap",
    }}>{label}</button>
  );
}

/** Two thumbs on one scale (min ≤ max); uses overlapping native ranges + gold selected span */
function DualRangeSlider({ minBound, maxBound, step, low, high, onChange, minLabel, maxLabel }) {
  const span = Math.max(maxBound - minBound, 1e-9);
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  const fillLeft = ((lo - minBound) / span) * 100;
  const fillPct = Math.max(((hi - lo) / span) * 100, lo === hi ? 0.35 : 0);
  const clamp = v => Math.min(maxBound, Math.max(minBound, v));

  return (
    <div className="dual-range" role="group" aria-label={`${minLabel} to ${maxLabel}`}>
      <div style={{
        position: "absolute", left: 0, right: 0, top: 12, height: 4, borderRadius: 2,
        background: "rgba(255,255,255,0.12)", pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", left: `${fillLeft}%`, width: `${Math.min(100 - fillLeft, fillPct)}%`, top: 12, height: 4,
        borderRadius: 2, background: "rgba(245,208,96,0.55)", pointerEvents: "none",
      }} />
      <input
        type="range"
        min={minBound}
        max={maxBound}
        step={step}
        value={low}
        aria-label={minLabel}
        onChange={e => {
          const n = clamp(Number(e.target.value));
          onChange(Math.min(n, high), high);
        }}
        style={{ zIndex: 4 }}
      />
      <input
        type="range"
        min={minBound}
        max={maxBound}
        step={step}
        value={high}
        aria-label={maxLabel}
        onChange={e => {
          const n = clamp(Number(e.target.value));
          onChange(low, Math.max(n, low));
        }}
        style={{ zIndex: 5 }}
      />
    </div>
  );
}

function HillDetailPanel({ hill, onClose }) {
  const accent = hillStyle(hill.category).color;
  const ratingStr = Number.isFinite(hill.userRating) ? hill.userRating.toFixed(2) : "—";

  const row = (label, value, isLast) => (
    <div key={label} style={{
      display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", gap: 12, alignItems: "baseline",
      padding: "9px 0", borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.07)",
    }}>
      <span style={{ fontSize: 10, color: "#6a8aaa", letterSpacing: "0.07em", textTransform: "uppercase", fontWeight: 600 }}>
        {label}
      </span>
      <div style={{ fontSize: 13, color: "#e8f4ff", lineHeight: 1.45 }}>{value}</div>
    </div>
  );

  return (
    <div style={{
      position: "fixed", left: 1642, top: 0, zIndex: 1100,
      width: "min(360px, calc(100vw - 24px))",
      background: "rgba(10,22,36,0.96)", backdropFilter: "blur(14px)",
      border: `1px solid ${accent}55`, borderRadius: 14,
      boxShadow: "0 12px 40px rgba(0,0,0,0.55)", userSelect: "none",
      overflow: "hidden",
    }}>
      <div style={{
        padding: "12px 14px 10px", borderBottom: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10,
        background: `linear-gradient(135deg, ${accent}18 0%, transparent 55%)`,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: accent, fontFamily: "\'DM Serif Display\', Georgia, serif", lineHeight: 1.25 }}>
            ⛰ {hill.name}
          </div>
          <div style={{ fontSize: 11, color: "#8899aa", marginTop: 4 }}>
            {hill.category}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={{
          flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)",
          background: "rgba(255,255,255,0.06)", color: "#c8d8e8", cursor: "pointer", fontSize: 18, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", padding: 0,
        }}>×</button>
      </div>
      <div style={{ padding: "4px 14px 14px" }}>
        {row("Altitude", `${hill.alt.toLocaleString("en-GB", { maximumFractionDigits: 1 })} m`, false)}
        {row("User rating", `${ratingStr} / 5`, false)}
        {row("Ascents", hill.ascents.toLocaleString("en-GB"), false)}
        {row("Latitude", `${hill.lat.toFixed(6)}°`, false)}
        {row("Longitude", `${hill.lon.toFixed(6)}°`, false)}
        {row("Walkhighlands", (
          <a href={hill.url} target="_blank" rel="noopener noreferrer" style={{ color: "#7ec8ff", wordBreak: "break-all" }}>
            {hill.url}
          </a>
        ), true)}
      </div>
      <div style={{ padding: "0 14px 12px", fontSize: 10, color: "#5a7a9a", lineHeight: 1.4 }}>
        Click an empty area of the map to close
      </div>
    </div>
  );
}

// --- Main App ---
export default function App() {
  const [weatherData, setWeatherData] = useState(null);
  const [maxCloud, setMaxCloud] = useState(45);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showAll, setShowAll] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [selectedHill, setSelectedHill] = useState(null);
  const [filterAscentsMin, setFilterAscentsMin] = useState(HILL_METRIC_BOUNDS.ascMin);
  const [filterAscentsMax, setFilterAscentsMax] = useState(HILL_METRIC_BOUNDS.ascMax);
  const [filterRatingMin, setFilterRatingMin] = useState(HILL_METRIC_BOUNDS.ratMin);
  const [filterRatingMax, setFilterRatingMax] = useState(HILL_METRIC_BOUNDS.ratMax);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchWeatherGrid()
      .then(data => { setWeatherData(data); setLastUpdated(new Date(data.generated_at)); })
      .catch(err => { console.error(err); setError("Could not load weather data. Please try again."); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (!selectedHill) return;
    if (!hillPassesMetricFilters(selectedHill, filterAscentsMin, filterAscentsMax, filterRatingMin, filterRatingMax, HILL_METRIC_BOUNDS))
      setSelectedHill(null);
  }, [selectedHill, filterAscentsMin, filterAscentsMax, filterRatingMin, filterRatingMax]);

  const sunnyPct = weatherData ? getSunnyPercent(weatherData.grid, maxCloud) : 0;
  const sunnyhills = weatherData
    ? HILLS_DATA.filter(h =>
      getCloudCoverAtPoint(h.lat, h.lon, weatherData) <= maxCloud
      && hillPassesMetricFilters(h, filterAscentsMin, filterAscentsMax, filterRatingMin, filterRatingMax, HILL_METRIC_BOUNDS),
    ).length
    : 0;

  const quickFilters = [
    { label: "\u2600\uFE0F Clear", value: 20 },
    { label: "\u26C5 Partly", value: 45 },
    { label: "\uD83C\uDF25 Mostly", value: 70 },
    { label: "\u2601\uFE0F All", value: 100 },
  ];

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "#0a1628", height: "100vh", display: "flex", overflow: "hidden", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600&display=swap');
        .leaflet-container { background: #0d2137 !important; cursor: default; }
        input[type=range] { accent-color: #f5d060; }
        .dual-range { position: relative; height: 28px; margin: 4px 0 2px; }
        .dual-range input[type=range] {
          position: absolute; left: 0; right: 0; top: 0; width: 100%; height: 28px; margin: 0;
          -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none;
        }
        .dual-range input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; pointer-events: auto; width: 15px; height: 15px; border-radius: 50%;
          background: #f5d060; border: 2px solid #0a1628; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.35);
          margin-top: -5px;
        }
        .dual-range input[type=range]::-webkit-slider-runnable-track {
          height: 4px; background: transparent; border: none;
        }
        .dual-range input[type=range]::-moz-range-thumb {
          pointer-events: auto; width: 15px; height: 15px; border-radius: 50%; box-sizing: border-box;
          background: #f5d060; border: 2px solid #0a1628; cursor: pointer;
        }
        .dual-range input[type=range]::-moz-range-track { height: 4px; background: transparent; border: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .sidebar-scroll::-webkit-scrollbar { width: 4px; }
        .sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
        .sidebar-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        .sidebar-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}</style>

      {error && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "rgba(180,40,40,0.92)", color: "#fff",
          padding: "10px 18px", fontSize: 13, textAlign: "center",
          backdropFilter: "blur(6px)",
        }}>
          ⚠️ {error}
          <button onClick={loadData} style={{ marginLeft: 14, color: "#fff", background: "rgba(255,255,255,0.18)", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}>Retry</button>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <div style={{
        width: sidebarOpen ? 300 : 0,
        minWidth: sidebarOpen ? 300 : 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "rgba(8, 18, 32, 0.98)",
        borderRight: "1px solid rgba(255,255,255,0.07)",
        boxShadow: "4px 0 24px rgba(0,0,0,0.4)",
        overflow: "hidden",
        transition: "width 0.25s ease, min-width 0.25s ease",
        zIndex: 1000,
        flexShrink: 0,
        userSelect: "none",
      }}>

        {/* Header */}
        <div style={{
          padding: "18px 16px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          background: "linear-gradient(180deg, rgba(245,208,96,0.06) 0%, transparent 100%)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#f0e8d0", fontFamily: "'DM Serif Display', Georgia, serif", lineHeight: 1.2 }}>
                ☀️ Scotland Sunshine
              </div>
              <div style={{ fontSize: 10, color: "#4a6a8a", marginTop: 4, lineHeight: 1.4 }}>
                {isDaylight() ? "🌅 Daylight hours" : "🌙 After dark"}{" · "}
                {lastUpdated
                  ? lastUpdated.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })
                  : loading ? "Fetching weather…" : "—"}
              </div>
            </div>
            <button
              onClick={loadData}
              disabled={loading}
              title="Refresh weather data"
              style={{
                flexShrink: 0, width: 32, height: 32, borderRadius: 8,
                border: "1px solid rgba(245,208,96,0.25)",
                background: "rgba(245,208,96,0.08)", color: "#f5d060",
                cursor: loading ? "not-allowed" : "pointer", fontSize: 15,
                display: "flex", alignItems: "center", justifyContent: "center",
                opacity: loading ? 0.5 : 1,
              }}
            >
              <span style={loading ? { display: "inline-block", animation: "spin 0.8s linear infinite" } : {}}>⟳</span>
            </button>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 0, marginTop: 14, borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
            {[
              { value: `${sunnyPct}%`, label: "Sunny area" },
              { value: sunnyhills, label: "Sunny hills" },
              { value: cloudLabel(maxCloud), label: "Threshold" },
            ].map(({ value, label }, i) => (
              <div key={label} style={{
                flex: 1, textAlign: "center", padding: "8px 4px",
                borderRight: i < 2 ? "1px solid rgba(255,255,255,0.07)" : "none",
                background: "rgba(255,255,255,0.02)",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f5d060", fontFamily: "'DM Serif Display', Georgia, serif", lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 9, color: "#4a6a8a", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable filter body */}
        <div className="sidebar-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>

          {/* ── Cloud filter section ── */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 13 }}>☁️</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#a0b0c0", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cloud filter</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 10 }}>
              {quickFilters.map(f => <QuickFilter key={f.value} label={f.label} value={f.value} current={maxCloud} onClick={setMaxCloud} />)}
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: "#8899aa" }}>Max cloud cover</span>
                <span style={{ fontSize: 11, color: "#f5d060", fontWeight: 600 }}>{maxCloud}%</span>
              </div>
              <input type="range" min="0" max="100" value={maxCloud} onChange={e => setMaxCloud(Number(e.target.value))} style={{ width: "100%" }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4a6a8a", marginTop: 1 }}>
                <span>Clear</span><span>Overcast</span>
              </div>
            </div>

            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <div onClick={() => setShowAll(v => !v)} style={{
                width: 32, height: 18, borderRadius: 9,
                background: showAll ? "rgba(245,208,96,0.3)" : "rgba(255,255,255,0.08)",
                border: `1px solid ${showAll ? "#f5d060" : "rgba(255,255,255,0.12)"}`,
                position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 0.2s",
              }}>
                <div style={{ position: "absolute", top: 2, left: showAll ? 14 : 2, width: 12, height: 12, borderRadius: "50%", background: showAll ? "#f5d060" : "#4a6a8a", transition: "left 0.2s" }} />
              </div>
              <span onClick={() => setShowAll(v => !v)} style={{ fontSize: 11, color: "#8899aa", cursor: "pointer", lineHeight: 1.35 }}>
                Dim cloudy areas when filtered
              </span>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", marginBottom: 18 }} />

          {/* ── Hill filters section ── */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13 }}>⛰️</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: "#a0b0c0", textTransform: "uppercase", letterSpacing: "0.08em" }}>Hill filters</span>
              </div>
              <button type="button" onClick={() => {
                setFilterAscentsMin(HILL_METRIC_BOUNDS.ascMin);
                setFilterAscentsMax(HILL_METRIC_BOUNDS.ascMax);
                setFilterRatingMin(HILL_METRIC_BOUNDS.ratMin);
                setFilterRatingMax(HILL_METRIC_BOUNDS.ratMax);
              }} style={{
                padding: "3px 9px", borderRadius: 6, fontSize: 10, fontFamily: "inherit",
                border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#6a8aaa", cursor: "pointer",
              }}>Reset</button>
            </div>
            <div style={{ fontSize: 10, color: "#3a5a72", marginBottom: 10, lineHeight: 1.4 }}>
              Filter by Walkhighlands ascents and user rating.
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ fontSize: 11, color: "#8899aa" }}>Ascents (popularity)</span>
                <span style={{ fontSize: 11, color: "#f5d060", fontWeight: 600 }}>
                  {filterAscentsMin.toLocaleString("en-GB")} – {filterAscentsMax.toLocaleString("en-GB")}
                </span>
              </div>
              <DualRangeSlider
                minBound={HILL_METRIC_BOUNDS.ascMin}
                maxBound={HILL_METRIC_BOUNDS.ascMax}
                step={1}
                low={filterAscentsMin}
                high={filterAscentsMax}
                minLabel="Minimum ascents"
                maxLabel="Maximum ascents"
                onChange={(lo, hi) => { setFilterAscentsMin(lo); setFilterAscentsMax(hi); }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#3a5a72", marginTop: 1 }}>
                <span>{HILL_METRIC_BOUNDS.ascMin.toLocaleString("en-GB")}</span>
                <span>{HILL_METRIC_BOUNDS.ascMax.toLocaleString("en-GB")}</span>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ fontSize: 11, color: "#8899aa" }}>User rating</span>
                <span style={{ fontSize: 11, color: "#f5d060", fontWeight: 600 }}>
                  {filterRatingMin.toFixed(2)} – {filterRatingMax.toFixed(2)} <span style={{ color: "#4a6a8a", fontWeight: 500 }}>/ 5</span>
                </span>
              </div>
              <DualRangeSlider
                minBound={HILL_METRIC_BOUNDS.ratMin}
                maxBound={HILL_METRIC_BOUNDS.ratMax}
                step={0.01}
                low={filterRatingMin}
                high={filterRatingMax}
                minLabel="Minimum user rating"
                maxLabel="Maximum user rating"
                onChange={(lo, hi) => { setFilterRatingMin(lo); setFilterRatingMax(hi); }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#3a5a72", marginTop: 1 }}>
                <span>{HILL_METRIC_BOUNDS.ratMin.toFixed(2)}</span>
                <span>{HILL_METRIC_BOUNDS.ratMax.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", marginBottom: 18 }} />

          {/* ── Legend ── */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 13 }}>🗺️</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#a0b0c0", textTransform: "uppercase", letterSpacing: "0.08em" }}>Legend</span>
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#5a7a9a", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>Cloud cover</div>
            <div style={{ width: "100%", height: 8, borderRadius: 4, marginBottom: 4, background: "linear-gradient(to right, rgba(255,220,40,0.82), rgba(235,185,75,0.68), rgba(170,160,175,0.50), rgba(70,100,150,0.32))" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4a6a8a", marginBottom: 12 }}>
              <span>Clear</span><span>Partly</span><span>Mostly</span><span>Overcast</span>
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#5a7a9a", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>Hills</div>
            {[
              { color: "#ff6b3d", label: "Munro (M / MT)" },
              { color: "#ffaa44", label: "Corbett (C)" },
              { color: "#ffe066", label: "Other hill" },
            ].map(({ color, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0, boxShadow: `0 0 5px ${color}88` }} />
                <span style={{ fontSize: 11, color: "#8899aa" }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar footer */}
        <div style={{
          padding: "10px 16px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          fontSize: 10, color: "#2a4a62", lineHeight: 1.4,
          flexShrink: 0,
        }}>
          Open-Meteo · Live data · Scotland
        </div>
      </div>

      {/* ── SIDEBAR TOGGLE ── */}
      <button
        onClick={() => setSidebarOpen(v => !v)}
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        style={{
          position: "fixed",
          left: sidebarOpen ? 810 : 510,
          top: "50%",
          transform: "translateY(-50%)",
          zIndex: 1100,
          width: 22,
          height: 44,
          borderRadius: sidebarOpen ? "0 8px 8px 0" : "8px",
          border: "1px solid rgba(255,255,255,0.1)",
          background: "rgba(8,18,32,0.95)",
          color: "#5a7a9a",
          cursor: "pointer",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "left 0.25s ease",
          backdropFilter: "blur(8px)",
          boxShadow: "2px 0 12px rgba(0,0,0,0.3)",
          padding: 0,
        }}
      >
        {sidebarOpen ? "‹" : "›"}
      </button>

      {/* ── MAP ── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

        {selectedHill && (
          <HillDetailPanel hill={selectedHill} onClose={() => setSelectedHill(null)} />
        )}

        {/* Tooltip */}
        {hovered && (
          <div style={{
            position: "fixed", left: hovered.px + 14, top: hovered.py - 12,
            zIndex: 2000, background: "rgba(8,18,32,0.97)",
            border: `1px solid ${hovered.type === "hill" ? "rgba(255,170,68,0.4)" : "rgba(255,255,255,0.1)"}`,
            borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#d0e0f0",
            pointerEvents: "none", boxShadow: "0 4px 20px rgba(0,0,0,0.6)", lineHeight: 1.75,
            minWidth: hovered.type === "hill" ? 180 : "auto",
          }}>
            {hovered.type === "hill" ? (
              <>
                <div style={{ fontWeight: 700, color: hillStyle(hovered.hill.category).color, marginBottom: 3, fontSize: 13 }}>
                  ⛰ {hovered.hill.name}
                </div>
                <div>📏 Height: <strong>{Math.round(hovered.hill.alt)}m</strong></div>
                <div>🧗 Ascents: <strong>{hovered.hill.ascents.toLocaleString()}</strong></div>
                <div style={{ fontSize: 10, color: "#5a7a9a", marginTop: 2 }}>
                  {hillCategoryLabel(hovered.hill.category)} · {hovered.hill.lat.toFixed(4)}°N {Math.abs(hovered.hill.lon).toFixed(4)}°W
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: 1, color: "#f5d060" }}>{cloudLabel(hovered.cloudCover)}</div>
                <div>☁️ Cloud cover: <strong>{hovered.cloudCover}%</strong></div>
                <div style={{ fontSize: 10, color: "#5a7a9a", marginTop: 1 }}>
                  {hovered.lat.toFixed(2)}°N · {Math.abs(hovered.lon).toFixed(2)}°W
                </div>
              </>
            )}
          </div>
        )}

        <MapContainer center={SCOTLAND_CENTER} zoom={7} style={{ height: "100%", width: "100%" }}
          zoomControl={false} maxBoundsViscosity={1.0} minZoom={6}>
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" attribution='&copy; <a href="https://carto.com">CARTO</a>' />
          <BoundsFitter />
          {weatherData && (
            <>
              <HeatmapOverlay weatherData={weatherData} maxCloud={maxCloud} showAll={showAll} />
              <HillsOverlay
                weatherData={weatherData}
                maxCloud={maxCloud}
                filterAscMin={filterAscentsMin}
                filterAscMax={filterAscentsMax}
                filterRatMin={filterRatingMin}
                filterRatMax={filterRatingMax}
              />
              <MouseTracker
                weatherData={weatherData}
                maxCloud={maxCloud}
                filterAscMin={filterAscentsMin}
                filterAscMax={filterAscentsMax}
                filterRatMin={filterRatingMin}
                filterRatMax={filterRatingMax}
                onHover={setHovered}
                onHillClick={hill => setSelectedHill(hill)}
              />
            </>
          )}
        </MapContainer>
      </div>
    </div>
  );
}