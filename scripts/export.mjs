// Usage: node scripts/export.mjs <city> [speedFactor] [port]
// Streams Valhalla's /expansion (8h of road edges) into public/data/<city>.bin + .json
import { writeFileSync, mkdirSync } from 'node:fs';

const CITIES = {
  bengaluru: { lat: 12.9716, lon: 77.5946 },
  delhi:     { lat: 28.6139, lon: 77.2090 },
  mumbai:    { lat: 19.0760, lon: 72.8777 },
  kolkata:   { lat: 22.5726, lon: 88.3639 },
};
const ZOOM = 6.3; // same scale for every city

const city = process.argv[2];
const speedFactor = parseFloat(process.argv[3] ?? '0.75'); // share of Valhalla's free-flow speed actually achieved
const port = process.argv[4] ?? '8802';
if (!CITIES[city]) { console.error('city must be one of', Object.keys(CITIES).join(', ')); process.exit(1); }
const { lat, lon } = CITIES[city];

const body = {
  locations: [{ lat, lon }],
  costing: 'auto',
  contours: [{ time: 480 * speedFactor }], // budget in Valhalla minutes that equals 8h at our slower real speed
  action: 'isochrone',
  expansion_properties: ['duration'],
  skip_opposites: true,
};

console.log('requesting expansion…');
const res = await fetch(`http://localhost:${port}/expansion`, { method: 'POST', body: JSON.stringify(body) });
if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }

const re = /\[\[(-?[\d.]+),(-?[\d.]+)\],\[(-?[\d.]+),(-?[\d.]+)\]\]\},"properties":\{"duration":(\d+)/g;
let tail = '';
const t = [], xy = [];
const dec = new TextDecoder();
let bytes = 0;
function consume(text) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    t.push(+m[5] / speedFactor);
    xy.push(+m[1], +m[2], +m[3], +m[4]);
  }
}
for await (const chunk of res.body) {
  bytes += chunk.length;
  const text = tail + dec.decode(chunk, { stream: true });
  const cut = text.lastIndexOf('{"type":"Feature"');
  if (cut <= 0) { tail = text; continue; }
  consume(text.slice(0, cut));
  tail = text.slice(cut);
  if (t.length % 500000 < 5000) process.stdout.write(`\r${(bytes / 1e6).toFixed(0)} MB, ${t.length.toLocaleString()} edges`);
}
consume(tail);
console.log(`\nparsed ${t.length.toLocaleString()} edges from ${(bytes / 1e6).toFixed(0)} MB`);

const n = t.length;
const off = new Uint32Array(n + 1);
for (let i = 0; i <= n; i++) off[i] = i * 2;
const hdr = new Uint32Array([n, n * 2]);
const out = Buffer.concat([
  Buffer.from(hdr.buffer), Buffer.from(off.buffer),
  Buffer.from(new Float32Array(t).buffer), Buffer.from(new Float32Array(xy).buffer),
]);
mkdirSync('public/data', { recursive: true });
writeFileSync(`public/data/${city}.bin`, out);
writeFileSync(`public/data/${city}.json`, JSON.stringify({
  city, origin: [lon, lat], speedFactor, edges: n,
  view: { center: [lon, lat], zoom: ZOOM },
}));
console.log(`wrote public/data/${city}.bin (${(out.length / 1e6).toFixed(1)} MB)`);
