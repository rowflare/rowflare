// AI tools: the workspace's model services and generating AI fields.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseAccess, type AppContext } from "../access";
import { fieldOf, loadTable, unwrap } from "../records";
import { listServices } from "../ai/services";
import { guard } from "./result";

export function registerAiTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_ai_services",
    { title: "List AI services", description: "Model services of the base's workspace, usable in AI fields (options.ai.service) and AI automation steps.", inputSchema: { baseId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false } },
    guard(async (args: { baseId: string }) => {
      const a = await baseAccess(c, args.baseId, "read");
      const services = await listServices(c.env, a.base.workspace_id, Date.now());
      return { services: services.map(s => ({ id: s.id, name: s.name, kind: s.kind, model: s.model })) };
    }),
  );

  server.registerTool(
    "generate_ai_field",
    {
      title: "Generate AI field",
      description: "Queue AI generation for some records of an AI field, the records never generated (missingOnly), or the whole column. Generation runs in the background; read the records later to see the answers.",
      inputSchema: { baseId: z.string(), table: z.string(), field: z.string(), records: z.array(z.number().int()).max(5000).optional(), missingOnly: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args: { baseId: string; table: string; field: string; records?: number[]; missingOnly?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const f = fieldOf(t.fields, args.field, t.table.name);
      return unwrap(await t.a.stub.aiGenerate(t.table.id, f.id, { rowIds: args.records, missingOnly: args.missingOnly }));
    }),
  );
}
