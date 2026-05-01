#!/usr/bin/env node
const base = process.argv[2] || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 3470}`;

async function check(path, predicate) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const json = await response.json();
  if (predicate && !predicate(json)) throw new Error(`${path} failed payload check`);
  return json;
}

await check('/api/health', (json) => json.ok && Array.isArray(json.adapters));
await check('/api/summary', (json) => json.metrics && json.status && json.operations);
await check('/api/metrics/messages', (json) => {
  const raw = JSON.stringify(json);
  return !raw.includes('endpoint_id') && !raw.includes('raw_content') && !raw.includes('"content"');
});
await check('/api/metrics/pm2_services', (json) => {
  const raw = JSON.stringify(json);
  return !raw.includes('pm_exec_path') && !raw.includes('outLog') && !raw.includes('errorLog');
});

console.log(`dashboard API smoke ok: ${base}`);
