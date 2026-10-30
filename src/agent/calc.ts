/**
 * A small arithmetic evaluator for the agent's `calculate` tool (endo costs, drop odds, ducat totals): numbers, + - * / % ^, brackets,
 * a few functions. A recursive-descent parser, never eval, so a model-written expression can't run anything.
 */

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

const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, '').replace(/×|(?<=\d)x(?=\d)/g, '*').replace(/÷/g, '/');
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
          const fn = FUNCTIONS[name];
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
        const k = CONSTANTS[name];
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

/** Warframe's daily reset is 00:00 UTC; the weekly one (Nightwave, Baro's weekly rotation, Steel Path honors) is Monday 00:00 UTC. */
export function clockInfo(now = new Date()): Record<string, string | number> {
  const dayMs = 86_400_000;
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const nextWeekly = startOfDay + (7 - sinceMonday) * dayMs;
  const left = (to: number): string => {
    const mins = Math.round((to - now.getTime()) / 60_000);
    return mins >= 60 * 24 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };
  return {
    nowUtc: now.toISOString(),
    weekdayUtc: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()]!,
    nextDailyReset: new Date(startOfDay + dayMs).toISOString(),
    inUntilDailyReset: left(startOfDay + dayMs),
    nextWeeklyReset: new Date(nextWeekly).toISOString(),
    inUntilWeeklyReset: left(nextWeekly),
  };
}
