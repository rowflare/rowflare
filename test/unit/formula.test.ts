import { describe, expect, it } from "vitest";
import { compileFormula, evaluate, FormulaError, FUNCTION_NAMES, toDisplay, type FieldRef, type Value } from "../../src/shared/formula";

const fields: FieldRef[] = [
  { id: "fldA", name: "A", type: "number" },
  { id: "fldB", name: "B", type: "number" },
  { id: "fldC", name: "C", type: "text" },
  { id: "fldName", name: "Full Name", type: "text" },
  { id: "fldDue", name: "Due Date", type: "date" },
  { id: "fldTags", name: "Tags (multi)", type: "array" },
  { id: "fldNums", name: "Nums", type: "array" },
  { id: "fldBlank", name: "Empty" },
  { id: "fldErr", name: "Broken" },
];

const NOW = new Date("2025-03-15T12:00:00.000Z");
const baseValues: Record<string, Value> = {
  fldA: 12,
  fldB: 3.14159,
  fldC: "hello",
  fldName: "Ada Lovelace",
  fldDue: "2025-03-01",
  fldTags: ["red", "green"],
  fldNums: [1, 2, null, [3, 4]],
  fldBlank: null,
  fldErr: "#ERROR!",
};

function ctx(values: Record<string, Value> = {}) {
  const all = { ...baseValues, ...values };
  return {
    get: (id: string) => (id in all ? all[id] : null),
    recordId: 42,
    createdTime: "2025-01-01T00:00:00.000Z",
    modifiedTime: "2025-02-01T10:00:00.000Z",
    now: NOW,
  };
}

function run(text: string, values: Record<string, Value> = {}): Value {
  return evaluate(compileFormula(text, fields).ast, ctx(values));
}

function err(text: string): FormulaError {
  try {
    compileFormula(text, fields);
  } catch (e) {
    expect(e).toBeInstanceOf(FormulaError);
    return e as FormulaError;
  }
  throw new Error("expected FormulaError for " + text);
}

