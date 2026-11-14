import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageActionRowComponentBuilder, StringSelectMenuBuilder } from 'discord.js';
import { DEFAULT_CRACK_PLAT, DEFAULT_CRACK_QUIET_HOURS } from '../../alecaframe/crack.js';
import { CYCLE_CHOICES, type TrackerSpec } from '../../trackers.js';
import { type EmojiName, emojiFor } from '../emoji.js';
import type { Row } from './parts.js';
import type { FeedId } from './types.js';

/**
 * The controls under the boards: each board has a "DM me when…" menu with the notifications that fit it (custom ID
 * `feeds:track:<feed>`) and a "My notifications" button (`feeds:mine`, an ephemeral list with a menu to remove them). The notifications
 * that are a plain on/off have a toggle button (`notify:<key>`, `TOGGLES`). Ordis pings no role: every notification is a DM a member
 * asked for. Every answer is ephemeral. The IDs carry no state, so they keep working after a restart.
 */

export interface TrackOption {
  value: string;
  /** The boards whose menu offers it. */
  feeds: FeedId[];
  label: string;
  description: string;
  emoji?: EmojiName;
  spec: TrackerSpec;
}

const REWARD_FEEDS: FeedId[] = ['alerts', 'invasions'];
const reward = (value: string, label: string, keyword: string, emoji?: EmojiName): TrackOption => ({
  value,
  feeds: REWARD_FEEDS,
  label,
  description: 'In alerts, invasions, events, Baro, Darvo and more',
  ...(emoji ? { emoji } : {}),
  spec: { kind: 'reward', keyword },
});

const arbitrationType = (type: string): TrackOption => ({
  value: `arbitration-${type.toLowerCase().replace(/\s+/g, '-')}`,
  feeds: ['arbitrations'],
  label: `${type} Arbitrations`,
  description: `Any tier, 10 minutes before it starts`,
  spec: { kind: 'arbitration', type },
});

const fissure = (value: string, label: string, description: string, spec: Omit<Extract<TrackerSpec, { kind: 'fissure' }>, 'kind'>, emoji?: EmojiName): TrackOption => ({
  value,
  feeds: ['fissures'],
  label,
  description,
  ...(emoji ? { emoji } : {}),
  spec: { kind: 'fissure', ...spec },
});

const CYCLE_HINT: Record<string, string> = {
  'cetus:night': 'Eidolon hunting time on the Plains',
  'vallis:warm': 'Six and a half minutes of warmth (Toroids, fishing)',
  'cambion:fass': 'Fass is up in the Cambion Drift',
  'cambion:vome': 'Vome is up in the Cambion Drift',
};

