// weatherApi.js
// -------------
// Drop this file into your src/ folder and import fetchWeatherGrid from here
// instead of the inline version in App.jsx.
//
// LOCAL DEV:  set VITE_API_URL=http://localhost:8000 in a .env.local file
// PRODUCTION: Render injects VITE_API_URL automatically via render.yaml
//
// The response shape from the backend is:
// {
//   step: 0.25,
//   generated_at: "2024-01-01T12:00:00Z",
//   points: [{ lat, lon, cloud_cover }, ...]
// }
//
// This function converts that into the { grid, lats, lons } format
// that the rest of App.jsx already expects — so nothing else needs to change.

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
// If you're using Create React App instead of Vite, use:
// const API_URL = process.env.REACT_APP_API_URL ?? "http://localhost:8000";

export async function fetchWeatherGrid() {
  const res = await fetch(`${API_URL}/cloud-cover`);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Backend error ${res.status}: ${err.detail ?? res.statusText}`);
  }

  const { step, generated_at, points } = await res.json();

  // Rebuild the lats/lons index arrays and 2-D grid that App.jsx expects.
  // We derive them from the actual points returned rather than recomputing
  // the bounding box, so they exactly match what the backend filtered.
  const latSet = new Set();
  const lonSet = new Set();
  points.forEach(({ lat, lon }) => { latSet.add(lat); lonSet.add(lon); });

  const lats = Array.from(latSet).sort((a, b) => a - b);
  const lons = Array.from(lonSet).sort((a, b) => a - b);

  // Build a lookup for fast index resolution
  const latIndex = Object.fromEntries(lats.map((v, i) => [v, i]));
  const lonIndex = Object.fromEntries(lons.map((v, i) => [v, i]));

  // Initialise grid to 100 (fully overcast) — ocean/unmapped cells stay at 100
  // which means they'll be invisible when the cloud threshold filter is applied
  const grid = lats.map(() => new Array(lons.length).fill(100));

  points.forEach(({ lat, lon, cloud_cover }) => {
    const li = latIndex[lat];
    const lo = lonIndex[lon];
    if (li !== undefined && lo !== undefined) {
      grid[li][lo] = cloud_cover;
    }
  });

  return { grid, lats, lons, generated_at };
}
