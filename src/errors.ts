/**
 * An expected failure: what the person asked for can't be done, and the message says why in words meant for them. Discord shows it
 * ephemerally and MCP returns it as an `isError` result; any other error is logged and shown generically.
 *
 * It has a file of its own, with no imports, so the data modules (warframe/, rivens/, imaging/, trackers.ts) can throw it without
 * depending on the Discord service layer. `services/clan.ts` re-exports it. Importing it from there in `warframe/worldstate.ts` once
 * closed a circle (trackers → worldstate → services/clan → discord/subscriptions → feeds/controls → trackers) that failed whenever
 * `trackers.ts` was the first module loaded; `test/layers.test.ts` keeps the data modules from reaching up again.
 */
export class UserError extends Error {}