describe("parsing", () => {
  it("respects precedence", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("12 / 3 / 2")).toBe(2);
    expect(run("-2 * 3")).toBe(-6);
    expect(run("--2")).toBe(2);
    expect(run("1 + 2 & 3")).toBe("33");
    expect(run('"a" & 1 + 1')).toBe("a2");
    expect(run("1 + 1 = 2")).toBe(true);
    expect(run('"x" & "y" = "xy"')).toBe(true);
    expect(run("2 * 3 > 5")).toBe(true);
  });

  it("parses literals", () => {
    expect(run("3.5")).toBe(3.5);
    expect(run(".5")).toBe(0.5);
    expect(run('"double \\"quoted\\""')).toBe('double "quoted"');
    expect(run("'single \\'q\\''")).toBe("single 'q'");
    expect(run('"a\\nb"')).toBe("a\nb");
    expect(run("TRUE")).toBe(true);
    expect(run("false")).toBe(false);
    expect(run("TRUE()")).toBe(true);
    expect(run("FALSE()")).toBe(false);
  });

  it("handles function names case-insensitively and whitespace/newlines", () => {
    expect(run("sum(1,\n 2)")).toBe(3);
    expect(run("  Upper( 'a' )  ")).toBe("A");
  });

  it("resolves refs with spaces, case-insensitively and by id", () => {
    expect(run("{Full Name}")).toBe("Ada Lovelace");
    expect(run("{full name}")).toBe("Ada Lovelace");
    expect(run("{fldName}")).toBe("Ada Lovelace");
    expect(run("{Tags (multi)}")).toEqual(["red", "green"]);
  });

  it("prefers exact name over case-insensitive and id", () => {
    const fs: FieldRef[] = [
      { id: "fld1", name: "x" },
      { id: "fld2", name: "X" },
      { id: "fld3", name: "fld1" },
    ];
    expect(compileFormula("{X}", fs).deps).toEqual(["fld2"]);
    expect(compileFormula("{x}", fs).deps).toEqual(["fld1"]);
    expect(compileFormula("{fld1}", fs).deps).toEqual(["fld3"]);
  });

  it("round trips stored and display forms", () => {
    const text = 'IF({Full Name} = "{A}", {a} & {B},  {Due Date})';
    const c = compileFormula(text, fields);
    expect(c.stored).toBe('IF({fldName} = "{A}", {fldA} & {fldB},  {fldDue})');
    expect(toDisplay(c.stored, fields)).toBe('IF({Full Name} = "{A}", {A} & {B},  {Due Date})');
    expect(toDisplay("{fldGone} + {fldA}", fields)).toBe("{fldGone} + {A}");
    expect(compileFormula(c.stored, fields).stored).toBe(c.stored);
  });

  it("reports deps, usesNow and resultType", () => {
    const c = compileFormula("{A} + {A} + {B}", fields);
    expect(c.deps).toEqual(["fldA", "fldB"]);
    expect(c.usesNow).toBe(false);
    expect(c.resultType).toBe("number");
    expect(compileFormula("DATETIME_DIFF(NOW(), {Due Date}, 'days')", fields).usesNow).toBe(true);
    expect(compileFormula("today()", fields).usesNow).toBe(true);
    expect(compileFormula("TONOW({Due Date})", fields).usesNow).toBe(true);
    expect(compileFormula("FROMNOW({Due Date})", fields).usesNow).toBe(true);
    expect(compileFormula("{C} & 1", fields).resultType).toBe("text");
    expect(compileFormula("{Full Name}", fields).resultType).toBe("text");
    expect(compileFormula("{Empty}", fields).resultType).toBe("text");
    expect(compileFormula("{A} > 1", fields).resultType).toBe("boolean");
    expect(compileFormula("DATEADD({Due Date}, 1, 'days')", fields).resultType).toBe("date");
    expect(compileFormula("IF({A}, BLANK(), {Due Date})", fields).resultType).toBe("date");
    expect(compileFormula("SWITCH({A}, 1, 'x', 2)", fields).resultType).toBe("text");
    expect(compileFormula("SWITCH({A}, 1, 5, 6)", fields).resultType).toBe("number");
    expect(compileFormula("ARRAYUNIQUE({Tags (multi)})", fields).resultType).toBe("array");
  });

  it("throws FormulaError with positions", () => {
    expect(err("{Nope} + 1").pos).toBe(0);
    expect(err("1 + {Nope}").message).toContain("Nope");
    expect(err("1 + {Nope}").pos).toBe(4);
    expect(err("1 + FOO(2)").pos).toBe(4);
    expect(err("1 + FOO(2)").message).toContain("Unknown function");
    expect(err("ABS(1, 2)").pos).toBe(0);
    expect(err("  IF(1)").pos).toBe(2);
    expect(err("IF(1)").message).toMatch(/IF expects 2 to 3 arguments but got 1/);
    expect(err("(1 + 2").pos).toBe(6);
    expect(err("1 + 2)").pos).toBe(5);
    expect(err('"abc').pos).toBe(0);
    expect(err("{A").pos).toBe(0);
    expect(err("1 # 2").pos).toBe(2);
    expect(err("1 2").pos).toBe(2);
    expect(err("foo").pos).toBe(0);
    expect(err("").message).toContain("empty");
    expect(err("1 +").pos).toBe(3);
  });
});

