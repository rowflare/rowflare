// MCP endpoint: stateless Streamable HTTP, one server per request, personal access tokens only.
import { registerAiTools } from "./tools-ai";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { Env } from "../env";
import type { AppContext, Vars } from "../access";
import { authenticate } from "../auth";
import { ensureSchema } from "../schema";
import { registerReadTools } from "./tools-read";
import { registerWriteTools } from "./tools-write";
import { registerSchemaTools } from "./tools-schema";
import { registerDashboardTools } from "./tools-dashboard";
import { registerAutomationTools } from "./tools-automation";

const INSTRUCTIONS =
  "Rowflare is an Airtable-style database. Start with list_bases, then describe_base to learn table and field names. " +
  "Use field names (not ids) in records and filters; select options and linked records can be given by name. " +
  "Prefer the structured filter over formula for speed, and use aggregate instead of reading every record to count or total." +
  " Dashboards: get_dashboard shows each widget with its current numbers; create_dashboard and update_dashboard build them by table and field names.";

export const mcpRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function buildServer(c: AppContext): McpServer {
  const server = new McpServer({ name: "rowflare", version: "0.1.0" }, { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  registerReadTools(server, c);
  registerWriteTools(server, c);
  registerSchemaTools(server, c);
  registerAiTools(server, c);
  registerDashboardTools(server, c);
  registerAutomationTools(server, c);
  return server;
}

mcpRoutes.post("/", async c => {
  await ensureSchema(c.env);
  const auth = await authenticate(c.env, c.req.raw);
  if (!auth || auth.via !== "token") {
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Send a personal access token: Authorization: Bearer <token>" }, id: null },
      401,
      { "WWW-Authenticate": 'Bearer realm="rowflare"' },
    );
  }
  c.set("user", auth.user);
  c.set("via", "token");
  const server = buildServer(c as AppContext);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

mcpRoutes.on(["GET", "DELETE"], "/", c => c.json({ error: "Method not allowed" }, 405, { Allow: "POST" }));
