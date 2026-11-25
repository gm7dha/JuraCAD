/**
 * Safe evaluator for the numbers people type into dimension boxes.
 *
 * Supports: numbers (1, 2.5, .5, 1e3), + - * / ^, parentheses, unary minus,
 * an optional unit after any number: mm, cm, m, in (or "), ft, the constant
 * pi, and variable names (see src/model/variables.ts).
 * Results are always in millimetres.
 *
 * Functions and angles (as Onshape's expressions): sin cos tan asin acos atan atan2 sqrt abs min max round floor
 * ceil log (natural) ln log10 exp pow, and the angle units deg (or °) and rad. An angle is kept apart from plain
 * numbers: "30 deg" is an angle; sin/cos/tan take an angle (a plain number there is radians, as in Onshape and
 * maths); asin/acos/atan/atan2 give one. A plain number added to (or compared in min/max with) an angle counts as
 * degrees, as in an angle box. An expression whose result is an angle gives its value in DEGREES with `angle: true`
 * (so angle boxes take "30 deg" and "0.5 rad"). Lengths are plain millimetre numbers — there's no further
 * dimensional analysis: sqrt(400) is 20 (mm), sqrt(1 in) the square root of 25.4.
 * A variable whose value is an angle is marked in the scope by an extra key `°<name>` (ANGLE_KEY), so sin(a) works.
 * Nothing new changes what an older expression gives: "name(" was never valid, units deg/rad only after a number
 * or ")", and function names and deg/rad aren't reserved (old variables called max or rad still work).
 *
 * Examples: "10 + 2" → 12, "25.4 mm" → 25.4, "1 in" → 25.4, "(3 + 1) * 2" → 8,
 * "wall * 2" → 4 when the variable wall is 2.
 */

export type EvalResult = { ok: true; value: number; angle?: true } | { ok: false; error: string };

const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  '"': 25.4,
  ft: 304.8,
};

/** Variable values in mm, by name. */
export type Scope = Readonly<Record<string, number>>;

/**
 * The document's variables, used when `evaluate` isn't given a scope. The app
 * keeps this up to date (store.ts), and the geometry worker sets it for each
 * rebuild, so every box, dimension and feature sees the same values.
 */
let currentScope: Scope = {};
export function setCurrentScope(scope: Scope): void {
  currentScope = scope;
}
export function getCurrentScope(): Scope {
  return currentScope;
}

/** Words that can't be variable names (units and constants). */
export const RESERVED_NAMES = new Set(["mm", "cm", "m", "in", "ft", "pi"]);

/** The scope key that marks variable `name` as an angle (its value then is in degrees). */
export const ANGLE_KEY = (name: string) => `°${name}`;

/** Angle units: radians per unit. */
const ANGLE_UNITS: Record<string, number> = { deg: Math.PI / 180, "°": Math.PI / 180, rad: 1 };
const DEG = Math.PI / 180;

/** The functions, with a short example each (shown in error messages and offered while typing). */
export const FUNCTIONS: Readonly<Record<string, { args: [number, number]; example: string }>> = {
  sin: { args: [1, 1], example: "sin(30 deg)" },
  cos: { args: [1, 1], example: "cos(30 deg)" },
  tan: { args: [1, 1], example: "tan(30 deg)" },
  asin: { args: [1, 1], example: "asin(0.5)" },
  acos: { args: [1, 1], example: "acos(0.5)" },
  atan: { args: [1, 1], example: "atan(1)" },
  atan2: { args: [2, 2], example: "atan2(3, 4)" },
  sqrt: { args: [1, 1], example: "sqrt(16)" },
  abs: { args: [1, 1], example: "abs(-5)" },
  min: { args: [2, Infinity], example: "min(10, width / 2)" },
  max: { args: [2, Infinity], example: "max(10, width / 2)" },
  round: { args: [1, 1], example: "round(12.6)" },
  floor: { args: [1, 1], example: "floor(12.6)" },
  ceil: { args: [1, 1], example: "ceil(12.2)" },
  log: { args: [1, 1], example: "log(10)" },
  ln: { args: [1, 1], example: "ln(10)" },
  log10: { args: [1, 1], example: "log10(100)" },
  exp: { args: [1, 1], example: "exp(1)" },
  pow: { args: [2, 2], example: "pow(2, 3)" },
};
export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);


