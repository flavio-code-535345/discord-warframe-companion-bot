/**
 * A small arithmetic evaluator for sums asked in chat ("what is 9 x 2"): numbers, + - * / % ^, brackets, a few functions. A
 * recursive-descent parser, never eval, so a typed expression can't run anything.
 */

import { own } from '../own.js';

const FUNCTIONS: Record<string, (...n: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  ln: Math.log,
  log: Math.log10,
  pow: Math.pow,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** The names the calculator knows, for whoever decides whether a message is a sum (answers/understand.ts). */
export const CALC_FUNCTIONS = Object.keys(FUNCTIONS);
export const CALC_CONSTANTS = Object.keys(CONSTANTS);

const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

const CALL = `(?:${CALC_FUNCTIONS.join('|')})\\(`;
/** An x between two operands is a multiplication ("9 x 2", "2 x pi", "3 x (4+1)"); the x in "max(" is not. */
const TIMES = new RegExp(`×|(?<=[\\d.)]|pi)x(?=[\\d.(]|pi(?![a-z])|${CALL})`, 'gi');
/** An operand right before a bracket or a name multiplies: "2pi", "3(4+1)", "2sqrt(16)", "(1+2)(3+4)". Not before `e`: "2e3" is 2000. */
const IMPLIED = new RegExp(`(?<=[\\d.)])(?=\\(|pi(?![a-z])|${CALL})`, 'gi');

export function calculate(expression: string): number {
  const src = expression
    .replace(/\s+/g, '')
    .replace(/π/g, 'pi')
    // "√16" takes the number after it; "√(9+16)" takes the bracket.
    .replace(/√(\d+\.?\d*|\.\d+)/g, 'sqrt($1)')
    .replace(/√/g, 'sqrt')
    .replace(/÷/g, '/')
    .replace(TIMES, '*')
    .replace(IMPLIED, '*');
  if (!src || src.length > MAX_LENGTH) throw new Error(`the expression must be 1-${MAX_LENGTH} characters`);
  let pos = 0;
  let depth = 0;

  const fail = (what: string): never => {
    throw new Error(`${what} at position ${pos + 1}`);
  };

  function number(): number {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos));
    if (!m) return fail('expected a number');
    pos += m[0].length;
    return Number(m[0]);
  }

  function primary(): number {
    if (++depth > MAX_DEPTH) fail('expression is nested too deeply');
    try {
      const c = src[pos];
      if (c === '(') {
        pos++;
        const v = sum();
        if (src[pos] !== ')') fail('expected ")"');
        pos++;
        return v;
      }
      if (c === '-' || c === '+') {
        pos++;
        const v = power();
        return c === '-' ? -v : v;
      }
      if (c !== undefined && /[a-z]/i.test(c)) {
        const name = /^[a-z]+/i.exec(src.slice(pos))![0].toLowerCase();
        pos += name.length;
        if (src[pos] === '(') {
          // Only the functions listed above: `FUNCTIONS[name]` would also find what every object inherits ("constructor").
          const fn = own(FUNCTIONS, name);
          if (!fn) return fail(`unknown function "${name}"`);
          pos++;
          const args: number[] = [sum()];
          while (src[pos] === ',') {
            pos++;
            args.push(sum());
          }
          if (src[pos] !== ')') fail('expected ")"');
          pos++;
          return fn(...args);
        }
        const k = own(CONSTANTS, name);
        return k ?? fail(`unknown name "${name}"`);
      }
      const n = number();
      return src[pos] === '%' && !/[\d.(a-z]/i.test(src[pos + 1] ?? '') ? (pos++, n / 100) : n;
    } finally {
      depth--;
    }
  }

  function power(): number {
    const base = primary();
    if (src[pos] === '^') {
      pos++;
      return base ** power();
    }
    return base;
  }

  function product(): number {
    let v = power();
    for (;;) {
      const c = src[pos];
      if (c === '*') (pos++, (v *= power()));
      else if (c === '/') (pos++, (v /= power()));
      else if (c === '%') (pos++, (v %= power()));
      else return v;
    }
  }

  function sum(): number {
    let v = product();
    for (;;) {
      const c = src[pos];
      if (c === '+') (pos++, (v += product()));
      else if (c === '-') (pos++, (v -= product()));
      else return v;
    }
  }

  const result = sum();
  if (pos < src.length) fail(`unexpected "${src[pos]}"`);
  if (!Number.isFinite(result)) throw new Error('the result is not a finite number (division by zero?)');
  return result;
}
