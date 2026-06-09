import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.append(str(Path(__file__).resolve().parents[1]))

from main import cloud_cover, weather_cache


class WeatherBackendTests(unittest.TestCase):
    def setUp(self):
        weather_cache.clear()

    def test_cloud_cover_returns_cached_data_when_upstream_fetch_fails(self):
        cached_payload = {
            "step": 0.15,
            "generated_at": "2024-01-01T00:00:00Z",
            "now_hour_utc": 10,
            "forecast_hours": 3,
            "hourly_points": [[{"lat": 54.63, "lon": -7.6, "cloud_cover": 12}]],
        }
        weather_cache["cloud_cover"] = (datetime.now(timezone.utc), cached_payload)

        with patch("main.build_land_grid", return_value=[(54.63, -7.6)]), patch("main.fetch_cloud_cover", side_effect=RuntimeError("boom")):
            response = cloud_cover()

        self.assertEqual(response["generated_at"], cached_payload["generated_at"])


if __name__ == "__main__":
    unittest.main()
