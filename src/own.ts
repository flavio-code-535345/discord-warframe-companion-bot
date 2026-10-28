/**
 * An entry of a plain lookup table, but only one the table really defines. `table[key]` also finds what every object inherits, so a
 * member typing "constructor" or a model asking for the tool "toString" would get a function back instead of "not found".
 */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