/** What the menus can set up in one tap; the value is the option id, the spec is what is stored. */
export const TRACK_OPTIONS: TrackOption[] = [
  { value: 'arby-s', feeds: ['arbitrations'], label: 'S-tier Arbitrations', description: 'The best hours: 10 minutes before one starts', emoji: 'arbitration', spec: { kind: 'arbitration', minTier: 'S' } },
  { value: 'arby-a', feeds: ['arbitrations'], label: 'A tier or better', description: 'S and A tier hours, 10 minutes ahead', emoji: 'arbitration', spec: { kind: 'arbitration', minTier: 'A' } },
  { value: 'arby-b', feeds: ['arbitrations'], label: 'B tier or better', description: 'S, A and B tier hours, 10 minutes ahead', emoji: 'arbitration', spec: { kind: 'arbitration', minTier: 'B' } },
  { value: 'arbitration', feeds: ['arbitrations'], label: 'Every Arbitration', description: 'Every hour, 10 minutes before it starts', spec: { kind: 'arbitration' } },
  ...['Survival', 'Defense', 'Interception', 'Excavation', 'Disruption', 'Mirror Defense', 'Defection', 'Infested Salvage'].map(arbitrationType),

  {
    value: 'crack',
    feeds: ['fissures'],
    label: 'Crack now: my own relics',
    description: 'A quick fissure for relics of yours worth opening (needs /alecaframe link)',
    emoji: 'bolt',
    spec: { kind: 'crack', minPlat: DEFAULT_CRACK_PLAT, quietHours: DEFAULT_CRACK_QUIET_HOURS },
  },
  fissure('steel-path-fissure', 'Any Steel Path fissure', 'Every new hard-mode fissure', { steelPath: true }, 'steelPath'),
  ...(['Lith', 'Meso', 'Neo', 'Axi'] as const).map((tier) =>
    fissure(`fissure-sp-${tier.toLowerCase()}`, `Steel Path ${tier}`, `New ${tier} fissures on the Steel Path`, { tier, steelPath: true }, tier.toLowerCase() as EmojiName),
  ),
  fissure('void-storm', 'Void Storms', 'Railjack fissures', { storm: true }, 'storm'),
  fissure('fissure-omnia', 'Omnia fissures', 'Any relic can be cracked there', { tier: 'Omnia' }, 'omnia'),
  fissure('fissure-requiem', 'Requiem fissures', 'For Requiem relics (Kuva Lich murmurs)', { tier: 'Requiem' }, 'requiem'),
  fissure('fissure-capture', 'Capture fissures', 'The quickest way to crack a relic', { mission: 'Capture' }),
  fissure('fissure-extermination', 'Extermination fissures', 'Quick runs', { mission: 'Extermination' }),
  fissure('fissure-survival', 'Survival fissures', 'Good for cracking several relics', { mission: 'Survival' }),
  fissure('fissure-disruption', 'Disruption fissures', 'Several relics a run', { mission: 'Disruption' }),

  { value: 'sortie', feeds: ['sortie'], label: 'Daily sortie', description: 'A DM when the new sortie starts', emoji: 'sortie', spec: { kind: 'sortie' } },
  { value: 'archon', feeds: ['sortie'], label: 'Archon Hunt', description: 'A DM when the weekly hunt resets', emoji: 'archon', spec: { kind: 'archon' } },
  { value: 'weekly', feeds: ['sortie'], label: 'Weekly reset summary', description: 'Circuit, Nightwave, Archon Hunt and Steel Path every Monday', emoji: 'weekly', spec: { kind: 'weekly' } },
  ...['Spy', 'Survival', 'Defense', 'Assassination'].map(
    (mission): TrackOption => ({ value: `sortie-${mission.toLowerCase()}`, feeds: ['sortie'], label: `Sorties with ${mission}`, description: `Only when a sortie mission is ${mission}`, spec: { kind: 'sortie', mission } }),
  ),

  ...CYCLE_CHOICES.map(
    (c): TrackOption => ({
      value: `cycle-${c.cycle}-${c.state}`,
      feeds: ['cycles'],
      label: c.label,
      description: CYCLE_HINT[`${c.cycle}:${c.state}`] ?? `When it turns ${c.state}`,
      spec: { kind: 'cycle', cycle: c.cycle, state: c.state },
    }),
  ),

  { value: 'baro', feeds: ['traders'], label: "Baro Ki'Teer", description: 'A DM when Baro arrives at a relay', emoji: 'baro', spec: { kind: 'baro' } },
  { value: 'umbra-forma', feeds: ['traders', 'alerts'], label: 'Umbra Forma', description: "In Teshin's honors, alerts, invasions and events", emoji: 'forma', spec: { kind: 'reward', keyword: 'Umbra Forma' } },

  {
    value: 'notable',
    feeds: REWARD_FEEDS,
    label: 'Anything worth running',
    description: 'Alerts and invasions that pay Forma, Catalysts, Nitain, rare parts…',
    emoji: 'star',
    spec: { kind: 'notable' },
  },
  reward('forma', 'Forma', 'Forma', 'forma'),
  reward('catalyst', 'Orokin Catalyst / Reactor', 'Orokin', 'catalyst'),
  reward('exilus', 'Exilus Adapter', 'Exilus', 'exilus'),
  reward('nitain', 'Nitain Extract', 'Nitain', 'nitain'),
  reward('riven', 'Riven mods', 'Riven', 'legendary'),
  reward('wraith', 'Wraith weapon parts', 'Wraith'),
  reward('vandal', 'Vandal weapon parts', 'Vandal'),
  reward('aura', 'Aura mods', 'Aura'),
];

