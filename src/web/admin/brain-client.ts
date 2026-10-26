/**
 * The one script on the admin panel: the Brain page's live chat. It reads the agent's event stream (one JSON object per line,
 * see AgentEvent in agent/run.ts) and draws it with textContent only, never innerHTML, so nothing the model or a tool
 * returns can inject markup. Allowed by the page's CSP nonce; every other page stays script-free.
 */
export const BRAIN_CHAT_JS = String.raw`(() => {
  const form = document.getElementById('chatform');
  const log = document.getElementById('chatlog');
  const q = form.elements.question;
  const send = document.getElementById('chatsend');
  const stop = document.getElementById('chatstop');
  const num = document.getElementById('tpsnum');
  const meter = document.getElementById('tpsmeter');
  const stat = document.getElementById('tpsstat');
  const history = [];
  let ctl = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const secs = (ms) => (ms / 1000).toFixed(1) + ' s';
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  };

  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  stop.addEventListener('click', () => ctl && ctl.abort());

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = q.value.trim();
    if (!text || ctl) return;
    q.value = '';
    log.append(el('div', 'msg user', text));
    const msg = el('div', 'msg bot');
    const think = el('details', 'think');
    const sum = el('summary', '', 'Thinking…');
    const steps = el('div');
    think.append(sum, steps);
    think.open = true;
    const ans = el('div', 'answer');
    msg.append(think, ans);
    log.append(msg);
    const follow = () => msg.scrollIntoView({ block: 'end', behavior: 'smooth' });

    ctl = new AbortController();
    send.hidden = true;
    stop.hidden = false;
    num.textContent = '0.0';
    meter.value = 0;
    stat.textContent = 'waiting for the model…';
    let cur = null;
    let reason = null;
    let tool = null;
    let finished = false;

    const handle = (e) => {
      switch (e.t) {
        case 'step':
          cur = el('div', 'step');
          cur.append(el('div', 'muted', 'Step ' + e.n + ' · ' + e.endpoint + ' · ' + e.model + ' · ' + (e.mode === 'text' ? 'tool calls as text' : 'native tool calls')));
          steps.append(cur);
          reason = null;
          ans.textContent = '';
          break;
        case 'reasoning':
          if (!reason) {
            reason = el('pre', 'reason');
            cur.append(reason);
          }
          reason.textContent += e.d;
          break;
        case 'content':
          ans.textContent += e.d;
          break;
        case 'stats':
          num.textContent = e.tps.toFixed(1);
          meter.value = e.tps;
          stat.textContent = e.tokens + ' tokens · first token after ' + secs(e.ttft) + ' · step ' + e.n;
          break;
        case 'tool':
          if (ans.textContent.trim()) cur.append(el('div', 'muted', 'said: ' + ans.textContent.trim().slice(0, 300)));
          ans.textContent = '';
          tool = el('details');
          tool.append(el('summary', '', '🔧 ' + e.name + ' ' + brief(e.args) + ' …'));
          cur.append(tool);
          break;
        case 'toolresult':
          if (tool) {
            tool.firstChild.textContent = (e.error ? '⚠️ ' : '🔧 ') + e.name + ' · ' + secs(e.ms);
            tool.append(el('pre', '', e.result));
          }
          break;
        case 'stepend':
          if (cur) cur.firstChild.textContent += ' · ' + e.tokens + ' tokens · ' + e.tps.toFixed(1) + ' tok/s · first token ' + secs(e.ttft) + ' · ' + secs(e.ms);
          break;
        case 'reset':
          if (cur) cur.append(el('div', 'muted', '↻ ' + e.why));
          ans.textContent = '';
          break;
        case 'done':
          finished = true;
          ans.textContent = e.text;
          sum.textContent = 'Thought for ' + secs(e.ms) + ' · ' + e.tokens + ' tokens · ' + e.tps.toFixed(1) + ' tok/s average · ' + e.via + ' · ' + e.model;
          think.open = false;
          num.textContent = e.tps.toFixed(1);
          meter.value = e.tps;
          history.push({ role: 'user', content: text }, { role: 'assistant', content: e.text });
          break;
        case 'error':
          finished = true;
          ans.textContent = '⚠️ ' + e.message;
          ans.className = 'answer error';
          sum.textContent = 'Failed';
          break;
      }
      follow();
    };

    try {
      const body = new URLSearchParams(new FormData(form));
      body.set('question', text);
      body.set('history', JSON.stringify(history.slice(-8)));
      const res = await fetch(form.action, { method: 'POST', body, signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(res.status === 409 ? 'A run is already in progress.' : 'The server answered ' + res.status + '. Reload the page and try again.');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line));
        }
      }
    } catch (err) {
      if (!finished) handle({ t: 'error', message: err && err.name === 'AbortError' ? 'Stopped.' : String(err && err.message ? err.message : err) });
    } finally {
      if (!finished) handle({ t: 'error', message: 'The connection ended before the answer.' });
      ctl = null;
      send.hidden = false;
      stop.hidden = true;
      stat.textContent = stat.textContent + ' · done';
      q.focus();
    }
  });
})();
`;
