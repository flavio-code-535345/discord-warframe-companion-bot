import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder, type StringSelectMenuInteraction } from 'discord.js';
import { loadRotations } from '../answers/circuit.js';
import type { AppContext } from '../context.js';
import { UserError } from '../errors.js';
import { MAX_TRACKERS_PER_USER, MISSION_TYPES, type TrackerSpec, describeTracker } from '../trackers.js';
import { ACTIVITIES } from './commands/lfg.js';
import { subscribe } from './subscriptions.js';

/**
 * Dropdown menus for the trackers that take a choice from a list (`/track pick what:`, and `/track incarnon` without a weapon).
 * The custom ID is `trackpick:<what>:<menu number>`, the picked value is the choice itself, so a menu keeps working after a restart.
 * Discord allows 25 options per menu and 5 menus per message, so a longer list is split over several menus (125 choices at most).
 */
export const PICKERS = ['incarnon', 'squads', 'sortie', 'arbitration'] as const;
export type Picker = (typeof PICKERS)[number];
export const isPicker = (v: string): v is Picker => (PICKERS as readonly string[]).includes(v);

/** The value of the "every one" option of squads, sorties and Arbitrations (an empty filter). */
export const ANY = '*';
const PER_MENU = 25;

export const PICKER_LABELS: Record<Picker, string> = {
  incarnon: 'Incarnon weapon',
  squads: 'Squad activity',
  sortie: 'Sortie mission',
  arbitration: 'Arbitration mission type',
};

export interface PickChoice {
  label: string;
  value: string;
}

/** The choices of a picker (the first of squads, sorties and Arbitrations is "every one"). */
export async function pickChoices(ctx: AppContext, what: Picker): Promise<PickChoice[]> {
  const plain = (names: string[], max: number) => [...new Set(names)].map((n) => ({ label: n.slice(0, 100), value: n.slice(0, max) }));
  if (what === 'incarnon') {
    // The wiki's Circuit rotation lists every Incarnon weapon; without it the member can still type a name.
    const rotations = await loadRotations().catch(() => null);
    const names = [...new Set((rotations?.incarnon ?? []).flat())].sort();
    if (!names.length) throw new UserError('The Incarnon weapon list is not available right now. Type the name: `/track incarnon weapon:Soma`.');
    return plain(names, 60).slice(0, PER_MENU * 5);
  }
  if (what === 'squads') {
    const known = [...new Set([...ctx.store.listActivities().map((a) => a.name), ...ACTIVITIES])];
    return [{ label: 'Every squad', value: ANY }, ...plain(known, 100)].slice(0, PER_MENU * 5);
  }
  const every = what === 'sortie' ? 'Every sortie' : 'Every Arbitration';
  return [{ label: every, value: ANY }, ...plain(MISSION_TYPES, 100)].slice(0, PER_MENU * 5);
}

export function pickRows(what: Picker, choices: PickChoice[]): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let i = 0; i < choices.length; i += PER_MENU) {
    const chunk = choices.slice(i, i + PER_MENU);
    const first = chunk[0]!.label;
    const last = chunk[chunk.length - 1]!.label;
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trackpick:${what}:${rows.length}`)
          .setPlaceholder(choices.length > PER_MENU ? `${PICKER_LABELS[what]}: ${first} – ${last}`.slice(0, 150) : `${PICKER_LABELS[what]}…`)
          .addOptions(chunk.map((c) => ({ label: c.label, value: c.value }))),
      ),
    );
  }
  return rows;
}

export function pickerSpec(what: Picker, value: string): TrackerSpec {
  if (what === 'incarnon') return { kind: 'incarnon', weapon: value };
  if (what === 'squads') return value === ANY ? { kind: 'squad' } : { kind: 'squad', activity: value };
  if (what === 'sortie') return value === ANY ? { kind: 'sortie' } : { kind: 'sortie', mission: value };
  return value === ANY ? { kind: 'arbitration' } : { kind: 'arbitration', type: value };
}

/** The message with the menu(s): what to pick and the rows. */
export async function pickMessage(ctx: AppContext, what: Picker) {
  return { content: `Pick one and Ordis DMs you about it. (${PICKER_LABELS[what]})`, components: pickRows(what, await pickChoices(ctx, what)), flags: MessageFlags.Ephemeral } as const;
}

/** A pick in one of the menus: sets the tracker and turns the message into the answer. */
export async function handlePickSelect(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const [, what] = interaction.customId.split(':');
  const value = interaction.values[0];
  if (!what || !isPicker(what) || !value || value.length > 100) throw new UserError('That menu is no longer supported.');
  const spec = pickerSpec(what, value);
  const result = subscribe(ctx, interaction.user.id, spec);
  if (result === 'full') throw new UserError(`You already have ${MAX_TRACKERS_PER_USER} trackers. Remove one with \`/track remove\` first.`);
  const text =
    result === 'had'
      ? `You already have that one: ${describeTracker(spec)}.`
      : `Tracker set: ${describeTracker(spec)}. Make sure Privacy Settings → Direct Messages from server members is on for this server.`;
  await interaction.update({ content: text, components: [] });
}
