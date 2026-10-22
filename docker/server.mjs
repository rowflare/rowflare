// Runs the Rowflare Worker outside Cloudflare, in workerd via Miniflare.
// Durable Objects, D1 and R2 are stored on local disk under DATA_DIR.
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bundleDir = path.join(root, "dist/worker");
const optionsPath = path.join(bundleDir, "miniflare.json");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));

if (!existsSync(optionsPath)) {
  console.error(`${optionsPath} not found. Run "npm run build:docker" first.`);
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });

// Environment variables that the Worker reads; see docs/self-hosting.md.
const VARS = ["MODE", "ALLOW_SIGNUP", "APP_URL", "BENCH_TOKEN", "SECRET_KEY", "AUTOMATION_ALLOW_PRIVATE", "AUTOMATION_MONTHLY_RUNS", "AI_WORKERS_MONTHLY_CALLS", "MAIL_PROVIDER", "MAIL_FROM", "RESEND_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USERNAME", "SMTP_PASSWORD"];
const bindings = { MODE: "selfhost", ALLOW_SIGNUP: "false" };
for (const name of VARS) if (process.env[name]) bindings[name] = process.env[name];

// Written by docker/export-options.mjs from wrangler.jsonc.
const { options, modules, cronTriggers } = JSON.parse(readFileSync(optionsPath, "utf8"));

/** Loopback, private, link-local and shared ranges (IPv4, IPv6 and IPv4-mapped IPv6). */
function privateAddress(ip) {
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]);
  if (isIP(ip) === 6) return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function publicOnly(request) {
  const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    return Response.error();
  }
  if (addresses.some(a => privateAddress(a.address))) return new Response("Requests to private network addresses are not allowed", { status: 403, headers: { "x-rowflare-blocked": "private" } });
  // The request comes from Miniflare's fetch implementation, so it is rebuilt for Node's.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(request.url, { method: request.method, headers: [...request.headers], body, redirect: "manual" });
}

const mf = new Miniflare(
  convertV4MiniflareOptions({
    host,
    port,
    resourcePersistencePath: dataDir,
    // Skip fetching request.cf metadata from Cloudflare on every start.
    cf: false,
    log: new Log(process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO),
    workers: [
      {
        ...options,
        name: "rowflare",
        bindings,
        modules: modules.map(m => ({ ...m, path: path.join(bundleDir, m.path) })),
        modulesRoot: bundleDir,
        assets: { ...options.assets, directory: path.join(root, options.assets.directory) },
        // Automation HTTP steps check addresses before sending, but a host name can still point at a private
        // address, so outgoing requests are resolved here and refused when any address is private.
        ...(process.env.AUTOMATION_ALLOW_PRIVATE === "true" ? {} : { outboundService: publicOnly }),
      },
    ],
  }),
);

const url = await mf.ready;
console.log(`Rowflare listening on ${url} (mode ${bindings.MODE}, data in ${dataDir})`);

// workerd does not fire cron triggers by itself, so dispatch them from here.
// Rowflare only uses the minute and hour fields; the other fields are treated as "*".
function cronMatches(expr, now) {
  const [min, hour] = expr.split(/\s+/);
  const ok = (field, value) => field === "*" || field.split(",").some(v => Number(v) === value);
  return ok(min, now.getUTCMinutes()) && ok(hour, now.getUTCHours());
}

async function tick() {
  const now = new Date();
  for (const cron of cronTriggers) {
    if (!cronMatches(cron, now)) continue;
    try {
      const worker = await mf.getWorker("rowflare");
      const result = await worker.scheduled({ cron, scheduledTime: now });
      if (result.outcome === "ok") console.log(`Cron ${cron} ran`);
      else console.error(`Cron ${cron} finished with outcome ${result.outcome}`);
    } catch (err) {
      console.error(`Cron ${cron} failed:`, err);
    }
  }
}

// Align to the start of each minute.
setTimeout(() => {
  tick();
  setInterval(tick, 60_000);
}, 60_000 - (Date.now() % 60_000));

// No signal handlers here: Miniflare's own SIGTERM/SIGINT hook stops workerd and exits.
