import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const csvPath = path.join(root, "src", "hills_cleaned_unique.csv");
const outPath = path.join(root, "src", "hills_data.json");

function parseHillLine(line) {
  const lastComma = line.lastIndexOf(",");
  const ascents = parseInt(line.slice(lastComma + 1), 10);
  let rest = line.slice(0, lastComma);
  let classification;
  const quoted = rest.match(/,"([^"]*)"$/);
  if (quoted) {
    classification = quoted[1];
    rest = rest.slice(0, quoted.index);
  } else {
    const c = rest.lastIndexOf(",");
    classification = rest.slice(c + 1);
    rest = rest.slice(0, c);
  }
  const bits = rest.split(",");
  const lon = parseFloat(bits.pop());
  const lat = parseFloat(bits.pop());
  const height = parseFloat(bits.pop());
  const name = bits.join(",");
  return { name, height, lat, lon, classification, ascents };
}

const text = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const rows = [];
for (let i = 1; i < text.length; i++) {
  const line = text[i];
  const { name, height, lat, lon, classification, ascents } = parseHillLine(line);
  const parts = classification.split(",").map((s) => s.trim());
  let category = "hill";
  if (parts.includes("M") || parts.includes("MT") || parts.includes("xMT")) category = "munro";
  else if (parts.includes("C")) category = "corbett";
  rows.push({
    name,
    height: parseFloat(height),
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    category,
    ascents: parseInt(ascents, 10),
    classification,
  });
}
fs.writeFileSync(outPath, JSON.stringify(rows));
console.log("wrote", rows.length, "hills to", outPath);
