import type { Request, RequestHandler, Response, Router } from 'express';
import { sourceLabel } from '../../answers/log.js';
import { addCorrection, approveCorrection, editCorrection, rejectCorrection } from '../../answers/corrections.js';
import type { AppContext } from '../../context.js';
import type { AiLogEntry, Correction, PanelSession } from '../../db.js';
import { UserError } from '../../services/clan.js';
import { escapeHtml as e } from '../status.js';
import { type PageContext, badge, csrfField, head, layout, statCard } from './pages.js';

/**
 * The panel's Corrections page. Staff teach Ordis here (and by replying to him in Discord, see answers/corrections.ts):
 * approve or reject what members suggested, edit or remove corrections, add one by hand, and mark logged answers right or
 * wrong so the model gets that as feedback. Server-rendered forms, no script.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  action: (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) => RequestHandler;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
}

const when = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const positive = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const sourceName: Record<Correction['source'], string> = { staff_reply: 'staff reply in Discord', member_reply: 'member reply in Discord', panel: 'panel' };

export function registerCorrectionsRoutes({ router, ctx, pc, html, action, audit }: Deps): void {
  const { store, config } = ctx;
  const guildId = config.DISCORD_GUILD_ID;

  const form = (p: PageContext, path: string, fields: string, button: string, opts: { danger?: boolean; ghost?: boolean } = {}) =>
    `<form class="stack" method="post" action="${e(path)}">${csrfField(p.session)}${fields}<div><button${opts.danger ? ' class="danger"' : opts.ghost ? ' class="ghost"' : ''}>${e(button)}</button></div></form>`;

  const pendingCard = (p: PageContext, c: Correction) => `<div class="card stack">
<div class="muted">${e(when(c.createdAt))} UTC · suggested by <strong>${e(c.authorName)}</strong> · ${e(sourceName[c.source])}</div>
<p class="flush"><strong>Question:</strong> ${e(clip(c.question, 400))}</p>
${c.badAnswer ? `<p class="flush muted"><strong>Ordis answered:</strong> ${e(clip(c.badAnswer, 500))}</p>` : ''}
<form class="stack" method="post" action="/admin/corrections/${c.id}/approve">${csrfField(p.session)}
<label>Suggested answer (edit it before approving if needed)<textarea name="text" rows="4" maxlength="1500" required>${e(c.correction)}</textarea></label>
<div class="row"><button>Approve</button></div></form>
${form(p, `/admin/corrections/${c.id}/reject`, '', 'Reject', { ghost: true })}
</div>`;

  const approvedRow = (p: PageContext, c: Correction) => `<div class="card stack">
<div class="muted">${e(when(c.createdAt))} UTC · by ${e(c.authorName)} · ${e(sourceName[c.source])}</div>
<p class="flush"><strong>${e(clip(c.question, 300))}</strong></p>
<form class="stack" method="post" action="/admin/corrections/${c.id}/save">${csrfField(p.session)}
<label>Answer Ordis gives<textarea name="text" rows="3" maxlength="1500" required>${e(c.correction)}</textarea></label>
<div class="row"><button class="ghost">Save</button></div></form>
<form class="inline" method="post" action="/admin/corrections/${c.id}/delete">${csrfField(p.session)}<label class="check"><input type="checkbox" name="confirm" value="yes" required> sure</label><button class="danger">Delete</button></form>
</div>`;

  const rateRow = (p: PageContext, l: AiLogEntry) => {
    const rate = (value: 'right' | 'wrong') =>
      `<form class="inline" method="post" action="/admin/corrections/rate">${csrfField(p.session)}<input type="hidden" name="id" value="${l.id}"><input type="hidden" name="rating" value="${l.rating === value ? 'clear' : value}"><button class="${l.rating === value ? '' : 'ghost'}">${value === 'right' ? '✅ Right' : '❌ Wrong'}</button></form>`;
    return `<div class="card stack">
<div class="muted">${e(when(l.at))} UTC · ${e(l.userName)} · ${e(sourceLabel(l))}${l.rating ? ` · ${badge(l.rating === 'right' ? 'marked right' : 'marked wrong', l.rating === 'right' ? 'ok' : 'bad')}` : ''}</div>
<p class="flush"><strong>${e(clip(l.question, 300))}</strong></p>
<p class="flush muted">${e(clip(l.answer ?? '(no text kept)', 500))}</p>
<div class="row">${rate('right')}${rate('wrong')}</div>
<details><summary class="muted">Write the right answer</summary>
<form class="stack" method="post" action="/admin/corrections/from-answer">${csrfField(p.session)}<input type="hidden" name="id" value="${l.id}">
<label>The answer Ordis should give to this question<textarea name="text" rows="4" maxlength="1500" required></textarea></label>
<div><button>Save correction</button></div></form></details>
</div>`;
  };

  router.get('/corrections', (req, res) => {
    const p = pc(res, 'corrections', req);
    const counts = store.countCorrections(guildId);
    const ratings = store.ratingCounts(guildId);
    const pending = store.listCorrections(guildId, 'pending', 100);
    const approved = store.listCorrections(guildId, 'approved', 100);
    // Answers staff can still judge: the newest logged ones that were not themselves a staff correction.
    const recent = store.recentAiLog(guildId, 60).filter((l) => l.found && l.answer && l.source !== 'correction' && l.intent !== 'busy').slice(0, 25);

    const body = `${head('Corrections', 'Teach Ordis: approve what members suggest, fix answers, and tell him which answers were right or wrong.')}
<div class="grid">
${statCard('Waiting for approval', String(counts.pending), counts.pending ? 'suggestions from members' : 'nothing to review', { tone: counts.pending ? undefined : 'ok' })}
${statCard('Corrections in force', String(counts.approved), 'served word for word and given to the model')}
${statCard('Answers rated', `${ratings.right} ✅ · ${ratings.wrong} ❌`, 'feedback for the model', { small: true })}
</div>
<div class="card"><p class="muted flush"><strong>In Discord:</strong> reply to one of Ordis's answers with the right answer, no question mark at the end. Staff (operators, panel admins, Manage Server) are saved at once and get a ✅; everyone else's reply becomes a suggestion (📝) that you approve below. A reply that ends in <code>?</code> is a follow-up question instead.</p></div>

<h2>Suggestions to approve</h2>
${pending.length ? pending.map((c) => pendingCard(p, c)).join('') : '<p class="muted">No suggestions waiting.</p>'}

<h2>Corrections in force</h2>
${approved.length ? approved.map((c) => approvedRow(p, c)).join('') : '<p class="muted">No corrections yet.</p>'}

<h2>Add a correction</h2>
<div class="card">${form(
      p,
      '/admin/corrections/add',
      `<label>The question<input name="question" maxlength="300" required placeholder="How do I get Condition Overload?"></label><label>The answer Ordis should give<textarea name="text" rows="4" maxlength="1500" required></textarea></label>`,
      'Add correction',
    )}<p class="muted flush">Asked again word for word (ignoring capitals and punctuation), Ordis gives exactly this answer. Related questions get it as guidance.</p></div>

<h2>Rate recent answers</h2>
<p class="muted">Right and wrong marks are shown to the model as examples for related questions. Marking an answer wrong and writing the right one below it creates a correction.</p>
${recent.length ? recent.map((l) => rateRow(p, l)).join('') : '<p class="muted">No answers logged yet.</p>'}`;
    html(res, layout('Corrections', body, p));
  });

  router.post(
    '/corrections/add',
    action('corrections', async (req, session) => {
      const question = text(req.body.question, 300);
      const answer = text(req.body.text, 1500);
      const r = addCorrection(ctx, { entry: null, question, text: answer, authorId: session.userId, authorName: session.username, staff: true, source: 'panel' });
      if (!r) throw new UserError('Both the question and the answer are needed.');
      await audit(session, 'Added a correction', [{ name: 'Question', value: clip(question, 200) }]);
      return r.duplicate ? 'That correction already exists.' : 'Correction saved. Ordis answers that question this way now.';
    }),
  );

  router.post(
    '/corrections/from-answer',
    action('corrections', async (req, session) => {
      const entry = store.getAiLog(guildId, positive(req.body.id));
      if (!entry) throw new UserError('That answer is no longer in the log.');
      const r = addCorrection(ctx, { entry, text: text(req.body.text, 1500), authorId: session.userId, authorName: session.username, staff: true, source: 'panel' });
      if (!r) throw new UserError('Write the right answer first.');
      await audit(session, 'Corrected an answer', [{ name: 'Question', value: clip(entry.question, 200) }]);
      return 'Correction saved. The answer is marked wrong.';
    }),
  );

  router.post(
    '/corrections/rate',
    action('corrections', async (req, session) => {
      const id = positive(req.body.id);
      const rating = req.body.rating === 'right' || req.body.rating === 'wrong' ? req.body.rating : req.body.rating === 'clear' ? null : undefined;
      if (rating === undefined || !store.rateAiLog(guildId, id, rating, session.userId)) throw new UserError('That answer is no longer in the log.');
      return rating ? `Marked ${rating}.` : 'Mark removed.';
    }),
  );

  router.post(
    '/corrections/:id/approve',
    action('corrections', async (req, session) => {
      const id = positive(req.params.id);
      if (!approveCorrection(ctx, id, session.userId, text(req.body.text, 1500))) throw new UserError('That suggestion no longer exists.');
      await audit(session, 'Approved a correction', [{ name: 'Id', value: String(id) }]);
      return 'Approved. Ordis uses it from now on.';
    }),
  );

  router.post(
    '/corrections/:id/reject',
    action('corrections', async (req, session) => {
      const id = positive(req.params.id);
      if (!rejectCorrection(ctx, id, session.userId)) throw new UserError('That suggestion no longer exists.');
      return 'Rejected.';
    }),
  );

  router.post(
    '/corrections/:id/save',
    action('corrections', async (req) => {
      if (!editCorrection(ctx, positive(req.params.id), text(req.body.text, 1500))) throw new UserError('Could not save that: is the text empty?');
      return 'Saved.';
    }),
  );

  router.post(
    '/corrections/:id/delete',
    action('corrections', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to delete.');
      const id = positive(req.params.id);
      if (!store.deleteCorrection(guildId, id)) throw new UserError('That correction no longer exists.');
      await audit(session, 'Deleted a correction', [{ name: 'Id', value: String(id) }]);
      return 'Deleted.';
    }),
  );
}