export const trackOption = (value: string): TrackOption | undefined => TRACK_OPTIONS.find((o) => o.value === value);

const row = (...components: MessageActionRowComponentBuilder[]): Row => new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);

/** The "DM me when…" menu of a board. */
export function notifyRow(feed: FeedId, placeholder = '🔔 DM me when…'): Row {
  const options = TRACK_OPTIONS.filter((o) => o.feeds.includes(feed)).slice(0, 25);
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(`feeds:track:${feed}`)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options.map((o) => ({ label: o.label, value: o.value, description: o.description.slice(0, 100), ...(o.emoji ? { emoji: emojiFor(o.emoji) } : {}) }))),
  );
}

export const mineButton = (): ButtonBuilder => new ButtonBuilder().setCustomId('feeds:mine').setLabel('My notifications').setEmoji('📋').setStyle(ButtonStyle.Secondary);

/**
 * The notifications that are a plain on/off, with nothing to choose: one tap on `notify:<key>` switches the member's DM on or off
 * (discord/subscriptions.ts). The weekly one sits under the weekly post and on the sortie board; all three are on the roles panel.
 */
export const TOGGLES = {
  weekly: {
    spec: { kind: 'weekly' },
    label: 'Weeklies by DM',
    emoji: 'weekly',
    on: 'Done: every Monday Ordis DMs you what the reset brought. Tap the button again to stop.',
    off: 'No more weekly DMs.',
  },
  clanEvent: {
    spec: { kind: 'clanEvent' },
    label: 'Clan events by DM',
    emoji: '📅',
    on: 'Done: Ordis DMs you when a clan event is posted. Tap the button again to stop.',
    off: 'No more DMs about new clan events.',
  },
  squad: {
    spec: { kind: 'squad' },
    label: 'Squads by DM',
    emoji: '🔍',
    on: 'Done: Ordis DMs you when someone looks for a squad with /lfg. Tap the button again to stop.',
    off: 'No more DMs about squads.',
  },
} as const satisfies Record<string, { spec: TrackerSpec; label: string; emoji: string; on: string; off: string }>;

export type ToggleKey = keyof typeof TOGGLES;
export const isToggle = (key: string): key is ToggleKey => Object.hasOwn(TOGGLES, key);

export function notifyButton(key: ToggleKey): ButtonBuilder {
  const t = TOGGLES[key];
  return new ButtonBuilder()
    .setCustomId(`notify:${key}`)
    .setLabel(t.label)
    .setEmoji(key === 'weekly' ? emojiFor('weekly') : { name: t.emoji })
    .setStyle(ButtonStyle.Secondary);
}

/** A row of buttons, or null when none is given. */
export function buttonRow(...buttons: (ButtonBuilder | null | undefined | false)[]): Row | null {
  const list = buttons.filter((b): b is ButtonBuilder => Boolean(b));
  return list.length ? row(...list.slice(0, 5)) : null;
}

/** Specs compared by meaning, not by key order (the /track command and the menus build them differently). */
export function sameSpec(a: string | TrackerSpec, b: string | TrackerSpec): boolean {
  const norm = (s: string | TrackerSpec) => {
    try {
      const v = (typeof s === 'string' ? JSON.parse(s) : s) as Record<string, unknown>;
      return JSON.stringify(Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => [k, v[k]]));
    } catch {
      return String(s);
    }
  };
  return norm(a) === norm(b);
}
