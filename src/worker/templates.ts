// Starter bases: used for "new base from template".
import type { BaseStore, Actor, FieldInput } from "./base/store";
import { defaultChoices } from "./base/store";
import type { FieldType } from "../shared/types";
import type { RollupFn } from "../shared/rollup";

interface TplField {
  name: string;
  type: FieldType;
  choices?: string[];
  format?: "currency" | "percent" | "number";
  precision?: number;
  link?: string;
  inverse?: string;
  lookup?: [link: string, field: string];
  rollup?: [link: string, field: string, fn: RollupFn];
  formula?: string;
  includeTime?: boolean;
}

interface TplTable {
  name: string;
  fields: TplField[];
  rows: Record<string, unknown>[];
}

export interface TemplateInfo {
  slug: string;
  name: string;
  description: string;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

function projectTracker(): TplTable[] {
  const r = rng(7);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const people = ["Ava Chen", "Liam Novak", "Maya Patel", "Noah Kim", "Sofia Rossi", "Ethan Brooks"];
  const projects = ["Website relaunch", "Mobile app v2", "Q4 marketing campaign", "Data warehouse migration", "Customer onboarding revamp", "Pricing page experiment", "Support knowledge base", "Hiring pipeline"];
  const verbs = ["Draft", "Review", "Design", "Ship", "Test", "Plan", "Write", "Audit", "Fix", "Prototype", "Measure", "Document"];
  const nouns = ["landing page", "checkout flow", "email sequence", "API endpoints", "release notes", "user interviews", "analytics events", "onboarding checklist", "pricing tiers", "dashboard", "help articles", "job description", "migration script", "QA plan", "brand guidelines"];
  return [
    {
      name: "Projects",
      fields: [
        { name: "Name", type: "text" },
        { name: "Owner", type: "text" },
        { name: "Status", type: "singleSelect", choices: ["Planning", "Active", "On hold", "Done"] },
        { name: "Budget", type: "number", format: "currency", precision: 0 },
        { name: "Start", type: "date" },
        { name: "Deadline", type: "date" },
        { name: "Total hours", type: "rollup", rollup: ["Tasks", "Estimate", "sum"] },
        { name: "Total tasks", type: "rollup", rollup: ["Tasks", "Name", "countall"] },
        { name: "Done tasks", type: "rollup", rollup: ["Tasks", "Done", "counta"] },
        { name: "Progress", type: "formula", formula: 'IF({Total tasks}, ROUND({Done tasks} / {Total tasks} * 100) & "%", "")' },
      ],
      rows: projects.map((name, i) => ({
        Name: name,
        Owner: people[i % people.length],
        Status: ["Active", "Active", "Planning", "Active", "On hold", "Done", "Planning", "Active"][i],
        Budget: Math.round(5 + r() * 95) * 1000,
        Start: day(-60 + i * 5),
        Deadline: day(10 + i * 9),
      })),
    },
    {
      name: "Tasks",
      fields: [
        { name: "Name", type: "text" },
        { name: "Project", type: "link", link: "Projects", inverse: "Tasks" },
        { name: "Status", type: "singleSelect", choices: ["Todo", "In progress", "Review", "Done"] },
        { name: "Priority", type: "singleSelect", choices: ["High", "Medium", "Low"] },
        { name: "Assignee", type: "text" },
        { name: "Estimate", type: "number", precision: 1 },
        { name: "Due", type: "date" },
        { name: "Tags", type: "multiSelect", choices: ["design", "engineering", "marketing", "research", "ops", "urgent"] },
        { name: "Done", type: "checkbox" },
        { name: "Notes", type: "longText" },
        { name: "Project owner", type: "lookup", lookup: ["Project", "Owner"] },
        { name: "Overdue", type: "formula", formula: 'IF(AND({Due}, IS_BEFORE({Due}, TODAY()), NOT({Done})), "Overdue", "")' },
      ],
      rows: Array.from({ length: 240 }, (_, i) => {
        const status = pick(["Todo", "Todo", "In progress", "Review", "Done", "Done"]);
        return {
          Name: `${pick(verbs)} ${pick(nouns)}`,
          Project: [projects[i % projects.length]],
          Status: status,
          Priority: pick(["High", "Medium", "Medium", "Low"]),
          Assignee: pick(people),
          Estimate: Math.round(r() * 160) / 10 + 0.5,
          Due: day(Math.floor(r() * 70) - 20),
          Tags: Array.from(new Set(Array.from({ length: Math.floor(r() * 3) }, () => pick(["design", "engineering", "marketing", "research", "ops", "urgent"])))),
          Done: status === "Done",
          Notes: r() < 0.3 ? "Discussed in the weekly sync. Follow up with the owner before the deadline." : "",
        };
      }),
    },
  ];
}

function crm(): TplTable[] {
  const r = rng(11);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const companies = ["Northwind Traders", "Globex", "Initech", "Umbrella Health", "Stark Logistics", "Wayne Studios", "Acme Robotics", "Hooli Cloud", "Soylent Foods", "Vandelay Imports", "Massive Dynamic", "Cyberdyne Labs"];
  const first = ["Olivia", "James", "Emma", "Lucas", "Mia", "Henry", "Zoe", "Leo", "Chloe", "Jack", "Aria", "Owen"];
  const last = ["Garcia", "Smith", "Nguyen", "Muller", "Silva", "Johnson", "Okafor", "Larsen", "Kowalski", "Tanaka"];
  return [
    {
      name: "Companies",
      fields: [
        { name: "Name", type: "text" },
        { name: "Industry", type: "singleSelect", choices: ["Software", "Healthcare", "Logistics", "Retail", "Media", "Manufacturing"] },
        { name: "Size", type: "singleSelect", choices: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
        { name: "Website", type: "url" },
        { name: "Pipeline", type: "rollup", rollup: ["Deals", "Amount", "sum"], format: "currency", precision: 0 },
        { name: "Open deals", type: "rollup", rollup: ["Deals", "Name", "countall"] },
      ],
      rows: companies.map(name => ({
        Name: name,
        Industry: pick(["Software", "Healthcare", "Logistics", "Retail", "Media", "Manufacturing"]),
        Size: pick(["1-10", "11-50", "51-200", "201-1000", "1000+"]),
        Website: `https://${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com`,
      })),
    },
    {
      name: "Contacts",
      fields: [
        { name: "Name", type: "text" },
        { name: "Title", type: "text" },
        { name: "Email", type: "email" },
        { name: "Phone", type: "phone" },
        { name: "Company", type: "link", link: "Companies", inverse: "Contacts" },
        { name: "Industry", type: "lookup", lookup: ["Company", "Industry"] },
      ],
      rows: Array.from({ length: 36 }, (_, i) => {
        const name = `${first[i % first.length]} ${pick(last)}`;
        const company = companies[i % companies.length];
        return {
          Name: name,
          Title: pick(["CEO", "CTO", "Head of Ops", "Procurement lead", "VP Sales", "Product manager"]),
          Email: `${name.toLowerCase().replace(" ", ".")}@${company.toLowerCase().replace(/[^a-z]/g, "")}.example.com`,
          Phone: `+1 555 01${String(10 + i).padStart(2, "0")}`,
          Company: [company],
        };
      }),
    },
    {
      name: "Deals",
      fields: [
        { name: "Name", type: "text" },
        { name: "Company", type: "link", link: "Companies", inverse: "Deals" },
        { name: "Stage", type: "singleSelect", choices: ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"] },
        { name: "Amount", type: "number", format: "currency", precision: 0 },
        { name: "Close date", type: "date" },
        { name: "Probability", type: "formula", formula: 'SWITCH({Stage}, "Lead", 0.1, "Qualified", 0.25, "Proposal", 0.5, "Negotiation", 0.75, "Won", 1, 0)', format: "percent" },
        { name: "Weighted", type: "formula", formula: "ROUND({Amount} * {Probability})", format: "currency", precision: 0 },
      ],
      rows: Array.from({ length: 30 }, (_, i) => ({
        Name: `${pick(["Annual plan", "Pilot", "Expansion", "Renewal", "Enterprise upgrade"])} - ${companies[i % companies.length]}`,
        Company: [companies[i % companies.length]],
        Stage: pick(["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]),
        Amount: Math.round(2 + r() * 98) * 500,
        "Close date": day(Math.floor(r() * 90) - 15),
      })),
    },
  ];
}

function contentCalendar(): TplTable[] {
  const r = rng(13);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const topics = ["How we cut our cloud bill in half", "Spreadsheet vs database: when to switch", "Customer story: a 40-person agency", "Release notes: October", "A guide to linked records", "Five formulas everyone should know", "Behind the scenes of our roadmap", "Running a team on $5 a month"];
  return [
    {
      name: "Posts",
      fields: [
        { name: "Title", type: "text" },
        { name: "Channel", type: "singleSelect", choices: ["Blog", "Newsletter", "LinkedIn", "X", "YouTube"] },
        { name: "Status", type: "singleSelect", choices: ["Idea", "Drafting", "Editing", "Scheduled", "Published"] },
        { name: "Publish date", type: "date" },
        { name: "Author", type: "text" },
        { name: "Tags", type: "multiSelect", choices: ["product", "tutorial", "story", "news"] },
        { name: "Draft", type: "longText" },
        { name: "URL", type: "url" },
        { name: "Week", type: "formula", formula: '"W" & WEEKNUM({Publish date})' },
      ],
      rows: Array.from({ length: 32 }, (_, i) => ({
        Title: `${topics[i % topics.length]}${i >= topics.length ? ` (${pick(["thread", "video", "recap"])})` : ""}`,
        Channel: pick(["Blog", "Newsletter", "LinkedIn", "X", "YouTube"]),
        Status: pick(["Idea", "Drafting", "Editing", "Scheduled", "Published"]),
        "Publish date": day(Math.floor(r() * 60) - 20),
        Author: pick(["Maya", "Liam", "Sofia", "Noah"]),
        Tags: [pick(["product", "tutorial", "story", "news"])],
      })),
    },
  ];
}

function bugTracker(): TplTable[] {
  const r = rng(17);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const areas = ["Login", "Grid", "Kanban", "Import", "API", "Billing", "Forms"];
  const issues = ["crashes when", "is slow when", "shows wrong data after", "does not save after", "flickers during", "throws 500 on"];
  const actions = ["pasting 500 rows", "renaming a field", "switching views", "uploading a large file", "reconnecting", "sorting by date", "undoing twice"];
  return [
    {
      name: "Bugs",
      fields: [
        { name: "Summary", type: "text" },
        { name: "Severity", type: "singleSelect", choices: ["Critical", "High", "Medium", "Low"] },
        { name: "Status", type: "singleSelect", choices: ["Open", "In progress", "Fixed", "Won't fix"] },
        { name: "Component", type: "singleSelect", choices: areas },
        { name: "Reported", type: "date" },
        { name: "Reporter", type: "email" },
        { name: "Steps to reproduce", type: "longText" },
        { name: "Age (days)", type: "formula", formula: "DATETIME_DIFF(TODAY(), {Reported}, 'days')" },
      ],
      rows: Array.from({ length: 45 }, () => {
        const area = pick(areas);
        return {
          Summary: `${area} ${pick(issues)} ${pick(actions)}`,
          Severity: pick(["Critical", "High", "Medium", "Medium", "Low"]),
          Status: pick(["Open", "Open", "In progress", "Fixed", "Won't fix"]),
          Component: area,
          Reported: day(-Math.floor(r() * 40)),
          Reporter: `${pick(["sam", "alex", "jo", "kai"])}@example.com`,
          "Steps to reproduce": "1. Open the base\n2. Perform the action\n3. Observe the result",
        };
      }),
    },
  ];
}

function inventory(): TplTable[] {
  const r = rng(19);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const suppliers = ["Blue Ridge Supply", "Harbor Goods", "Summit Wholesale", "Pioneer Parts"];
  const items = ["Ceramic mug", "Canvas tote", "Notebook A5", "Desk lamp", "Water bottle", "Wireless mouse", "USB-C cable", "Phone stand", "Sticker pack", "Hoodie", "Cap", "Poster"];
  return [
    {
      name: "Suppliers",
      fields: [
        { name: "Name", type: "text" },
        { name: "Email", type: "email" },
        { name: "Country", type: "singleSelect", choices: ["USA", "Germany", "Japan", "Mexico"] },
      ],
      rows: suppliers.map(name => ({ Name: name, Email: `orders@${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com`, Country: pick(["USA", "Germany", "Japan", "Mexico"]) })),
    },
    {
      name: "Products",
      fields: [
        { name: "Name", type: "text" },
        { name: "SKU", type: "text" },
        { name: "Category", type: "singleSelect", choices: ["Merch", "Office", "Electronics"] },
        { name: "Price", type: "number", format: "currency", precision: 2 },
        { name: "Cost", type: "number", format: "currency", precision: 2 },
        { name: "In stock", type: "number", precision: 0 },
        { name: "Reorder level", type: "number", precision: 0 },
        { name: "Supplier", type: "link", link: "Suppliers", inverse: "Products" },
        { name: "Margin", type: "formula", formula: "IF({Price}, ({Price} - {Cost}) / {Price}, BLANK())", format: "percent", precision: 0 },
        { name: "Reorder", type: "formula", formula: 'IF({In stock} <= {Reorder level}, "Reorder", "OK")' },
      ],
      rows: items.map((name, i) => {
        const price = Math.round((5 + r() * 60) * 100) / 100;
        return {
          Name: name,
          SKU: `SKU-${1000 + i}`,
          Category: pick(["Merch", "Office", "Electronics"]),
          Price: price,
          Cost: Math.round(price * (0.3 + r() * 0.4) * 100) / 100,
          "In stock": Math.floor(r() * 200),
          "Reorder level": 25,
          Supplier: [suppliers[i % suppliers.length]],
        };
      }),
    },
  ];
}

const BUILDERS: Record<string, { info: TemplateInfo; build: () => TplTable[] }> = {
  "project-tracker": { info: { slug: "project-tracker", name: "Project tracker", description: "Projects and tasks with rollups, lookups and an overdue formula." }, build: projectTracker },
  crm: { info: { slug: "crm", name: "CRM", description: "Companies, contacts and deals with a weighted pipeline." }, build: crm },
  "content-calendar": { info: { slug: "content-calendar", name: "Content calendar", description: "Plan posts across channels on a kanban board." }, build: contentCalendar },
  "bug-tracker": { info: { slug: "bug-tracker", name: "Bug tracker", description: "Triage bugs by severity and component." }, build: bugTracker },
  inventory: { info: { slug: "inventory", name: "Inventory", description: "Products, stock levels, suppliers and margins." }, build: inventory },
};

export const TEMPLATES: TemplateInfo[] = Object.values(BUILDERS).map(b => b.info);

export function applyTemplate(store: BaseStore, slug: string, actor?: Actor) {
  const who: Actor = actor ?? { userId: "", name: "" };
  const builder = BUILDERS[slug];
  if (!builder) {
    store.createTable(who, { name: "Table 1" });
    return;
  }
  const tables = builder.build();
  const ids = new Map<string, string>();
  const plainTypes = (f: TplField) => !f.link && !f.lookup && !f.rollup && !f.formula;
  for (const t of tables) {
    const fields: FieldInput[] = t.fields.filter(plainTypes).map(f => ({
      name: f.name,
      type: f.type,
      options: {
        ...(f.choices ? { choices: defaultChoices(f.choices) } : {}),
        ...(f.format ? { format: f.format } : {}),
        ...(f.precision !== undefined ? { precision: f.precision } : {}),
        ...(f.includeTime ? { includeTime: true } : {}),
      },
    }));
    ids.set(t.name, store.createTable(who, { name: t.name, fields }).tableId);
  }
  const fieldId = (table: string, name: string) => store.fieldsOf(ids.get(table)!).find(f => f.name === name)?.id;
  for (const t of tables) {
    for (const f of t.fields.filter(f => f.link)) {
      const { fieldId: fid, schema } = store.createField(ids.get(t.name)!, { name: f.name, type: "link", options: { linkedTableId: ids.get(f.link!)! } });
      const inv = schema.fields.find(x => x.id === fid)?.options.inverseFieldId;
      if (inv && f.inverse) store.updateField(inv, { name: f.inverse });
    }
  }
  for (const t of tables) {
    const tableId = ids.get(t.name)!;
    const nameToId = new Map(store.fieldsOf(tableId).map(f => [f.name, f.id]));
    const rows = t.rows.map(row => {
      const cells: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) if (nameToId.has(k)) cells[nameToId.get(k)!] = v;
      return { cells };
    });
    for (let i = 0; i < rows.length; i += 500) store.createRows(who, tableId, rows.slice(i, i + 500), { typecast: true, noTriggers: true });
  }
  // Computed fields last, in declaration order so formulas can use earlier rollups.
  for (const t of tables) {
    const tableId = ids.get(t.name)!;
    for (const f of t.fields) {
      const extra = { ...(f.format ? { format: f.format } : {}), ...(f.precision !== undefined ? { precision: f.precision } : {}) };
      if (f.lookup || f.rollup) {
        const [link, target, fn] = (f.lookup ?? f.rollup)!;
        const linkId = fieldId(t.name, link)!;
        const linked = store.field(linkId).options.linkedTableId!;
        const targetId = store.fieldsOf(linked).find(x => x.name === target)!.id;
        store.createField(tableId, { name: f.name, type: f.type, options: { linkFieldId: linkId, targetFieldId: targetId, fn: fn as RollupFn | undefined, ...extra } });
      } else if (f.formula) {
        store.createField(tableId, { name: f.name, type: "formula", options: { formula: f.formula, ...extra } });
      }
    }
  }
  if (slug === "project-tracker") {
    const tasks = ids.get("Tasks")!;
    store.createView(tasks, { name: "Board", type: "kanban", config: { groupFieldId: fieldId("Tasks", "Status") } });
    store.createView(tasks, { name: "Request form", type: "form" });
  }
  if (slug === "content-calendar" || slug === "bug-tracker") {
    const t = tables[0].name;
    store.createView(ids.get(t)!, { name: "Board", type: "kanban", config: { groupFieldId: fieldId(t, "Status") } });
  }
  if (slug === "crm") store.createView(ids.get("Deals")!, { name: "Pipeline", type: "kanban", config: { groupFieldId: fieldId("Deals", "Stage") } });
}
