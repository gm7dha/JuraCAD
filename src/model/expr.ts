/**
 * Safe evaluator for the numbers people type into dimension boxes.
 *
 * Supports: numbers (1, 2.5, .5, 1e3), + - * / ^, parentheses, unary minus,
 * and an optional unit after any number: mm, cm, m, in (or "), ft.
 * Results are always in millimetres. No variables yet (Phase 3).
 *
 * Examples: "10 + 2" → 12, "25.4 mm" → 25.4, "1 in" → 25.4, "(3 + 1) * 2" → 8
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

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenize(src: string): Token[] {
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
      let value = Number(m[0]);
      i += m[0].length;
      // Optional unit directly after the number (spaces allowed).
      const rest = src.slice(i);
      const unit = /^\s*(mm|cm|ft|in|m|")(?![a-z])/i.exec(rest);
      if (unit) {
        value *= UNIT_TO_MM[unit[1].toLowerCase()];
        i += unit[0].length;
      }
      tokens.push({ kind: "num", value });
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
  constructor(private readonly tokens: Token[]) {}

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
    while (this.isOp("*") || this.isOp("/")) {
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
    if (t.kind === "lparen") {
      this.pos++;
      const value = this.expr();
      if (this.peek()?.kind !== "rparen") throw new Error("Missing closing bracket");
      this.pos++;
      return value;
    }
    throw new Error("Expected a number");
  }
}

export function evaluate(src: string): EvalResult {
  try {
    const value = new Parser(tokenize(src)).parse();
    if (!Number.isFinite(value)) return { ok: false, error: "That isn't a finite number" };
    // Tidy floating-point noise such as 0.1 + 0.2 = 0.30000000000000004.
    return { ok: true, value: Math.round(value * 1e9) / 1e9 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Format millimetres for display: up to 3 decimals, no trailing zeros. */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded} mm`;
}
