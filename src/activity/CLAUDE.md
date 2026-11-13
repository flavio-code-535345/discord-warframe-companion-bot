# Inactivity report

Notes for this folder. The rules that apply everywhere, the commands and the list of the other notes are in the root `CLAUDE.md`.

**Inactivity report** (`src/activity/service.ts`, `/inactive [days]` (Kick Members), MCP `list_inactive_members`; table `member_activity`): only the last message time (written at most every 5 min per member) and last voice time (join/leave/move) are stored. `findInactive` is pure; a member with no record counts only when they joined, and tracking (bot_meta `activity_since`, set by the migration) began, before the cut-off.