describe("blank and coercion semantics", () => {
  it("treats blank as 0 in arithmetic and empty string in text", () => {
    expect(run("{Empty} + 1")).toBe(1);
    expect(run("{Empty} * 5")).toBe(0);
    expect(run("{Empty} & 'x'")).toBe("x");
    expect(run("CONCATENATE({Empty}, 'y')")).toBe("y");
  });

  it("stringifies booleans and arrays", () => {
    expect(run("TRUE() & ''")).toBe("1");
    expect(run("FALSE() & ''")).toBe("0");
    expect(run("{Tags (multi)} & ''")).toBe("red, green");
    expect(run("CONCATENATE({Tags (multi)})")).toBe("red, green");
    expect(run("0.1 + 0.2 & ''")).toBe("0.3");
  });

  it("compares loosely", () => {
    expect(run("1 = '1'")).toBe(true);
    expect(run("'1.0' = 1")).toBe(true);
    expect(run("'' = BLANK()")).toBe(true);
    expect(run("{Empty} = ''")).toBe(true);
    expect(run("{Empty} = BLANK()")).toBe(true);
    expect(run("{Empty} = 0")).toBe(true);
    expect(run("'a' = 'A'")).toBe(false);
    expect(run("'a' != 'b'")).toBe(true);
    expect(run("'a' <> 'a'")).toBe(false);
    expect(run("TRUE() = 1")).toBe(true);
    expect(run("{Tags (multi)} = 'red, green'")).toBe(true);
  });

  it("compares numbers, strings and ISO dates", () => {
    expect(run("2 < 10")).toBe(true);
    expect(run("'2' < '10'")).toBe(true);
    expect(run("'apple' < 'banana'")).toBe(true);
    expect(run("{Due Date} < '2025-03-01T10:00:00.000Z'")).toBe(true);
    expect(run("'2025-03-01' = '2025-03-01T00:00:00.000Z'")).toBe(true);
    expect(run("'2025-03-02' >= {Due Date}")).toBe(true);
    expect(run("'2024-12-31' > '2025-01-01'")).toBe(false);
    expect(run("3 <= 3")).toBe(true);
  });

  it("concatenates with + when an operand is non-numeric text", () => {
    expect(run("'a' + 1")).toBe("a1");
    expect(run("'2' + 1")).toBe(3);
  });

  it("uses Airtable truthiness", () => {
    expect(run("IF(0, 'y', 'n')")).toBe("n");
    expect(run("IF('', 'y', 'n')")).toBe("n");
    expect(run("IF({Empty}, 'y', 'n')")).toBe("n");
    expect(run("IF(ARRAYCOMPACT({Empty}), 'y', 'n')")).toBe("n");
    expect(run("IF('0', 'y', 'n')")).toBe("y");
    expect(run("IF({Tags (multi)}, 'y', 'n')")).toBe("y");
  });

  it("returns #ERROR! for runtime errors and never throws", () => {
    expect(run("1 / 0")).toBe("#ERROR!");
    expect(run("{Empty} / {Empty}")).toBe("#ERROR!");
    expect(run("'abc' * 2")).toBe("#ERROR!");
    expect(run("POWER(10, 400)")).toBe("#ERROR!");
    expect(run("SQRT(-1)")).toBe("#ERROR!");
    expect(run("ERROR()")).toBe("#ERROR!");
    expect(run("DATEADD('nope', 1, 'days')")).toBe("#ERROR!");
    expect(run("REGEX_MATCH('a', '(')")).toBe("#ERROR!");
    expect(run("{Broken} + 1")).toBe("#ERROR!");
    const bad = { get: () => { throw new Error("boom"); }, recordId: 1, createdTime: "", modifiedTime: "", now: NOW };
    expect(evaluate(compileFormula("{A}", fields).ast, bad)).toBe("#ERROR!");
  });

  it("ISERROR catches errors", () => {
    expect(run("ISERROR(1 / 0)")).toBe(true);
    expect(run("ISERROR(ERROR())")).toBe(true);
    expect(run("ISERROR({Broken})")).toBe(true);
    expect(run("ISERROR(1)")).toBe(false);
    expect(run("IF(ISERROR(1/0), 'bad', 'ok')")).toBe("bad");
  });
});

