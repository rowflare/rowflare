// Reproduces the 2026-10-12 Durable Object load test against the real Rowflare engine.
// Usage: BENCH_TOKEN=... node bench/run.mjs [baseUrl] [rows]
//   baseUrl defaults to http://127.0.0.1:8787, rows to 50000 (125000 for the Business-size run).
// Per-op latency = (median(op) - median(noop)) / reps, timed inside the Worker around the DO call.
// Numbers from `wrangler dev` are not comparable to production: local clocks advance during SQL.
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const rows = Number(process.argv[3] ?? 50000);
const token = process.env.BENCH_TOKEN;
if (!token) throw new Error("Set BENCH_TOKEN (the same value as the Worker secret)");
const name = `bench${rows}`;
const projects = Math.round(rows / 25);

async function call(path) {
  const res = await fetch(`${base}/api/_bench/${path}${path.includes("?") ? "&" : "?"}base=${name}`, { headers: { "x-bench-token": token } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const stats = await call("stats").catch(() => null);
if (!stats || stats.tasks < rows) {
  const start = stats?.tasks ?? 0;
  for (let off = start; off < rows; off += 5000) {
    const t = Date.now();
    const r = await call(`seed?n=${Math.min(5000, rows - off)}&offset=${off}&nprojects=${projects}`);
    console.log(`seeded ${r.tasks} rows (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
}
console.log("finalize", await call("finalize"));

const OPS = [
  ["first_page", "Open view first page (300 ids + count)"],
  ["all_ids", "Load full id list of a 50k view"],
  ["edit_cell_rollup", "Edit a cell + rollup update"],
  ["rename_project_lookup", "Rename project + lookup update"],
  ["filter", "Filter by any field"],
  ["sort", "Sort by any field"],
  ["filter_sort", "Filter + sort"],
  ["search", "Search"],
  ["group", "Kanban group counts"],
  ["aggregate", "Group by a select field with count and sum (aggregate)"],
  ["calendar_month", "Calendar month window (6 weeks, 2,000 rows inline)"],
  ["group_two_sum", "Grid grouped by 2 fields + sum summaries"],
  ["dashboard_8", "Dashboard: 8 widgets, cache empty"],
  ["dashboard_8_cached", "Dashboard: 8 widgets, cached"],
  ["paste_1000", "Paste 1,000 rows and delete them"],
  ["rollup_full", "Full rollup recompute"],
  ["formula_full", "Full formula column recompute"],
  ["formula_batch", "One 500-row recompute batch (what others wait behind)"],
];

const out = [];
for (const [op, label] of OPS) {
  const probe = await call(`time?name=${op}&reps=1&trials=3`);
  const est = Math.max(1, median(probe.op_ms) - median(probe.noop_ms));
  const reps = op.endsWith("_full") ? 1 : Math.max(1, Math.min(50, Math.round(1500 / est)));
  const r = await call(`time?name=${op}&reps=${reps}&trials=7&salt=1000`);
  const perOp = (median(r.op_ms) - median(r.noop_ms)) / reps;
  out.push({ op: label, ms: Math.round(perOp * 100) / 100, reps, out: JSON.stringify(r.out) });
  console.log(`${label.padEnd(56)} ${perOp.toFixed(2).padStart(9)} ms  (reps ${reps})`);
}
// Automations: the same edit and paste with three record triggers, and executing queued runs.
await call("auto_on");
const AUTO_OPS = [
  ["edit_cell_rollup", "Edit a cell + rollup update, 3 record triggers"],
  ["paste_1000", "Paste 1,000 rows and delete them, 3 record triggers (1,000 runs recorded)"],
  ["drain_100", "Execute 100 queued runs that update their record"],
];
for (const [op, label] of AUTO_OPS) {
  const probe = await call(`time?name=${op}&reps=1&trials=3`);
  const est = Math.max(1, median(probe.op_ms) - median(probe.noop_ms));
  const reps = Math.max(1, Math.min(50, Math.round(1500 / est)));
  const r = await call(`time?name=${op}&reps=${reps}&trials=7&salt=2000`);
  const perOp = (median(r.op_ms) - median(r.noop_ms)) / reps;
  out.push({ op: label, ms: Math.round(perOp * 100) / 100, reps, out: JSON.stringify(r.out) });
  console.log(`${label.padEnd(56)} ${perOp.toFixed(2).padStart(9)} ms  (reps ${reps})`);
}
await call("auto_off");
// AI fields: the same edit and paste with two auto-updating AI fields (cells are queued, nothing is called).
await call("ai_on");
const AI_OPS = [
  ["edit_cell_rollup", "Edit a cell + rollup update, 2 AI fields"],
  ["paste_1000", "Paste 1,000 rows and delete them, 2 AI fields (2,000 cells queued)"],
];
for (const [op, label] of AI_OPS) {
  const probe = await call(`time?name=${op}&reps=1&trials=3`);
  const est = Math.max(1, median(probe.op_ms) - median(probe.noop_ms));
  const reps = Math.max(1, Math.min(50, Math.round(1500 / est)));
  const r = await call(`time?name=${op}&reps=${reps}&trials=7&salt=3000`);
  const perOp = (median(r.op_ms) - median(r.noop_ms)) / reps;
  out.push({ op: label, ms: Math.round(perOp * 100) / 100, reps, out: JSON.stringify(r.out) });
  console.log(`${label.padEnd(56)} ${perOp.toFixed(2).padStart(9)} ms  (reps ${reps})`);
}
await call("ai_off");

console.log("\n| Action | ms |\n|---|---|");
for (const r of out) console.log(`| ${r.op} | ${r.ms} |`);
console.log("\nstats", await call("stats"));
