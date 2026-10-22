import { ERROR_VALUE, EvalError, fail, type EvalContext, type Node, type Value } from "./types";
import { FUNCTIONS } from "./functions";
import { compare, isNumericString, looseEquals, toNum, toStr, truthy } from "./values";

type Fn = (ctx: EvalContext) => Value;

const cache = new WeakMap<Node, Fn>();

function num(n: number): number {
  if (!Number.isFinite(n)) fail("not finite");
  return n;
}

function nonNumeric(v: Value): boolean {
  return typeof v === "string" && v.trim() !== "" && !isNumericString(v);
}

function build(n: Node): Fn {
  switch (n.k) {
    case "num": case "str": case "bool": {
      const v = n.v;
      return () => v;
    }
    case "ref": {
      const id = n.id;
      return (ctx) => {
        const v = ctx.get(id);
        if (v === ERROR_VALUE) fail("ref error");
        return v === undefined ? null : v;
      };
    }
    case "neg": {
      const a = build(n.a);
      return (ctx) => -toNum(a(ctx));
    }
    case "bin": {
      const a = build(n.a), b = build(n.b);
      switch (n.op) {
        case "+": return (ctx) => {
          const x = a(ctx), y = b(ctx);
          if (typeof x === "number" && typeof y === "number") return num(x + y);
          if (nonNumeric(x) || nonNumeric(y)) return toStr(x) + toStr(y);
          return num(toNum(x) + toNum(y));
        };
        case "-": return (ctx) => num(toNum(a(ctx)) - toNum(b(ctx)));
        case "*": return (ctx) => num(toNum(a(ctx)) * toNum(b(ctx)));
        case "/": return (ctx) => {
          const x = toNum(a(ctx)), y = toNum(b(ctx));
          if (y === 0) fail("division by zero");
          return num(x / y);
        };
        case "&": return (ctx) => toStr(a(ctx)) + toStr(b(ctx));
        case "=": return (ctx) => looseEquals(a(ctx), b(ctx));
        case "!=": return (ctx) => !looseEquals(a(ctx), b(ctx));
        case "<": return (ctx) => compare(a(ctx), b(ctx)) < 0;
        case ">": return (ctx) => compare(a(ctx), b(ctx)) > 0;
        case "<=": return (ctx) => compare(a(ctx), b(ctx)) <= 0;
        case ">=": return (ctx) => compare(a(ctx), b(ctx)) >= 0;
      }
      throw new Error("Unknown operator " + n.op);
    }
    case "call": {
      const args = n.args.map(build);
      switch (n.name) {
        case "IF": {
          const [c, t, f] = args;
          return f ? (ctx) => (truthy(c(ctx)) ? t(ctx) : f(ctx)) : (ctx) => (truthy(c(ctx)) ? t(ctx) : null);
        }
        case "SWITCH": {
          const [e, ...rest] = args;
          const pairs = Math.floor(rest.length / 2);
          const dflt = rest.length % 2 === 1 ? rest[rest.length - 1] : null;
          return (ctx) => {
            const v = e(ctx);
            for (let i = 0; i < pairs; i++) if (looseEquals(v, rest[i * 2](ctx))) return rest[i * 2 + 1](ctx);
            return dflt ? dflt(ctx) : null;
          };
        }
        case "ISERROR": {
          const a = args[0];
          return (ctx) => {
            try {
              const v = a(ctx);
              return v === ERROR_VALUE || (typeof v === "number" && !Number.isFinite(v));
            } catch (e) {
              if (e instanceof EvalError) return true;
              throw e;
            }
          };
        }
      }
      const fn = FUNCTIONS[n.name].fn!;
      const len = args.length;
      return (ctx) => {
        const vals = new Array<Value>(len);
        for (let i = 0; i < len; i++) vals[i] = args[i](ctx);
        const r = fn(vals, ctx);
        if (typeof r === "number" && !Number.isFinite(r)) fail("not finite");
        return r;
      };
    }
  }
}

export function compileNode(ast: Node): Fn {
  let f = cache.get(ast);
  if (!f) {
    f = build(ast);
    cache.set(ast, f);
  }
  return f;
}

export function evaluate(ast: Node, ctx: EvalContext): Value {
  try {
    const v = compileNode(ast)(ctx);
    if (typeof v === "number" && !Number.isFinite(v)) return ERROR_VALUE;
    return v;
  } catch {
    return ERROR_VALUE;
  }
}