describe("numeric functions", () => {
  const cases: [string, Value][] = [
    ["ABS(-3)", 3],
    ["AVERAGE(1, 2, 3, 4)", 2.5],
    ["AVERAGE({Nums})", 2.5],
    ["CEILING(2.1)", 3],
    ["CEILING(7, 5)", 10],
    ["CEILING(-2.5)", -2],
    ["CEILING(0.25, 0.1)", 0.3],
    ["COUNT(1, 'a', {Empty}, 2)", 2],
    ["COUNT({Nums})", 4],
    ["COUNTA(1, 'a', {Empty}, '')", 2],
    ["COUNTALL({Nums})", 5],
    ["EVEN(1.5)", 2],
    ["EVEN(3)", 4],
    ["EVEN(-1)", -2],
    ["EVEN(2)", 2],
    ["EXP(0)", 1],
    ["FLOOR(2.9)", 2],
    ["FLOOR(27, 5)", 25],
    ["FLOOR(-2.5)", -3],
    ["INT(-1.5)", -2],
    ["INT(1.9)", 1],
    ["LOG(100)", 2],
    ["LOG(8, 2)", 3],
    ["MAX(1, 5, 3)", 5],
    ["MAX({Nums})", 4],
    ["MIN(4, -2, 8)", -2],
    ["MIN({Empty})", 0],
    ["MOD(7, 3)", 1],
    ["MOD(5.5, 2)", 1.5],
    ["ODD(1.5)", 3],
    ["ODD(2)", 3],
    ["ODD(-2)", -3],
    ["ODD(3)", 3],
    ["POWER(2, 10)", 1024],
    ["ROUND(2.5)", 3],
    ["ROUND(-2.5)", -3],
    ["ROUND(1.005, 2)", 1.01],
    ["ROUND(1234.567, -2)", 1200],
    ["ROUND(3.14159, 3)", 3.142],
    ["ROUNDDOWN(3.789, 1)", 3.7],
    ["ROUNDDOWN(-3.789, 1)", -3.7],
    ["ROUNDDOWN(1999, -3)", 1000],
    ["ROUNDUP(3.211, 1)", 3.3],
    ["ROUNDUP(-3.211, 1)", -3.3],
    ["ROUNDUP(1001, -3)", 2000],
    ["SQRT(16)", 4],
    ["SUM(1, 2, 3)", 6],
    ["SUM({Nums})", 10],
    ["SUM(0.1, 0.2)", 0.3],
    ["SUM({Empty})", 0],
    ["VALUE('$1,000.50')", 1000.5],
    ["VALUE('42')", 42],
    ["VALUE('-7')", -7],
    ["VALUE('abc')", null],
  ];
  it.each(cases)("%s", (f, expected) => {
    expect(run(f)).toBe(expected);
  });

  it("errors on bad numeric input", () => {
    expect(run("MOD(1, 0)")).toBe("#ERROR!");
    expect(run("LOG(0)")).toBe("#ERROR!");
  });
});

