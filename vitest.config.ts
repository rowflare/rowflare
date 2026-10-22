import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Bindings here win over .dev.vars, so a developer's local settings (test hosting, mail) do not reach the tests.
            miniflare: {
              bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations"), MODE: "selfhost", ALLOW_SIGNUP: "true", SECRET_KEY: "vitest-secret-key", AUTOMATION_ALLOW_PRIVATE: "false", DEV_TEST_HOSTING: "false", MAIL_PROVIDER: "" },
            },
          })),
        ],
        // Integration tests make many requests; 20 s keeps them from timing out on a busy machine.
        test: { name: "worker", include: ["test/worker/**/*.test.ts"], setupFiles: ["test/worker/setup.ts"], testTimeout: 20_000 },
      },
    ],
  },
});
