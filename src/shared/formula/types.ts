export type Value = number | string | boolean | null | Value[];
export type ValueType = "number" | "text" | "date" | "boolean" | "array";

export interface FieldRef {
  id: string;
  name: string;
  type?: ValueType;
}

export type Node =
  | { k: "num"; v: number; pos: number }
  | { k: "str"; v: string; pos: number }
  | { k: "bool"; v: boolean; pos: number }
  | { k: "ref"; id: string; pos: number }
  | { k: "neg"; a: Node; pos: number }
  | { k: "bin"; op: string; a: Node; b: Node; pos: number }
  | { k: "call"; name: string; args: Node[]; pos: number };

export interface Compiled {
  ast: Node;
  deps: string[];
  stored: string;
  usesNow: boolean;
  resultType: ValueType;
}

export interface EvalContext {
  get(fieldId: string): Value;
  recordId: number | string;
  createdTime: string;
  modifiedTime: string;
  now: Date;
}

export class FormulaError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = "FormulaError";
    this.pos = pos;
  }
}

export const ERROR_VALUE = "#ERROR!";

export class EvalError {
  constructor(public reason = "") {}
}

export function fail(reason = ""): never {
  throw new EvalError(reason);
}