describe("text functions", () => {
  const cases: [string, Value][] = [
    ["CONCATENATE('a', 1, TRUE(), {Empty}, 'b')", "a11b"],
    ["ENCODE_URL_COMPONENT('a b&c')", "a%20b%26c"],
    ["FIND('l', 'hello')", 3],
    ["FIND('l', 'hello', 4)", 4],
    ["FIND('z', 'hello')", 0],
    ["FIND('L', 'hello')", 0],
    ["LEFT('hello', 2)", "he"],
    ["LEFT('hi', 10)", "hi"],
    ["LEN('hello')", 5],
    ["LEN({Empty})", 0],
    ["LOWER('HeLLo')", "hello"],
    ["MID('hello world', 7, 5)", "world"],
    ["MID('hello', 2, 100)", "ello"],
    ["REPLACE('hello', 2, 3, 'EY')", "hEYo"],
    ["REPT('ab', 3)", "ababab"],
    ["RIGHT('hello', 3)", "llo"],
    ["RIGHT('hello', 0)", ""],
    ["SEARCH('L', 'hello')", 3],
    ["SEARCH('z', 'hello')", 0],
    ["SEARCH('o', 'foo boo', 4)", 6],
    ["SUBSTITUTE('a-b-c', '-', '+')", "a+b+c"],
    ["SUBSTITUTE('a-b-c', '-', '+', 2)", "a-b+c"],
    ["SUBSTITUTE('aaa', 'a', 'b', 3)", "aab"],
    ["SUBSTITUTE('a-b', '-', '+', 5)", "a-b"],
    ["T('x')", "x"],
    ["T(1)", ""],
    ["TRIM('  hi there  ')", "hi there"],
    ["UPPER({C})", "HELLO"],
    ["REGEX_MATCH('abc123', '[0-9]+')", true],
    ["REGEX_MATCH('abc', '^\\\\d')", false],
    ["REGEX_EXTRACT('order #4512 shipped', '\\\\d+')", "4512"],
    ["REGEX_EXTRACT('none', '\\\\d+')", null],
    ["REGEX_REPLACE('a1b22c', '[0-9]+', '#')", "a#b#c"],
    ["REGEX_REPLACE('John Smith', '(\\\\w+) (\\\\w+)', '$2, $1')", "Smith, John"],
  ];
  it.each(cases)("%s", (f, expected) => {
    expect(run(f)).toBe(expected);
  });
});

describe("logical functions", () => {
  const cases: [string, Value][] = [
    ["AND(1, 'x', TRUE())", true],
    ["AND(1, 0)", false],
    ["AND({Tags (multi)})", true],
    ["OR(0, '', 1)", true],
    ["OR(0, {Empty})", false],
    ["NOT(0)", true],
    ["NOT('a')", false],
    ["XOR(1, 0)", true],
    ["XOR(1, 1)", false],
    ["XOR(1, 1, 1)", true],
    ["BLANK()", null],
    ["IF({A} > 10, 'big', 'small')", "big"],
    ["IF({A} > 100, 'big')", null],
    ["IF({A} > 100, 'big', IF({A} > 5, 'mid', 'small'))", "mid"],
    ["IF(TRUE(), 1, 1/0)", 1],
    ["SWITCH(2, 1, 'one', 2, 'two', 'other')", "two"],
    ["SWITCH(9, 1, 'one', 2, 'two', 'other')", "other"],
    ["SWITCH(9, 1, 'one')", null],
    ["SWITCH({C}, 'hello', 'hi')", "hi"],
    ["SWITCH('3', 3, 'three')", "three"],
  ];
  it.each(cases)("%s", (f, expected) => {
    expect(run(f)).toBe(expected);
  });
});

