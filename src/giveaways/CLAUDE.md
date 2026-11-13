# Giveaways

Notes for this folder. The rules that apply everywhere, the commands and the list of the other notes are in the root `CLAUDE.md`.

**Giveaways** (`src/giveaways/service.ts`, `/giveaway start|end|reroll|list`; tables `giveaways`, `giveaway_entries`): an Enter button (`giveaway:<id>:enter`, toggles; the host can't enter), 1 min to 30 days, 1-10 winners, 2 running per host; the notifier ends due ones (`endDueGiveaways`) with `drawWinners` (crypto.randomInt shuffle), edits the post and pings the winners; end/reroll are for the host or Manage Messages.
