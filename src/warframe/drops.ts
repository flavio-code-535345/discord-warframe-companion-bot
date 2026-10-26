import { apiJson } from './fetch.js';

// Drop tables served by the community warframestat.us API.
const BASE = 'https://api.warframestat.us';

export interface DropLocation {
  place: string;
  item: string;
  rarity: string;
  chance: number;
}

export interface DropGroup {
  item: string;
  locations: DropLocation[];
}

/** Searches drop tables and groups the results per item, best chance first. */
export async function searchDrops(query: string, perItem = 8, maxItems = 5): Promise<DropGroup[]> {
  // Drop tables change with game updates, not by the minute: cached for the stable lifetime, shared by every asker.
  const { data } = await apiJson<DropLocation[]>(`${BASE}/drops/search/${encodeURIComponent(query.trim())}`, { kind: 'stable' });
  return groupDrops(data ?? [], query, perItem, maxItems);
}

export function groupDrops(rows: DropLocation[], query: string, perItem: number, maxItems: number): DropGroup[] {
  const groups = new Map<string, DropLocation[]>();
  for (const row of rows) {
    const list = groups.get(row.item) ?? [];
    list.push(row);
    groups.set(row.item, list);
  }
  const q = query.trim().toLowerCase();
  return [...groups.entries()]
    // Exact name matches first, then shorter (more specific) names.
    .sort(([a], [b]) => Number(b.toLowerCase() === q) - Number(a.toLowerCase() === q) || a.length - b.length)
    .slice(0, maxItems)
    .map(([item, locations]) => ({
      item,
      locations: locations.sort((a, b) => b.chance - a.chance).slice(0, perItem),
    }));
}
