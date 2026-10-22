import type { Env as AppEnv } from "../../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