describe("date functions", () => {
  const cases: [string, Value][] = [
    ["DATEADD('2025-01-31', 1, 'month')", "2025-02-28T00:00:00.000Z"],
    ["DATEADD('2025-03-01', 10, 'days')", "2025-03-11T00:00:00.000Z"],
    ["DATEADD('2025-03-01', -1, 'd')", "2025-02-28T00:00:00.000Z"],
    ["DATEADD('2025-03-01T10:00:00Z', 90, 'minutes')", "2025-03-01T11:30:00.000Z"],
    ["DATEADD('2025-03-01', 2, 'weeks')", "2025-03-15T00:00:00.000Z"],
    ["DATEADD('2024-02-29', 1, 'years')", "2025-02-28T00:00:00.000Z"],
    ["DATEADD('2025-01-15', 1, 'Q')", "2025-04-15T00:00:00.000Z"],
    ["DATESTR('2025-03-01T23:59:00.000Z')", "2025-03-01"],
    ["DATETIME_DIFF('2025-03-10', '2025-03-01', 'days')", 9],
    ["DATETIME_DIFF('2025-03-01', '2025-03-10', 'days')", -9],
    ["DATETIME_DIFF('2025-03-01T12:00:00Z', '2025-03-01', 'hours')", 12],
    ["DATETIME_DIFF('2025-03-01T12:00:00Z', '2025-03-01', 'h')", 12],
    ["DATETIME_DIFF('2025-03-01T00:01:30Z', '2025-03-01', 'seconds')", 90],
    ["DATETIME_DIFF('2025-03-01T00:01:30Z', '2025-03-01', 'm')", 1],
    ["DATETIME_DIFF('2025-03-01T00:00:00.250Z', '2025-03-01', 'ms')", 250],
    ["DATETIME_DIFF('2025-03-01T00:01:30Z', '2025-03-01')", 90],
    ["DATETIME_DIFF('2025-03-20', '2025-03-01', 'weeks')", 2],
    ["DATETIME_DIFF('2025-03-14', '2025-01-15', 'months')", 1],
    ["DATETIME_DIFF('2025-03-15', '2025-01-15', 'M')", 2],
    ["DATETIME_DIFF('2025-01-15', '2025-03-14', 'months')", -1],
    ["DATETIME_DIFF('2025-12-31', '2025-01-01', 'quarters')", 3],
    ["DATETIME_DIFF('2025-02-27', '2024-02-29', 'years')", 0],
    ["DATETIME_DIFF('2025-03-01', '2024-02-29', 'y')", 1],
    ["DATETIME_FORMAT('2025-03-05T14:07:09.000Z')", "2025-03-05T14:07:09.000Z"],
    ["DATETIME_PARSE('03/05/2025')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('05/03/2025', 'DD/MM/YYYY')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('2025-03-05 14:30', 'YYYY-MM-DD HH:mm')", "2025-03-05T14:30:00.000Z"],
    ["DATETIME_PARSE('2025-03-05 14:30')", "2025-03-05T14:30:00.000Z"],
    ["DATETIME_PARSE('2025-03-05T14:30:00+02:00')", "2025-03-05T12:30:00.000Z"],
    ["DATETIME_PARSE('March 5, 2025')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('5 Mar 2025')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('3/5/2025 2:30 PM')", "2025-03-05T14:30:00.000Z"],
    ["DATETIME_PARSE('Mar 5th 2025', 'MMM Do YYYY')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('1741132800', 'X')", "2025-03-05T00:00:00.000Z"],
    ["DATETIME_PARSE('13/45/2025', 'MM/DD/YYYY')", "#ERROR!"],
    ["DATETIME_PARSE('garbage')", "#ERROR!"],
    ["DATETIME_PARSE('')", null],
    ["DAY('2025-03-05')", 5],
    ["HOUR('2025-03-05T14:07:09Z')", 14],
    ["MINUTE('2025-03-05T14:07:09Z')", 7],
    ["SECOND('2025-03-05T14:07:09Z')", 9],
    ["MONTH('2025-03-05')", 3],
    ["YEAR('2025-03-05')", 2025],
    ["IS_AFTER('2025-03-02', '2025-03-01')", true],
    ["IS_AFTER('2025-03-01', '2025-03-01')", false],
    ["IS_BEFORE('2025-03-01', '2025-03-02')", true],
    ["IS_SAME('2025-03-01', '2025-03-01T00:00:00Z')", true],
    ["IS_SAME('2025-03-01T10:00:00Z', '2025-03-01T23:00:00Z')", false],
    ["IS_SAME('2025-03-01T10:00:00Z', '2025-03-01T23:00:00Z', 'day')", true],
    ["IS_SAME('2025-03-01', '2025-03-31', 'month')", true],
    ["IS_SAME('2025-03-01', '2026-03-01', 'year')", false],
    ["NOW()", "2025-03-15T12:00:00.000Z"],
    ["TODAY()", "2025-03-15"],
    ["TONOW('2025-03-10')", 5],
    ["FROMNOW('2025-03-20')", 4],
    ["WEEKDAY('2025-03-02')", 0],
    ["WEEKDAY('2025-03-01')", 6],
    ["WEEKDAY('2025-03-03', 'Monday')", 0],
    ["WEEKDAY('2025-03-02', 'Monday')", 6],
    ["WEEKNUM('2025-01-01')", 1],
    ["WEEKNUM('2025-01-05')", 2],
    ["WEEKNUM('2025-01-05', 'Monday')", 1],
    ["WEEKNUM('2025-03-15')", 11],
    ["WORKDAY('2025-03-07', 1)", "2025-03-10T00:00:00.000Z"],
    ["WORKDAY('2025-03-03', 10)", "2025-03-17T00:00:00.000Z"],
    ["WORKDAY('2025-03-10', -1)", "2025-03-07T00:00:00.000Z"],
    ["WORKDAY('2025-03-07', 1, '2025-03-10')", "2025-03-11T00:00:00.000Z"],
    ["WORKDAY_DIFF('2025-03-03', '2025-03-07')", 5],
    ["WORKDAY_DIFF('2025-03-03', '2025-03-16')", 10],
    ["WORKDAY_DIFF('2025-03-07', '2025-03-03')", -5],
    ["WORKDAY_DIFF('2025-03-03', '2025-03-07', '2025-03-04, 2025-03-05')", 3],
    ["WORKDAY_DIFF('2025-03-01', '2025-03-02')", 0],
    ["CREATED_TIME()", "2025-01-01T00:00:00.000Z"],
    ["LAST_MODIFIED_TIME()", "2025-02-01T10:00:00.000Z"],
    ["LAST_MODIFIED_TIME({A})", "2025-02-01T10:00:00.000Z"],
    ["RECORD_ID()", "42"],
    ["DAY({Empty})", "#ERROR!"],
    ["DATEADD({Due Date}, 1, 'fortnights')", "#ERROR!"],
  ];
  it.each(cases)("%s", (f, expected) => {
    expect(run(f)).toBe(expected);
  });
});

