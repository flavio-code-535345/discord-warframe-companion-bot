/**
 * The script of the Screenshots test page. It posts the chosen image as the raw request body (with the CSRF token in a header)
 * to /admin/sstest/run once per method, reads the streamed lines until the result, and draws it with textContent only, never
 * innerHTML, so nothing a model or the OCR returns can inject markup. Allowed by the page's CSP nonce.
 */
export const SSTEST_JS = String.raw`(() => {
  const file = document.getElementById('ssfile');
  const form = document.getElementById('ssform');
  const csrf = document.getElementById('sscsrf').value;
  const stopFirst = document.getElementById('ssstop');
  const allBtn = document.getElementById('ssall');
  const METHODS = ['ocr', 'local', 'cloud'];
  let busy = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const out = (m) => document.querySelector('#m-' + m + ' .out');
  const secs = (ms) => (ms / 1000).toFixed(1) + ' s';
  const ICON = { read: '✅ read', incomplete: '➡️ could not read it completely', skipped: '⏭️ not available', failed: '⚠️ no usable answer' };

  function draw(box, r) {
    box.replaceChildren();
    box.className = 'out stack';
    box.append(el('div', '', ICON[r.status] + (r.ms ? ' · ' + secs(r.ms) : '') + (r.model ? ' · ' + r.model : '') + (r.size ? ' · ' + r.size : '')));
    if (r.note) box.append(el('div', 'muted', r.note));
    const x = r.reading;
    if (x) {
      const rows = [
        ['Profile card', x.is_profile_card ? 'yes' : 'no'],
        ['In-game name', x.in_game_name],
        ['Mastery rank', x.mastery_rank_title],
        ['Mastery points', x.mastery_points],
        ['Next rank', x.next_rank ? x.next_rank + (x.points_to_next_rank ? ' in ' + x.points_to_next_rank : '') : null],
        ['Clan', x.clan_name ? x.clan_name + (x.clan_tag ? '#' + x.clan_tag : '') + (x.clan_tier_rank ? ' · ' + x.clan_tier_rank : '') : null],
        ['Accolades', x.accolades && x.accolades.length ? x.accolades.join(', ') : null],
        ['Looks edited', x.looks_edited_or_fake ? 'yes' : 'no'],
        ['Clan text matches reference', x.clan_text_matches_reference === null ? null : x.clan_text_matches_reference ? 'yes' : 'no'],
        ['Emblem matches reference', x.emblem_matches_reference === null ? null : x.emblem_matches_reference ? 'yes' : 'no'],
      ];
      if (r.emblemSimilarity !== null) rows.push(['Emblem similarity', r.emblemSimilarity.toFixed(2)]);
      for (const [k, v] of rows) box.append(el('div', '', k + ': ' + (v === null || v === undefined || v === '' ? '—' : v)));
      if (x.notes) box.append(el('div', 'muted', 'Model note: ' + x.notes));
    }
    if (r.rankRows && r.rankRows.length) box.append(el('div', '', 'Clan member list rows: ' + r.rankRows.map((w) => (w.name || '?') + ' = ' + w.rank).join('; ')));
    if (r.verdict) {
      const v = r.verdict;
      box.append(el('div', '', (v.ok ? '✅ The bot would verify this card' : '🚫 The bot would reject this card') + (v.mr !== null ? ' · MR ' + v.mr : '')));
      for (const p of v.problems) box.append(el('div', 'muted', '• ' + p));
      if (v.ok && v.roles.length) box.append(el('div', 'muted', 'Role names it looks for (normalized): ' + v.roles.join(', ')));
    }
    if (r.lines && r.lines.length) {
      const d = el('details');
      d.append(el('summary', '', 'Recognised text (' + r.lines.length + ' lines)'), el('pre', '', r.lines.join('\n')));
      box.append(d);
    }
    if (x) {
      const d = el('details');
      d.append(el('summary', '', 'Raw reading'), el('pre', '', JSON.stringify(x, null, 1)));
      box.append(d);
    }
  }

  async function run(method, f) {
    const box = out(method);
    const t0 = Date.now();
    box.className = 'out muted';
    box.textContent = '⏳ Running…';
    const tick = setInterval(() => (box.textContent = '⏳ Running… ' + secs(Date.now() - t0)), 500);
    let result = null;
    try {
      const res = await fetch('/admin/sstest/run?method=' + method, { method: 'POST', headers: { 'Content-Type': f.type, 'X-CSRF-Token': csrf }, body: f });
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const o = JSON.parse(line);
          if (o.t === 'result') result = o;
          else if (o.t === 'error') throw new Error(o.error);
        }
      }
      if (!result) throw new Error('No result came back.');
    } catch (err) {
      clearInterval(tick);
      box.className = 'out muted';
      box.textContent = '⚠️ ' + (err && err.message ? err.message : err);
      return null;
    }
    clearInterval(tick);
    draw(box, result);
    return result;
  }

  function chosen() {
    const f = file.files && file.files[0];
    if (!f) { alert('Choose a screenshot first.'); return null; }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { alert('The screenshot must be a PNG, JPG or WebP.'); return null; }
    if (f.size > 8 * 1024 * 1024) { alert('That file is over 8 MB.'); return null; }
    return f;
  }

  async function guarded(fn) {
    if (busy) return;
    const f = chosen();
    if (!f) return;
    busy = true;
    allBtn.disabled = true;
    document.querySelectorAll('[data-run]').forEach((b) => (b.disabled = true));
    try { await fn(f); } finally {
      busy = false;
      allBtn.disabled = false;
      document.querySelectorAll('[data-run]').forEach((b) => (b.disabled = false));
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(async (f) => {
      METHODS.forEach((m) => { out(m).className = 'out muted'; out(m).textContent = 'Waiting…'; });
      for (const m of METHODS) {
        const r = await run(m, f);
        if (stopFirst.checked && r && r.status === 'read') {
          METHODS.slice(METHODS.indexOf(m) + 1).forEach((n) => { out(n).className = 'out muted'; out(n).textContent = 'Not needed: an earlier method already read it.'; });
          break;
        }
      }
    });
  });
  document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => guarded((f) => run(b.dataset.run, f))));
})();`;
