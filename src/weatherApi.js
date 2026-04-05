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
//   now_hour_utc: 14,
//   forecast_hours: 11,
//   hourly_points: [
//     [{ lat, lon, cloud_cover }, ...],  // offset 0
//     [{ lat, lon, cloud_cover }, ...],  // offset 1
//     ...
//   ]
// }
//
// This function converts that into the { hourlyGrids, lats, lons } format
// that the rest of App.jsx expects.

export async function fetchWeatherGrid() {
  const res = await fetch("/cloud-cover");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchWeatherGrid() {
  const res = await fetch(`${API_URL}/cloud-cover`);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Backend error ${res.status}: ${err.detail ?? res.statusText}`);
  }

  const body = await res.json();
  const {
    step,
    generated_at,
    now_hour_utc,
    forecast_hours,
    hourly_points,
  } = body;

  const latSet = new Set();
  const lonSet = new Set();
  hourly_points[0].forEach(({ lat, lon }) => { latSet.add(lat); lonSet.add(lon); });

  const lats = Array.from(latSet).sort((a, b) => a - b);
  const lons = Array.from(lonSet).sort((a, b) => a - b);

  const latIndex = Object.fromEntries(lats.map((v, i) => [v, i]));
  const lonIndex = Object.fromEntries(lons.map((v, i) => [v, i]));

  const hourlyGrids = hourly_points.map(points =>
    lats.map(() => new Array(lons.length).fill(100))
  );

  hourly_points.forEach((points, offset) => {
    points.forEach(({ lat, lon, cloud_cover }) => {
      const li = latIndex[lat];
      const lo = lonIndex[lon];
      if (li !== undefined && lo !== undefined) {
        hourlyGrids[offset][li][lo] = cloud_cover;
      }
    });
  });

  return {
    hourlyGrids,
    lats,
    lons,
    generated_at,
    now_hour_utc,
    forecast_hours,
    step,
  };
}
