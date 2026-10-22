import { FormulaError, type Compiled, type FieldRef, type Node, type ValueType } from "./types";
import { FUNCTIONS } from "./functions";

type Tok =
  | { t: "num"; v: number; pos: number; end: number }
  | { t: "str"; v: string; pos: number; end: number }
  | { t: "ref"; v: string; pos: number; end: number }
  | { t: "id"; v: string; pos: number; end: number }
  | { t: "op"; v: string; pos: number; end: number }
  | { t: "eof"; v: ""; pos: number; end: number };

const OPS = ["<=", ">=", "!=", "<>", "=", "<", ">", "+", "-", "*", "/", "&", "(", ")", ","];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    if (c === "{") {
      const close = src.indexOf("}", i + 1);
      if (close < 0) throw new FormulaError("Missing closing } for field reference", i);
      out.push({ t: "ref", v: src.slice(i + 1, close), pos: start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let v = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const e = src[i + 1];
          v += ESCAPES[e] ?? e;
          i += 2;
        } else v += src[i++];
      }
      if (i >= src.length) throw new FormulaError("Unterminated string", start);
      i++;
      out.push({ t: "str", v, pos: start, end: i });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected character "${c}"`, i);
      i += m[0].length;
      out.push({ t: "num", v: Number(m[0]), pos: start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      out.push({ t: "id", v: src.slice(start, i), pos: start, end: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected character "${c}"`, i);
    i += op.length;
    out.push({ t: "op", v: op, pos: start, end: i });
  }
  out.push({ t: "eof", v: "", pos: src.length, end: src.length });
  return out;
}

const COMPARE = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);

interface State {
  toks: Tok[];
  i: number;
  resolve: (tok: Tok) => string;
}

function peek(s: State): Tok {
  return s.toks[s.i];
}

function isOp(t: Tok, v: string): boolean {
  return t.t === "op" && t.v === v;
}

function expect(s: State, v: string): Tok {
  const t = peek(s);
  if (!isOp(t, v)) throw new FormulaError(t.t === "eof" ? `Expected "${v}" but the formula ended` : `Expected "${v}"`, t.pos);
  s.i++;
  return t;
}

function binary(s: State, ops: (v: string) => boolean, next: (s: State) => Node): Node {
  let left = next(s);
  for (;;) {
    const t = peek(s);
    if (t.t !== "op" || !ops(t.v)) return left;
    s.i++;
    left = { k: "bin", op: t.v === "<>" ? "!=" : t.v, a: left, b: next(s), pos: t.pos };
  }
}

const parseCompare = (s: State): Node => binary(s, (v) => COMPARE.has(v), parseConcat);
const parseConcat = (s: State): Node => binary(s, (v) => v === "&", parseAdd);
const parseAdd = (s: State): Node => binary(s, (v) => v === "+" || v === "-", parseMul);
const parseMul = (s: State): Node => binary(s, (v) => v === "*" || v === "/", parseUnary);

function parseUnary(s: State): Node {
  const t = peek(s);
  if (isOp(t, "-")) {
    s.i++;
    return { k: "neg", a: parseUnary(s), pos: t.pos };
  }
  if (isOp(t, "+")) {
    s.i++;
    return parseUnary(s);
  }
  return parsePrimary(s);
}

function parsePrimary(s: State): Node {
  const t = peek(s);
  s.i++;
  switch (t.t) {
    case "num": return { k: "num", v: t.v, pos: t.pos };
    case "str": return { k: "str", v: t.v, pos: t.pos };
    case "ref": return { k: "ref", id: s.resolve(t), pos: t.pos };
    case "id": {
      const name = t.v.toUpperCase();
      if (!isOp(peek(s), "(")) {
        if (name === "TRUE" || name === "FALSE") return { k: "bool", v: name === "TRUE", pos: t.pos };
        throw new FormulaError(`Unknown identifier "${t.v}". Field names must be wrapped in {braces}`, t.pos);
      }
      const def = FUNCTIONS[name];
      if (!def) throw new FormulaError(`Unknown function "${t.v}"`, t.pos);
      s.i++;
      const args: Node[] = [];
      if (!isOp(peek(s), ")")) {
        for (;;) {
          args.push(parseCompare(s));
          if (isOp(peek(s), ",")) { s.i++; continue; }
          break;
        }
      }
      expect(s, ")");
      if (args.length < def.min || args.length > def.max) {
        const want = def.min === def.max ? `${def.min}` : def.max === Infinity ? `at least ${def.min}` : `${def.min} to ${def.max}`;
        throw new FormulaError(`${name} expects ${want} argument${want === "1" ? "" : "s"} but got ${args.length}`, t.pos);
      }
      if (name === "TRUE" || name === "FALSE") return { k: "bool", v: name === "TRUE", pos: t.pos };
      return { k: "call", name, args, pos: t.pos };
    }
    case "op":
      if (t.v === "(") {
        const e = parseCompare(s);
        expect(s, ")");
        return e;
      }
      throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
    default:
      throw new FormulaError(s.toks.length === 1 ? "Formula is empty" : "Unexpected end of formula", t.pos);
  }
}

