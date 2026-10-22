// Zod shapes shared by several MCP tools.
import { z } from "zod";

export const FILTER_OPS = ["eq", "neq", "contains", "ncontains", "empty", "notempty", "gt", "gte", "lt", "lte", "anyOf", "noneOf", "allOf"] as const;

export const filterSchema = z
  .object({
    conjunction: z.enum(["and", "or"]).optional(),
    conditions: z
      .array(
        z.object({
          field: z.string().describe("Field name or id"),
          op: z.enum(FILTER_OPS),
          value: z.unknown().optional().describe("Option names for select fields, record ids for links, YYYY-MM-DD for dates; omit for empty/notempty"),
        }),
      )
      .max(20),
  })
  .describe("Structured filter, evaluated as SQL in the database (fast)");

export const sortSchema = z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).max(5);

export const fieldsSchema = z.array(z.string()).max(100).describe("Only return these fields (names or ids)");

export type FilterInput = z.infer<typeof filterSchema>;
export type SortInput = z.infer<typeof sortSchema>;

export const FIELD_TYPES_ENUM = ["text", "longText", "email", "url", "phone", "number", "singleSelect", "multiSelect", "date", "checkbox", "attachment", "link", "lookup", "rollup", "formula", "createdTime", "modifiedTime", "user", "autonumber"] as const;

export const fieldSpecOptionsSchema = z
  .object({
    choices: z
      .array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional(), renameFrom: z.string().optional().describe("update_field: current name of the option being renamed") })]))
      .optional()
      .describe("Select options; on update send the full list (options left out are removed from cells), existing options are matched by name or renameFrom"),
    precision: z.number().int().min(0).max(8).optional(),
    format: z.enum(["number", "currency", "percent"]).optional(),
    symbol: z.string().max(4).optional(),
    includeTime: z.boolean().optional(),
    linkedTable: z.string().optional().describe("link: table name or id to link to"),
    linkField: z.string().optional().describe("lookup / rollup: link field in this table"),
    targetField: z.string().optional().describe("lookup / rollup: field in the linked table"),
    fn: z.enum(["sum", "avg", "min", "max", "count", "counta", "countall", "arrayjoin", "arrayunique", "arraycompact", "and", "or", "concat"]).optional().describe("rollup function"),
    formula: z.string().optional().describe("Airtable formula with field names in braces, e.g. {Amount} * {Probability}"),
    multiple: z.boolean().optional().describe("user: allow several users"),
    ai: z
      .object({
        service: z.string().describe("AI service name or id from list_ai_services"),
        model: z.string().optional().describe("Model name; the service's default when missing"),
        prompt: z.string().min(1).max(8000).describe("Prompt with field names in braces, e.g. Summarize {Notes}"),
        imageFields: z.array(z.string()).max(2).optional().describe("Attachment fields whose images are sent to the model"),
        autoUpdate: z.boolean().optional().describe("Regenerate when referenced fields change (default true)"),
      })
      .optional()
      .describe("Makes the field an AI field (text, longText, singleSelect, multiSelect, number, date or checkbox): each record's value is generated from the prompt"),
  })
  .optional();

export const fieldSpecSchema = z.object({ name: z.string().min(1), type: z.enum(FIELD_TYPES_ENUM), description: z.string().optional(), options: fieldSpecOptionsSchema });

export const VIEW_TYPES = ["grid", "kanban", "form", "calendar", "timeline", "gallery"] as const;

export const viewOptionsShape = {
  filter: filterSchema.nullable().optional(),
  sort: sortSchema.nullable().optional(),
  hiddenFields: z.array(z.string()).nullable().optional(),
  groupBy: z
    .union([z.string(), z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).max(3)])
    .nullable()
    .optional()
    .describe("kanban: the single select field for columns; grid: up to 3 grouping levels"),
  dateField: z.string().nullable().optional().describe("calendar / timeline: start date field"),
  endDateField: z.string().nullable().optional().describe("calendar / timeline: end date field"),
  durationField: z.string().nullable().optional().describe("timeline: number field with the length in days, used without an end date"),
  laneField: z.string().nullable().optional().describe("timeline: single select, user or link field for lanes"),
  calendarMode: z.enum(["month", "week"]).nullable().optional(),
  timelineScale: z.enum(["day", "week", "month"]).nullable().optional(),
  coverField: z.string().nullable().optional().describe("kanban / gallery: attachment field shown as the card cover"),
};

/** null clears a setting in update_view. */
export type ViewOptionsInput = { [K in keyof typeof viewOptionsShape]?: z.infer<(typeof viewOptionsShape)[K]> };

export type FieldSpec = z.infer<typeof fieldSpecSchema>;
export type FieldSpecOptions = NonNullable<FieldSpec["options"]>;
