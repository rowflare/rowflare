// Runs the whole test suite with the JSON reporter and records per-feature test counts in docs/verification/results.json.
// Usage: npm run verify [-- --list]   (--list prints which tests count toward each feature)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const RESULTS = "docs/verification/results.json";
const TITLES = { ai: "AI fields", automations: "Automations", dashboards: "Dashboards", views: "Calendar, timeline, gallery and grid grouping", mcp: "MCP server", hosting: "Plan limits, account emails and hosting extensions", signin: "Email code sign-in and sign-in options", core: "Core engine and API" };
// First match wins, so feature-specific files come before the name rules that pick part 2 tests out of the shared engine and API files.
// The aggregate engine tests in engine.test.ts came with part 1 (the MCP aggregate tool).
const MCP_ENGINE = /aggregates without grouping|aggregates a rollup and applies filters|buckets dates and takes date min and max|extraFilters narrows a view filter|groups by select, multi select fan-out and links|rejects bad metrics and caps groups|returns one zero group for no rows/;
const FEATURES = [
  { feature: "signin", match: t => /(accounts|email-code|sign-in)\.test\.ts$/.test(t.file) || /sign-in options/.test(t.name) },
  { feature: "hosting", match: t => /(hosting|limits|account-mail|limit-toast)\.test\.ts$/.test(t.file) },
  { feature: "ai", match: t => /(\/ai|ai-[a-z]+|automation-ai|mcp-ai)\.test\.ts$/.test(t.file) || /AI step|AI steps|AI step outputs/.test(t.name) },
  { feature: "automations", match: t => /(automations|automation-[a-z]+|mcp-automations|button-field|template|schedule|http|mail|flow)\.test\.ts$/.test(t.file) },
  { feature: "dashboards", match: t => /(dashboards|mcp-dashboards|widgets|dash)\.test\.ts$/.test(t.file) },
  { feature: "mcp", match: t => (/mcp\.test\.ts$/.test(t.file) && !/calendar|timeline|gallery/i.test(t.name)) || (/engine\.test\.ts$/.test(t.file) && MCP_ENGINE.test(t.name)) },
  { feature: "views", match: t => /(dates|gridGroups|lanes)\.test\.ts$/.test(t.file) || /\brange\b|group levels|calendar|timeline|gallery|grouped rows|view reference|honors search|grouped aggregates|without fan-out/i.test(t.name) },
  { feature: "core", match: () => true },
];

const out = join(mkdtempSync(join(tmpdir(), "rf-verify-")), "vitest.json");
try {
  execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], { stdio: ["ignore", "ignore", "inherit"] });
} catch {
  // Failing tests still write the report; they are counted below.
}
const report = JSON.parse(readFileSync(out, "utf8"));
const tests = report.testResults.flatMap(f => f.assertionResults.map(a => ({ file: relative(process.cwd(), f.name), name: a.fullName ?? a.title, status: a.status })));
const by = Object.fromEntries(FEATURES.map(f => [f.feature, []]));
for (const t of tests) by[FEATURES.find(f => f.match(t)).feature].push(t);

if (process.argv.includes("--list")) {
  for (const [k, list] of Object.entries(by)) console.log(`\n## ${k} (${list.length})\n` + list.map(t => `  ${t.status === "passed" ? "ok  " : "FAIL"} ${t.file} > ${t.name}`).join("\n"));
}

let results = [];
try {
  results = JSON.parse(readFileSync(RESULTS, "utf8"));
} catch {
  // First run.
}
const date = new Date().toISOString().slice(0, 10);
for (const [feature, list] of Object.entries(by)) {
  let entry = results.find(r => r.feature === feature);
  if (!entry) results.push((entry = { feature, title: TITLES[feature], bench: [], scenarios: [] }));
  entry.date = date;
  entry.tests = { files: new Set(list.map(t => t.file)).size, total: list.length, passed: list.filter(t => t.status === "passed").length, failed: list.filter(t => t.status === "failed").length };
}
writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
for (const r of results) console.log(`${r.feature.padEnd(11)} ${r.tests.passed}/${r.tests.total} passed in ${r.tests.files} files`);
if (tests.some(t => t.status === "failed")) process.exitCode = 1;