describe("DATETIME_FORMAT tokens", () => {
  const d = "'2025-03-05T14:07:09.042Z'";
  const cases: [string, string][] = [
    ["YYYY", "2025"],
    ["YY", "25"],
    ["MMMM", "March"],
    ["MMM", "Mar"],
    ["MM", "03"],
    ["M", "3"],
    ["DD", "05"],
    ["D", "5"],
    ["Do", "5th"],
    ["dddd", "Wednesday"],
    ["ddd", "Wed"],
    ["d", "3"],
    ["HH", "14"],
    ["H", "14"],
    ["hh", "02"],
    ["h", "2"],
    ["mm", "07"],
    ["m", "7"],
    ["ss", "09"],
    ["s", "9"],
    ["SSS", "042"],
    ["A", "PM"],
    ["a", "pm"],
    ["X", "1741183629"],
    ["x", "1741183629042"],
    ["Q", "1"],
    ["L", "03/05/2025"],
    ["LL", "March 5, 2025"],
    ["LLL", "March 5, 2025 2:07 PM"],
    ["YYYY-MM-DD HH:mm", "2025-03-05 14:07"],
    ["[Week of] MMM D", "Week of Mar 5"],
    ["D/M/YYYY h:mm a", "5/3/2025 2:07 pm"],
  ];
  it.each(cases)("%s", (fmt, expected) => {
    expect(run(`DATETIME_FORMAT(${d}, '${fmt}')`)).toBe(expected);
  });

  it("handles ordinals and midnight hours", () => {
    expect(run("DATETIME_FORMAT('2025-03-01', 'Do')")).toBe("1st");
    expect(run("DATETIME_FORMAT('2025-03-02', 'Do')")).toBe("2nd");
    expect(run("DATETIME_FORMAT('2025-03-03', 'Do')")).toBe("3rd");
    expect(run("DATETIME_FORMAT('2025-03-11', 'Do')")).toBe("11th");
    expect(run("DATETIME_FORMAT('2025-03-22', 'Do')")).toBe("22nd");
    expect(run("DATETIME_FORMAT('2025-03-01', 'h A')")).toBe("12 AM");
    expect(run("DATETIME_FORMAT({Due Date}, 'LL')")).toBe("March 1, 2025");
  });
});

