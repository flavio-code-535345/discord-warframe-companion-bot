import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { UserError } from '../services/clan.js';

export const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

/** Expected failures (bad input, missing config) go back to the model as tool errors it can act on. */
export function tool<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return json(await fn(args));
    } catch (err) {
      if (err instanceof UserError) return { isError: true, content: [{ type: 'text', text: err.message }] };
      throw err;
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const snowflake = z.string().regex(/^\d{15,22}$/, 'Discord IDs are 15-22 digit numbers');
