# ── Stage 1: Build the React frontend ──────────────────────────────────────
FROM node:20-slim AS frontend-build

WORKDIR /app

# Copy package files first so npm install is cached unless they change
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the frontend source and build
COPY . .
RUN npm run build
# Output is in /app/dist


# ── Stage 2: Python backend ─────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /backend

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend source
COPY backend/main.py .
COPY backend/scotland.geojson .
COPY backend/land_grid.json .

# Copy the built frontend from Stage 1
COPY --from=frontend-build /app/dist ./dist

# Render sets the PORT environment variable. Default to 8000 for local use.
ENV PORT=8000

EXPOSE $PORT

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port $PORT"]