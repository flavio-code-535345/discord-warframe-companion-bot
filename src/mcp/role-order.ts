export interface RolePos {
  id: string;
  position: number;
}

/**
 * Moves one role to a final position among the roles the bot may reorder (those below its own top role, bottom = 1),
 * and returns only the roles whose position changes. Discord's own handling of a single moved role depends on stale
 * numbers and collisions, so the whole ordered list is renumbered 1..n instead and sent in one request.
 */
export function planRoleMove(movable: RolePos[], roleId: string, position: number): RolePos[] {
  const ordered = [...movable].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const moving = ordered.find((r) => r.id === roleId);
  if (!moving) return [];
  const rest = ordered.filter((r) => r.id !== roleId);
  rest.splice(Math.max(0, Math.min(rest.length, position - 1)), 0, moving);
  return rest.map((r, i) => ({ id: r.id, position: i + 1 })).filter((r, i) => ordered.find((o) => o.id === r.id)!.position !== i + 1);
}
