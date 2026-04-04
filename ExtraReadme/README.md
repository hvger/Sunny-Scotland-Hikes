# Scotland Weather Backend

Python FastAPI backend for the Scotland Sunshine app.
Filters a lat/lon grid to land-only points using the Scotland LAD GeoJSON boundary,
then fetches cloud cover from Open-Meteo for only those points.

---

## Local Setup

### 1. Place your GeoJSON file

Rename your downloaded `topo_lad.json` to `scotland.geojson` and place it
in the `backend/` folder next to `main.py`.

### 2. Inspect the GeoJSON (optional but recommended)

Run this first to confirm the file has the expected property keys:

```bash
cd backend
python inspect_geojson.py
```

You should see output like:
```
Total features: 380
Found 32 Scottish features using key 'LAD13CD'
Example names:
  {'LAD13CD': 'S12000033', 'LAD13NM': 'Aberdeen City', ...}
```

If the key name is different, update the `code_keys` list in `main.py`'s
`load_scotland_polygon()` function.

### 3. Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 4. Run the backend

```bash
uvicorn main:app --reload --port 8000
```

Visit http://localhost:8000/docs for the auto-generated API docs.
Visit http://localhost:8000/grid-preview to see the land grid as GeoJSON
(paste into geojson.io to visualise it).

---

## Frontend Integration

### 1. Copy weatherApi.js into your frontend src/ folder

### 2. Create a .env.local file in your frontend folder:

```
VITE_API_URL=http://localhost:8000
```
(Use `REACT_APP_API_URL` instead if you're using Create React App)

### 3. Update App.jsx

Replace the inline `fetchWeatherGrid` function and its import with:

```js
import { fetchWeatherGrid } from "./weatherApi";
```

That's it — the returned `{ grid, lats, lons }` shape is identical to before.

---

## Deploying to Render

### Repository structure

```
/                          ← GitHub repo root
├── render.yaml
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── inspect_geojson.py
│   └── scotland.geojson   ← commit this too (it's only 1MB)
└── frontend/
    ├── src/
    │   ├── App.jsx
    │   ├── weatherApi.js
    │   └── ...
    └── package.json
```

### Steps

1. Push the full repo to GitHub
2. Go to https://render.com → New → Blueprint
3. Connect your GitHub repo — Render reads `render.yaml` automatically
4. It will create two services: `scotland-weather-api` (Python) and
   `scotland-weather` (static site)
5. After first deploy, update the `FRONTEND_URL` env var on the backend
   service to your actual frontend URL (shown on the Render dashboard)
6. Update `VITE_API_URL` on the frontend service to your backend URL

### Free tier note

Render's free tier spins down services after 15 minutes of inactivity.
The first request after a cold start may take 30-60 seconds while the
server wakes up. For personal use this is fine; for always-on, upgrade
to the $7/month Starter tier.

---

## Tuning the grid resolution

Edit `STEP` in `main.py`:

| STEP  | ~Land points | API credits/load |
|-------|-------------|-----------------|
| 0.25° | ~170        | ~170            |
| 0.2°  | ~270        | ~270            |
| 0.15° | ~480        | ~480            |
| 0.1°  | ~1050       | ~1050           |

Run `/grid-preview` after changing STEP to visualise the result.