describe("array functions", () => {
  it("works on arrays", () => {
    expect(run("ARRAYCOMPACT({Nums})")).toEqual([1, 2, 3, 4]);
    expect(run("ARRAYCOMPACT({Tags (multi)})")).toEqual(["red", "green"]);
    expect(run("ARRAYFLATTEN({Nums})")).toEqual([1, 2, null, 3, 4]);
    expect(run("ARRAYJOIN({Tags (multi)})")).toBe("red, green");
    expect(run("ARRAYJOIN({Tags (multi)}, ' | ')")).toBe("red | green");
    expect(run("ARRAYUNIQUE({Tags (multi)})", { fldTags: ["a", 1, "1", 1] })).toEqual(["a", 1, "1"]);
    expect(run("ARRAYUNIQUE({Tags (multi)})", { fldTags: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(run("ARRAYSLICE({Tags (multi)}, 2)", { fldTags: ["a", "b", "c", "d"] })).toEqual(["b", "c", "d"]);
    expect(run("ARRAYSLICE({Tags (multi)}, 2, 3)", { fldTags: ["a", "b", "c", "d"] })).toEqual(["b", "c"]);
    expect(run("ARRAYSLICE({Tags (multi)}, -2)", { fldTags: ["a", "b", "c", "d"] })).toEqual(["c", "d"]);
    expect(run("ARRAYJOIN({Empty})")).toBe("");
    expect(run("LEN({Tags (multi)})")).toBe(10);
  });
});

describe("FUNCTION_NAMES", () => {
  it("lists every function", () => {
    const required = "ABS AVERAGE CEILING COUNT COUNTA COUNTALL EVEN EXP FLOOR INT LOG MAX MIN MOD ODD POWER ROUND ROUNDDOWN ROUNDUP SQRT SUM VALUE CONCATENATE ENCODE_URL_COMPONENT FIND LEFT LEN LOWER MID REPLACE REPT RIGHT SEARCH SUBSTITUTE T TRIM UPPER REGEX_MATCH REGEX_EXTRACT REGEX_REPLACE AND BLANK ERROR FALSE IF ISERROR NOT OR SWITCH TRUE XOR DATEADD DATESTR DATETIME_DIFF DATETIME_FORMAT DATETIME_PARSE DAY HOUR IS_AFTER IS_BEFORE IS_SAME MINUTE MONTH NOW SECOND TODAY TONOW FROMNOW WEEKDAY WEEKNUM WORKDAY WORKDAY_DIFF YEAR ARRAYCOMPACT ARRAYFLATTEN ARRAYJOIN ARRAYUNIQUE ARRAYSLICE RECORD_ID CREATED_TIME LAST_MODIFIED_TIME".split(" ");
    for (const n of required) expect(FUNCTION_NAMES).toContain(n);
    expect(FUNCTION_NAMES.length).toBe(required.length);
  });
});

describe("performance", () => {
  it("evaluates 50,000 rows quickly", () => {
    const c = compileFormula('IF({A} > 10, ROUND({A} * {B}, 2), CONCATENATE({C}, "-", {A}))', fields);
    const row: Record<string, Value> = { fldA: 0, fldB: 1.2345, fldC: "x" };
    const context = { get: (id: string) => row[id] ?? null, recordId: 1, createdTime: "", modifiedTime: "", now: NOW };
    const start = performance.now();
    let last: Value = null;
    for (let i = 0; i < 50000; i++) {
      row.fldA = i % 20;
      last = evaluate(c.ast, context);
    }
    const ms = performance.now() - start;
    expect(last).toBe(23.46);
    expect(ms).toBeLessThan(500);
  });
});