type Op = "+" | "-" | "*" | "/" | "^";
type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "unit"; factor: number; angle?: true; name: string }
  | { kind: "op"; value: Op }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

// Units that may follow a number or a closing bracket (spaces allowed before them).
const UNIT_AFTER = /^\s*(mm|cm|ft|in|m|deg|rad|"|°)(?![A-Za-z0-9_])/i;

function unitToken(raw: string): Token {
  const name = raw.toLowerCase();
  if (name in ANGLE_UNITS) return { kind: "unit", factor: ANGLE_UNITS[name], angle: true, name };
  return { kind: "unit", factor: UNIT_TO_MM[name], name };
}

function tokenize(src: string): Token[] {
  // (names are looked up later, by the parser)
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`Couldn't read the number at "${src.slice(i)}"`);
      const value = Number(m[0]);
      i += m[0].length;
      tokens.push({ kind: "num", value });
      // Optional unit after the number (spaces allowed). It applies to the whole
      // product or fraction before it, so "1/4 in" is a quarter inch.
      const unit = UNIT_AFTER.exec(src.slice(i));
      if (unit) {
        tokens.push(unitToken(unit[1]));
        i += unit[0].length;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/^".includes(ch)) {
      tokens.push({ kind: "op", value: ch as Op });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      // A unit after a bracket applies to what's in it: "(1 + 1/4) in".
      const unit = UNIT_AFTER.exec(src.slice(i));
      if (unit) {
        tokens.push(unitToken(unit[1]));
        i += unit[0].length;
      }
      continue;
    }
    if (ch === "°") throw new Error("Put a number before °, e.g. 30°");
    throw new Error(`"${ch}" isn't allowed here`);
  }
  return tokens;
}

/** A worked-out value: a plain number (millimetres, or no unit), or an angle in radians. */
interface Val {
  v: number;
  angle: boolean;
}
const plainVal = (v: number): Val => ({ v, angle: false });
const angleVal = (v: number): Val => ({ v, angle: true });
/** As an angle: a plain number beside an angle counts as degrees. */
const asAngle = (x: Val): number => (x.angle ? x.v : x.v * DEG);

/** The text between brackets after a function name, e.g. "sin(" … ")". */
const isFunctionCall = (tokens: Token[], i: number) => tokens[i]?.kind === "name" && tokens[i + 1]?.kind === "lparen";

