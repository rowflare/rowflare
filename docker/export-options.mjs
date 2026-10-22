// Build step for the Docker image: turns wrangler.jsonc into Miniflare worker options
// so the runtime only needs Miniflare, not wrangler.
import { createRequire } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "dist/worker");
const require = createRequire(import.meta.url);
const wranglerPath = require.resolve("wrangler");
const { unstable_getMiniflareWorkerOptions } = require(wranglerPath);

// The options shape must match the Miniflare version the server runs with.
const wranglerMiniflare = createRequire(wranglerPath)("miniflare/package.json").version;
const ownMiniflare = require("miniflare/package.json").version;
if (wranglerMiniflare !== ownMiniflare) {
  console.error(`miniflare ${ownMiniflare} in package.json differs from wrangler's ${wranglerMiniflare}. Pin miniflare to ${wranglerMiniflare}.`);
  process.exit(1);
}

const { workerOptions } = unstable_getMiniflareWorkerOptions(path.join(root, "wrangler.jsonc"));
// Vars come from the container environment and .dev.vars must never be baked in.
// Modules are listed explicitly below; cron triggers are dispatched by server.mjs.
const { bindings: _vars, modulesRules: _rules, rootPath: _root, cronTriggers = [], ...options } = workerOptions;
options.assets = { ...options.assets, directory: path.relative(root, options.assets.directory) };

const modules = [
  { type: "ESModule", path: "index.js" },
  ...readdirSync(outDir)
    .filter(f => f.endsWith(".sql"))
    .map(f => ({ type: "Text", path: f })),
];

writeFileSync(path.join(outDir, "miniflare.json"), JSON.stringify({ options, modules, cronTriggers }, null, 2));
console.log(`Wrote ${path.relative(root, path.join(outDir, "miniflare.json"))}`);