function makeResolver(fields: FieldRef[]): (tok: Tok) => string {
  const byName = new Map<string, string>();
  const byLower = new Map<string, string>();
  const byId = new Set<string>();
  for (const f of fields) {
    if (!byName.has(f.name)) byName.set(f.name, f.id);
    const l = f.name.toLowerCase();
    if (!byLower.has(l)) byLower.set(l, f.id);
    byId.add(f.id);
  }
  return (tok) => {
    const n = tok.v as string;
    const id = byName.get(n) ?? byLower.get(n.toLowerCase()) ?? (byId.has(n) ? n : undefined);
    if (id === undefined) throw new FormulaError(`Unknown field "${n}"`, tok.pos);
    return id;
  };
}

function inferType(n: Node, types: Map<string, ValueType>): ValueType {
  switch (n.k) {
    case "num": case "neg": return "number";
    case "str": return "text";
    case "bool": return "boolean";
    case "ref": return types.get(n.id) ?? "text";
    case "bin":
      if (n.op === "&") return "text";
      if (COMPARE.has(n.op)) return "boolean";
      if (n.op === "+") {
        const a = inferType(n.a, types), b = inferType(n.b, types);
        if (a === "text" || b === "text") return "text";
      }
      return "number";
    case "call": {
      const rule = FUNCTIONS[n.name].type;
      if (rule === "first") return n.args.length ? inferType(n.args[0], types) : "text";
      if (rule !== "branch") return rule;
      const branches = n.name === "IF" ? n.args.slice(1) : n.args.slice(1).filter((_, i, a) => i % 2 === 1 || i === a.length - 1);
      for (const b of branches) {
        if (b.k === "call" && b.name === "BLANK") continue;
        return inferType(b, types);
      }
      return "text";
    }
  }
}

function walk(n: Node, fn: (n: Node) => void): void {
  fn(n);
  if (n.k === "neg") walk(n.a, fn);
  else if (n.k === "bin") { walk(n.a, fn); walk(n.b, fn); }
  else if (n.k === "call") for (const a of n.args) walk(a, fn);
}

export function compileFormula(text: string, fields: FieldRef[]): Compiled {
  const toks = lex(text);
  const s: State = { toks, i: 0, resolve: makeResolver(fields) };
  const ast = parseCompare(s);
  const rest = peek(s);
  if (rest.t !== "eof") throw new FormulaError(isOp(rest, ")") ? `Unexpected ")"` : "Unexpected token, expected an operator", rest.pos);
  const deps = new Set<string>();
  let usesNow = false;
  walk(ast, (n) => {
    if (n.k === "ref") deps.add(n.id);
    else if (n.k === "call" && FUNCTIONS[n.name].now) usesNow = true;
  });
  let stored = "";
  let last = 0;
  for (const t of toks) {
    if (t.t !== "ref") continue;
    stored += text.slice(last, t.pos) + "{" + s.resolve(t) + "}";
    last = t.end;
  }
  stored += text.slice(last);
  const types = new Map<string, ValueType>();
  for (const f of fields) if (f.type && !types.has(f.id)) types.set(f.id, f.type);
  return { ast, deps: [...deps], stored, usesNow, resultType: inferType(ast, types) };
}

export function toDisplay(stored: string, fields: FieldRef[]): string {
  const names = new Map(fields.map((f) => [f.id, f.name] as const));
  let out = "";
  let i = 0;
  while (i < stored.length) {
    const c = stored[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < stored.length && stored[j] !== c) j += stored[j] === "\\" ? 2 : 1;
      out += stored.slice(i, j + 1);
      i = j + 1;
    } else if (c === "{") {
      const close = stored.indexOf("}", i + 1);
      if (close < 0) return out + stored.slice(i);
      const id = stored.slice(i + 1, close);
      out += "{" + (names.get(id) ?? id) + "}";
      i = close + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