/** Recursive-descent parser: expr = term (('+'|'-') term)* ; term = power (('*'|'/') power | unit)* ; power = unary ('^' power)? */
class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: Scope,
  ) {}

  parse(): Val {
    if (this.tokens.length === 0) throw new Error("Enter a value");
    const value = this.expr();
    if (this.pos < this.tokens.length) {
      if (this.peek()?.kind === "comma") throw new Error("A comma only goes between a function's values, like min(10, 20)");
      throw new Error("Unexpected text at the end");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t?.kind === "op" && t.value === op;
  }

  private expr(): Val {
    let value = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const rhs = this.term();
      if (value.angle || rhs.angle) {
        const a = asAngle(value);
        const b = asAngle(rhs);
        value = angleVal(op === "+" ? a + b : a - b);
      } else value = plainVal(op === "+" ? value.v + rhs.v : value.v - rhs.v);
    }
    return value;
  }

  private term(): Val {
    let value = this.power();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "unit") {
        this.pos++;
        if (value.angle) throw new Error(`That's already an angle — "${t.name}" can't go after it`);
        value = t.angle ? angleVal(value.v * t.factor) : plainVal(value.v * t.factor);
        continue;
      }
      if (!(this.isOp("*") || this.isOp("/"))) break;
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const rhs = this.power();
      if (op === "/" && rhs.v === 0) throw new Error("Can't divide by zero");
      if (op === "*") {
        if (value.angle && rhs.angle) throw new Error("Can't multiply two angles together");
        value = { v: value.v * rhs.v, angle: value.angle || rhs.angle };
      } else {
        if (rhs.angle && !value.angle) throw new Error("Can't divide by an angle");
        // An angle over an angle is a plain number (how many times one goes into the other).
        value = { v: value.v / rhs.v, angle: value.angle && !rhs.angle };
      }
    }
    return value;
  }

  private power(): Val {
    const base = this.unary();
    if (this.isOp("^")) {
      this.pos++;
      const exponent = this.power();
      if (base.angle || exponent.angle) throw new Error("Angles can't be raised to a power");
      return plainVal(Math.pow(base.v, exponent.v));
    }
    return base;
  }

  private unary(): Val {
    if (this.isOp("-")) {
      this.pos++;
      const x = this.unary();
      return { v: -x.v, angle: x.angle };
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Val {
    const t = this.peek();
    if (!t) throw new Error("The expression ends too early");
    if (t.kind === "num") {
      this.pos++;
      return plainVal(t.value);
    }
    if (t.kind === "name") {
      if (isFunctionCall(this.tokens, this.pos)) return this.call(t.value);
      this.pos++;
      if (t.value === "pi") return plainVal(Math.PI);
      if (RESERVED_NAMES.has(t.value)) throw new Error(`Put a number before "${t.value}", e.g. 5 ${t.value}`);
      const has = (k: string) => Object.prototype.hasOwnProperty.call(this.scope, k);
      const v = has(t.value) ? this.scope[t.value] : undefined;
      if (v === undefined) {
        const lower = t.value.toLowerCase();
        if (lower === "deg" || lower === "rad") throw new Error(`Put a number before "${t.value}", e.g. 30 ${lower}`);
        if (lower in FUNCTIONS) throw new Error(`${lower} needs brackets, like ${FUNCTIONS[lower].example}`);
        throw new Error(`There's no variable called "${t.value}"`);
      }
      return has(ANGLE_KEY(t.value)) ? angleVal(v * DEG) : plainVal(v);
    }
    if (t.kind === "lparen") {
      this.pos++;
      const value = this.expr();
      if (this.peek()?.kind === "comma") throw new Error("A comma only goes between a function's values, like min(10, 20)");
      if (this.peek()?.kind !== "rparen") throw new Error("Missing closing bracket");
      this.pos++;
      return value;
    }
    if (t.kind === "unit") throw new Error("Put a number before the unit");
    if (t.kind === "comma") throw new Error("Something's missing before the comma");
    throw new Error("Expected a number");
  }

  /** name ( expr (, expr)* ) */
  private call(raw: string): Val {
    const name = raw.toLowerCase();
    const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!fn) throw new Error(`There's no function called "${raw}" — try sin, cos, tan, sqrt, abs, min, max or round`);
    this.pos += 2; // name, "("
    const args: Val[] = [];
    if (this.peek()?.kind !== "rparen") {
      for (;;) {
        args.push(this.expr());
        if (this.peek()?.kind === "comma") {
          this.pos++;
          continue;
        }
        break;
      }
    }
    if (this.peek()?.kind !== "rparen") throw new Error(`Missing closing bracket after ${name}(…`);
    this.pos++;
    const [least, most] = fn.args;
    if (args.length < least || args.length > most) {
      const how = name === "sin" || name === "cos" || name === "tan" ? "an angle" : least === most ? (least === 1 ? "one value" : `${least} values`) : `at least ${least} values`;
      throw new Error(`${name} needs ${how}, like ${fn.example}`);
    }
    return this.apply(name, args, fn.example);
  }

  private apply(name: string, args: Val[], example: string): Val {
    const [x, y] = args;
    const plainArg = (a: Val): number => {
      if (a.angle) throw new Error(`${name} needs a plain number, not an angle, like ${example}`);
      return a.v;
    };
    switch (name) {
      case "sin":
        return plainVal(Math.sin(x.v));
      case "cos":
        return plainVal(Math.cos(x.v));
      case "tan": {
        if (Math.abs(Math.cos(x.v)) < 1e-12) throw new Error("tan of a right angle (90°) is endless");
        return plainVal(Math.tan(x.v));
      }
      case "asin":
      case "acos": {
        const n = plainArg(x);
        if (n < -1 - 1e-12 || n > 1 + 1e-12) throw new Error(`${name} needs a number from -1 to 1`);
        const c = Math.max(-1, Math.min(1, n));
        return angleVal(name === "asin" ? Math.asin(c) : Math.acos(c));
      }
      case "atan":
        return angleVal(Math.atan(plainArg(x)));
      case "atan2": {
        const a = plainArg(x);
        const b = plainArg(y);
        if (a === 0 && b === 0) throw new Error("atan2 needs one of its values not to be 0");
        return angleVal(Math.atan2(a, b));
      }
      case "sqrt": {
        const n = plainArg(x);
        if (n < 0) throw new Error("Can't take the square root of a number below 0");
        return plainVal(Math.sqrt(n));
      }
      case "abs":
        return { v: Math.abs(x.v), angle: x.angle };
      case "min":
      case "max": {
        const pick = name === "min" ? Math.min : Math.max;
        if (args.some((a) => a.angle)) return angleVal(pick(...args.map(asAngle)));
        return plainVal(pick(...args.map((a) => a.v)));
      }
      case "round":
      case "floor":
      case "ceil": {
        const f = Math[name];
        // An angle is rounded in degrees: round(30.4 deg) is 30°.
        return x.angle ? angleVal(f(x.v / DEG) * DEG) : plainVal(f(x.v));
      }
      case "log":
      case "ln":
      case "log10": {
        const n = plainArg(x);
        if (n <= 0) throw new Error(`${name} needs a number above 0`);
        return plainVal(name === "log10" ? Math.log10(n) : Math.log(n));
      }
      case "exp":
        return plainVal(Math.exp(plainArg(x)));
      case "pow":
        return plainVal(Math.pow(plainArg(x), plainArg(y)));
    }
    throw new Error(`There's no function called "${name}"`);
  }
}

