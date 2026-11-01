import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inactivityReport } from '../activity/service.js';
import type { AppContext } from '../context.js';
import { LABS, addResearch, finishResearch, listResearch, postResearchBoard, removeResearch, updateResearch } from '../research/service.js';
import { addSelfRole, postRolesPanel, removeSelfRole } from '../selfroles/service.js';
import { UserError } from '../services/clan.js';
import { READ_ONLY, snowflake, tool } from './util.js';

/** The self-assign role menu, the dojo research board and the inactivity report, the same operations as /roles, /research and /inactive. */
export function registerCommunityTools(server: McpServer, ctx: AppContext): void {
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  server.registerTool(
    'set_self_role',
    {
      title: 'Edit the self-assign role menu',
      description:
        'Adds a role to the self-assign menu (or changes its entry), or removes it with remove=true. Only plain roles: no permissions, not a staff, clan rank, mastery or level role. The posted menu is updated in place. List it with list_self_roles.',
      inputSchema: {
        role_id: snowflake,
        group: z.string().min(1).max(40).optional().describe('Heading it is listed under, e.g. "Platform" or "Pings"; required when adding'),
        label: z.string().max(80).optional(),
        emoji: z.string().max(60).optional(),
        description: z.string().max(100).optional(),
        remove: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ role_id, group, label, emoji, description, remove }) => {
      if (remove) return { removed: await removeSelfRole(ctx, role_id) };
      if (!group) throw new UserError('group is required when adding a role.');
      return addSelfRole(ctx, { roleId: role_id, group, label, emoji, description });
    }),
  );

  server.registerTool(
    'list_self_roles',
    { title: 'List the self-assign role menu', description: 'The roles in the self-assign menu, in order.', inputSchema: {}, annotations: READ_ONLY },
    tool(async () => ctx.store.listSelfRoles(ctx.config.DISCORD_GUILD_ID)),
  );

  server.registerTool(
    'post_roles_panel',
    {
      title: 'Post the role menu',
      description: 'Posts the self-assign role menu (a button per role) in a channel; a menu posted before is deleted, so there is only ever one.',
      inputSchema: { channel_id: snowflake },
      annotations: WRITE,
    },
    tool(async ({ channel_id }) => ({ url: await postRolesPanel(ctx, channel_id) })),
  );

  server.registerTool(
    'manage_research',
    {
      title: 'Edit the dojo research board',
      description:
        'The dojo research board: add (name, lab, needs), update (id, needs), done (id), remove (id), board (channel_id: post the live board there) or list. The posted board updates itself.',
      inputSchema: {
        action: z.enum(['add', 'update', 'done', 'remove', 'board', 'list']),
        id: z.number().int().min(1).optional(),
        name: z.string().max(100).optional(),
        lab: z.enum(LABS).optional(),
        needs: z.string().max(300).optional(),
        channel_id: snowflake.optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ action, id, name, lab, needs, channel_id }) => {
      const need = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new UserError(`${what} is required for ${action}.`);
        return v;
      };
      if (action === 'list') return listResearch(ctx);
      if (action === 'add') return addResearch(ctx, { name: need(name, 'name'), lab, needs, addedBy: ctx.client.user?.id ?? 'mcp' });
      if (action === 'update') return updateResearch(ctx, need(id, 'id'), needs ?? null);
      if (action === 'done') return finishResearch(ctx, need(id, 'id'));
      if (action === 'remove') {
        await removeResearch(ctx, need(id, 'id'));
        return { removed: id };
      }
      return { url: await postResearchBoard(ctx, need(channel_id, 'channel_id')) };
    }),
  );

  server.registerTool(
    'list_inactive_members',
    {
      title: 'Inactive members',
      description: 'Members who have not written a message or been in voice for at least `days` (default 30), longest silent first. Only those two times are recorded, since activity tracking began.',
      inputSchema: { days: z.number().int().min(1).max(365).optional() },
      annotations: READ_ONLY,
    },
    tool(async ({ days }) => {
      const r = await inactivityReport(ctx, days ?? 30);
      return {
        trackingSince: new Date(r.trackingSince).toISOString(),
        checked: r.checked,
        inactive: r.members.map((m) => ({ ...m, lastSeen: m.lastSeen ? new Date(m.lastSeen).toISOString() : null, joinedAt: m.joinedAt ? new Date(m.joinedAt).toISOString() : null })),
      };
    }),
  );
}
