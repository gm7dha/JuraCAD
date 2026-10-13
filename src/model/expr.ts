/**
 * Safe evaluator for the numbers people type into dimension boxes.
 *
 * Supports: numbers (1, 2.5, .5, 1e3), + - * / ^, parentheses, unary minus,
 * an optional unit after any number: mm, cm, m, in (or "), ft, the constant
 * pi, and variable names (see src/model/variables.ts).
 * Results are always in millimetres.
 *
 * Examples: "10 + 2" → 12, "25.4 mm" → 25.4, "1 in" → 25.4, "(3 + 1) * 2" → 8,
 * "wall * 2" → 4 when the variable wall is 2.
 */

export type EvalResult = { ok: true; value: number } | { ok: false; error: string };

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

type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "unit"; factor: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "lparen" }
  | { kind: "rparen" };

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
      const unit = /^\s*(mm|cm|ft|in|m|")(?![A-Za-z0-9_])/i.exec(src.slice(i));
      if (unit) {
        tokens.push({ kind: "unit", factor: UNIT_TO_MM[unit[1].toLowerCase()] });
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
      tokens.push({ kind: "op", value: ch as "+" | "-" | "*" | "/" | "^" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    throw new Error(`"${ch}" isn't allowed here`);
  }
  return tokens;
}

/** Recursive-descent parser: expr = term (('+'|'-') term)* ; term = power (('*'|'/') power)* ; power = unary ('^' power)? */
class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: Scope,
  ) {}

  parse(): number {
    if (this.tokens.length === 0) throw new Error("Enter a value");
    const value = this.expr();
    if (this.pos < this.tokens.length) throw new Error("Unexpected text at the end");
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t?.kind === "op" && t.value === op;
  }

  private expr(): number {
    let value = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const rhs = this.term();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private term(): number {
    let value = this.power();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "unit") {
        this.pos++;
        value *= t.factor;
        continue;
      }
      if (!(this.isOp("*") || this.isOp("/"))) break;
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const rhs = this.power();
      if (op === "/" && rhs === 0) throw new Error("Can't divide by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }

  private power(): number {
    const base = this.unary();
    if (this.isOp("^")) {
      this.pos++;
      return Math.pow(base, this.power());
    }
    return base;
  }

  private unary(): number {
    if (this.isOp("-")) {
      this.pos++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error("The expression ends too early");
    if (t.kind === "num") {
      this.pos++;
      return t.value;
    }
    if (t.kind === "name") {
      this.pos++;
      if (t.value === "pi") return Math.PI;
      if (RESERVED_NAMES.has(t.value)) throw new Error(`Put a number before "${t.value}", e.g. 5 ${t.value}`);
      const v = Object.prototype.hasOwnProperty.call(this.scope, t.value) ? this.scope[t.value] : undefined;
      if (v === undefined) throw new Error(`There's no variable called "${t.value}"`);
      return v;
    }
    if (t.kind === "lparen") {
      this.pos++;
      const value = this.expr();
      if (this.peek()?.kind !== "rparen") throw new Error("Missing closing bracket");
      this.pos++;
      return value;
    }
    if (t.kind === "unit") throw new Error("Put a number before the unit");
    throw new Error("Expected a number");
  }
}

export function evaluate(src: string, scope: Scope = currentScope): EvalResult {
  try {
    const value = new Parser(tokenize(src), scope).parse();
    if (!Number.isFinite(value)) return { ok: false, error: "That isn't a finite number" };
    // Tidy floating-point noise such as 0.1 + 0.2 = 0.30000000000000004.
    return { ok: true, value: Math.round(value * 1e9) / 1e9 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Variable names an expression uses (for renaming and "used in" counts). */
export function namesIn(src: string): string[] {
  try {
    return tokenize(src)
      .filter((t): t is { kind: "name"; value: string } => t.kind === "name" && !RESERVED_NAMES.has(t.value))
      .map((t) => t.value);
  } catch {
    return [];
  }
}

/** Format millimetres for display: up to 3 decimals, no trailing zeros. */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded} mm`;
}