export function evaluate(src: string, scope: Scope = currentScope): EvalResult {
  try {
    const r = new Parser(tokenize(src), scope).parse();
    const value = r.angle ? r.v / DEG : r.v;
    if (!Number.isFinite(value)) return { ok: false, error: "That isn't a finite number" };
    // Tidy floating-point noise such as 0.1 + 0.2 = 0.30000000000000004.
    const tidy = Math.round(value * 1e9) / 1e9;
    return r.angle ? { ok: true, value: tidy, angle: true } : { ok: true, value: tidy };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Names in the text that are variables (not functions being called, not pi). */
function variableTokens(tokens: Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "name" && !isFunctionCall(tokens, i) && !RESERVED_NAMES.has(t.value)) out.push(t.value);
  });
  return out;
}

/** True when the text uses a unit (mm, in, deg…) or a variable — so it doesn't depend on the document's units. */
export function hasUnitsOrNames(src: string): boolean {
  try {
    const tokens = tokenize(src);
    return tokens.some((t) => t.kind === "unit") || tokens.some((t, i) => t.kind === "name" && t.value !== "pi" && !isFunctionCall(tokens, i));
  } catch {
    return true;
  }
}

/** Variable names an expression uses (for renaming and "used in" counts). */
export function namesIn(src: string): string[] {
  try {
    return variableTokens(tokenize(src));
  } catch {
    return [];
  }
}

/** Format millimetres for display: up to 3 decimals, no trailing zeros. */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded} mm`;
}
