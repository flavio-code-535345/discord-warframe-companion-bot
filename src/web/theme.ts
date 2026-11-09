/**
 * One design system for every page the bot serves: the public status page and the admin panel. Dark with the clan logo's
 * crystal blue as the accent. Pages only choose a shell (`ADMIN_CSS` or `STATUS_CSS`); colours, type, spacing and the
 * form, table, badge and button styles live here so the two never drift apart again.
 *
 * Everything is plain CSS under a per-request nonce (the pages' CSP allows no inline style attributes and no data: images).
 */

const TOKENS = `
:root{
  color-scheme:dark;
  --bg:#07121d;--glow:rgba(74,168,216,.15);
  --surface:#0e1e2f;--surface-2:#132840;--input:#0a1826;
  --line:rgba(148,189,219,.14);--line-2:rgba(148,189,219,.27);
  --text:#e8f0f7;--muted:#8ea5b9;--faint:#60768a;
  --accent:#4aa8d8;--accent-2:#76c5ef;--accent-soft:rgba(74,168,216,.15);--on-accent:#04121e;
  --ok:#3ddc97;--ok-soft:rgba(61,220,151,.12);
  --warn:#f6bd4b;--warn-soft:rgba(246,189,75,.12);
  --bad:#f87171;--bad-soft:rgba(248,113,113,.12);
  --gold:#e8c66a;
  --r:12px;--r-sm:8px;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",monospace;
}`;

const BASE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:radial-gradient(900px 420px at 50% -140px,var(--glow),transparent 72%) no-repeat fixed,var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent-2);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{font-family:var(--mono);font-size:.88em;background:var(--accent-soft);padding:1px 6px;border-radius:5px}
h1{font-size:24px;line-height:1.25;letter-spacing:-.01em;margin:0 0 6px;font-weight:700}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:650;margin:34px 0 12px}
h3{font-size:15px;margin:0 0 8px}
p{margin:0 0 10px}
[hidden]{display:none!important}
.lede{color:var(--muted);margin:0 0 24px;max-width:70ch}
.muted{color:var(--muted);font-size:13px}
.flush{margin:0}
.inline{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.mt{margin-top:14px}
`;

const COMPONENTS = `
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px;margin-bottom:14px;min-width:0}
.card>:last-child{margin-bottom:0}
.card:has(>table){overflow-x:auto}
.stack{display:grid;gap:14px}
.stack>*{margin:0}
.stack>h2{margin-top:20px}
hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));margin-bottom:14px}
.grid .card{margin:0}
.statcard{display:grid;gap:3px;align-content:start}
.statlabel{font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.stat{font-size:26px;font-weight:700;line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.stat.small{font-size:15px;font-weight:600;line-height:1.4;letter-spacing:0}
.stat.ok{color:var(--ok)}
.stat.bad{color:var(--bad)}
.statnote{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.row{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

.flash{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border-radius:var(--r-sm);margin:0 0 20px;border:1px solid;font-size:14px}
.flash::before{font-weight:700}
.flash.ok{border-color:rgba(61,220,151,.4);background:var(--ok-soft);color:#c9f7e2}
.flash.ok::before{content:"✓"}
.flash.err{border-color:rgba(248,113,113,.42);background:var(--bad-soft);color:#fed7d7}
.flash.err::before{content:"!"}

label{display:grid;gap:6px;font-size:12.5px;font-weight:550;color:var(--muted)}
input,select,textarea{width:100%;background:var(--input);color:var(--text);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:9px 11px;font:inherit;font-size:14px;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input::placeholder,textarea::placeholder{color:var(--faint)}
input[type=file]{padding:7px 9px}
input[type=range]{padding:0;accent-color:var(--accent)}
textarea{min-height:130px;resize:vertical;line-height:1.5}
textarea.chatq{min-height:68px}
.check{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--muted)}
.check input{width:auto;accent-color:var(--accent)}

button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--accent);color:var(--on-accent);border:1px solid transparent;border-radius:var(--r-sm);padding:8px 16px;font:inherit;font-size:14px;font-weight:650;line-height:1.3;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s}
button:hover{background:var(--accent-2);text-decoration:none}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--text);border-color:var(--line-2)}
button.ghost:hover{background:var(--surface-2)}
button.danger{background:var(--bad-soft);color:#fecaca;border-color:rgba(248,113,113,.4)}
button.danger:hover{background:var(--bad);color:#2a0a0a}
.discord{display:inline-flex;background:#5865f2;color:#fff;padding:11px 22px;border-radius:10px;font-weight:650}
.discord:hover{background:#6975f5;text-decoration:none}

table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:650;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
tr:last-child>td{border-bottom:0}
tbody tr:hover>td{background:rgba(255,255,255,.02)}
.thumb{object-fit:cover;border-radius:6px}

.badge{display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line-2);color:var(--muted);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:rgba(61,220,151,.38);background:var(--ok-soft)}
.badge.warn{color:var(--warn);border-color:rgba(246,189,75,.38);background:var(--warn-soft)}
.badge.bad{color:var(--bad);border-color:rgba(248,113,113,.4);background:var(--bad-soft)}
.badge.info{color:var(--accent-2);border-color:rgba(74,168,216,.4);background:var(--accent-soft)}

pre{white-space:pre-wrap;word-break:break-word;background:var(--input);border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 12px;font:12px/1.5 var(--mono);margin:6px 0;max-height:360px;overflow:auto}
details{margin:4px 0}
summary{cursor:pointer;color:var(--muted)}
summary:hover{color:var(--text)}
`;

/** Phones and small tablets: touch-sized controls, 16px fields (iOS zooms into anything smaller), one-column layouts, notch-safe edges. */
const MOBILE = `
@media (max-width:860px){
  input,select,textarea{font-size:16px;padding:11px 12px}
  button,.button{min-height:44px;padding:10px 16px}
  .check{min-height:44px}
  .check input{width:20px;height:20px}
  .actions>button,.actions>.button,.inline button{flex:1 1 auto}
  .inline{width:100%}
  .row{grid-template-columns:minmax(0,1fr)}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .card{padding:14px}
  h1{font-size:21px}
  .stat{font-size:22px}
  pre{font-size:11.5px}
}
@media (max-width:420px){.grid{grid-template-columns:minmax(0,1fr)}}
`;

const ADMIN_SHELL = `
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;padding:22px 14px;border-right:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.02),transparent 40%)}
.brandbar{display:flex;align-items:center;gap:11px;padding:0 8px 18px;color:var(--text)}
.brandbar:hover{text-decoration:none}
.brandbar img{width:38px;height:38px;border-radius:10px;box-shadow:0 0 18px var(--glow)}
.brandbar b{display:block;font-size:15px;line-height:1.2}
.brandbar span{display:block;font-size:12px;color:var(--muted)}
.navgroup{margin:18px 0 5px;padding:0 10px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:650}
.navlink{display:block;padding:7px 10px;border-radius:var(--r-sm);color:var(--muted);font-weight:550;font-size:14px}
.navlink:hover{background:var(--surface);color:var(--text);text-decoration:none}
.navlink.on{background:var(--accent-soft);color:var(--accent-2)}
.content{min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:12px 32px;border-bottom:1px solid var(--line);min-height:57px}
.user{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px}
.user img{width:28px;height:28px;border-radius:50%}
.user button{padding:5px 12px;font-size:13px}
main{width:100%;max-width:1040px;margin:0 auto;padding:32px 32px 72px}
.solo{max-width:440px;margin:0 auto;padding:12vh 20px 40px;text-align:center}
.solo img{width:92px;height:92px;border-radius:22px;box-shadow:0 0 44px var(--glow);margin-bottom:8px}
.solo h1{margin-top:10px}
.solo .flash{text-align:left}
@media (max-width:860px){
  .shell{display:block}
  .side{position:static;height:auto;padding:12px;border-right:0;border-bottom:1px solid var(--line)}
  .brandbar{padding-bottom:8px}
  .side nav{display:flex;gap:4px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}
  .navgroup{display:none}
  .navlink{white-space:nowrap;padding:10px 14px;background:var(--surface);border:1px solid var(--line)}
  .navlink.on{border-color:var(--line-2)}
  .topbar{padding:10px 16px;justify-content:space-between;flex-wrap:wrap}
  main{padding:22px max(16px,env(safe-area-inset-right)) calc(56px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
  .msg.user{margin-left:0}
  table{font-size:13px}
  th,td{padding:8px 6px}
}`;

const STATUS_SHELL = `
body{font-size:14px;line-height:1.5}
main{max-width:1080px;margin:0 auto;padding:44px 24px 40px}
header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:34px}
.logo{width:52px;height:52px;border-radius:14px;box-shadow:0 0 30px var(--glow)}
header h1{margin:0;font-size:22px}
.sub{color:var(--muted);font-size:13px}
.live{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.off .dot{background:var(--bad);box-shadow:0 0 10px var(--bad)}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:38px}
.stat{display:flex;flex-direction:column;gap:4px;padding:18px 20px;border-radius:16px;border:1px solid var(--line);background:linear-gradient(160deg,var(--surface),rgba(74,168,216,.07))}
.sl{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
.sv{font-size:22px;line-height:1.2;font-weight:650;overflow-wrap:anywhere}
.ss{font-size:13px;color:var(--muted)}
.ss .cd{color:var(--accent-2)}
.group{border-top:1px solid var(--line);padding:2px 0}
.group>summary{display:flex;align-items:baseline;gap:12px;padding:16px 2px;cursor:pointer;list-style:none}
.group>summary::-webkit-details-marker{display:none}
.group>summary::after{content:"+";margin-left:auto;color:var(--faint);font-size:20px;line-height:1}
.group[open]>summary::after{content:"–"}
.group h3{margin:0;font-size:16px;font-weight:650;color:var(--text)}
.group>summary span{font-size:13px;color:var(--faint)}
.group>.grid{margin:0 0 22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px;align-items:start}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px 12px;min-width:0}
.tile.span2{grid-column:span 2}
@media (max-width:700px){.tile.span2{grid-column:auto}}
.ico{width:18px;height:18px;object-fit:contain;vertical-align:-4px;margin-right:7px}
.chip .ico,.fx .ico{width:15px;height:15px;vertical-align:-3px;margin-right:5px}
.v .ico{width:15px;height:15px;vertical-align:-3px;margin:0 0 0 2px}
.sl .ico{width:15px;height:15px;vertical-align:-3px;margin-right:6px}
.tier{display:inline-grid;place-items:center;flex:none;min-width:20px;height:20px;padding:0 5px;border-radius:6px;font:800 11px/1 var(--font);letter-spacing:0;color:#111827;background:#475569}
.tier-s{background:#f5c542}
.tier-a{background:#a855f7;color:#fff}
.tier-b{background:#3b82f6;color:#fff}
.tier-c{background:#22c55e}
.tier-d{background:#94a3b8}
.tier-f{background:#475569;color:#e2e8f0}
.sv .tier{min-width:26px;height:26px;font-size:14px;border-radius:7px;vertical-align:3px;margin-right:9px}
.hero{display:flex;gap:12px;align-items:center;margin:4px 0 10px}
.hero .tier{min-width:36px;height:36px;font-size:17px;border-radius:9px}
.hero .lead{margin:0;font-size:15px}
.sec{margin:10px 0 0;padding-top:10px;border-top:1px solid var(--line);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.12em;color:var(--faint)}
.sec+.r{border-top:0}
.r.arb{justify-content:flex-start;align-items:flex-start;gap:10px}
.r.arb .k{flex:1}
.r.arb .tier{margin-top:1px}
.src{margin:10px 0 2px;font-size:11.5px;color:var(--faint)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 10px}
.chip{font:inherit;font-size:12px;padding:3px 11px;border-radius:999px;border:1px solid var(--line-2);background:transparent;color:var(--muted);cursor:pointer}
.chip:hover{color:var(--text);background:transparent}
.chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--text)}
.scroll{max-height:340px;overflow:auto}
.tile .fx td{padding:6px 8px 6px 0;text-align:left;border-top:1px solid var(--line);vertical-align:top}
.tile .fx td.t{color:var(--muted);white-space:nowrap}
.tile .fx td.v{text-align:right;white-space:nowrap;padding-right:0}
tr[hidden]{display:none}
.tile h2{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 8px;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
.tile h2 .cd,.tile h2 .x{text-transform:none;letter-spacing:0;font-weight:500;font-size:12px}
.r{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
.r:first-of-type{border-top:0}
.k{min-width:0;overflow-wrap:anywhere}
.v{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.n{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.u{color:var(--muted);font-size:12px}
.lead{font-weight:600;margin:1px 0 6px}
.cd{color:var(--accent-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.star{color:var(--gold)}
.tag{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border:1px solid var(--line-2);border-radius:5px;padding:0 5px;margin-left:6px}
.tile table{font-variant-numeric:tabular-nums}
.tile th,.tile td{padding:3px 4px;text-align:right;border:0}
.tile th:first-child,.tile td:first-child{text-align:left}
.tile tbody tr:hover>td{background:none}
.empty{color:var(--muted);font-size:13px;margin:2px 0 4px}
s{color:var(--muted)}
footer{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;text-align:center}
footer p{margin:0 0 4px}
footer a{color:var(--accent-2)}
@media (max-width:560px){
  main{padding:22px max(14px,env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
  header{gap:12px;margin-bottom:22px}
  .logo{width:42px;height:42px}
  header h1{font-size:19px}
  header>div{flex:1;min-width:0}
  .live{margin-left:0}
  .strip{grid-template-columns:1fr;gap:10px;margin-bottom:24px}
  .stat{padding:14px 16px}
  .grid{grid-template-columns:1fr;gap:10px}
  .tile{padding:14px 14px 10px}
  .group>summary span{display:none}
  .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:none;padding:5px 12px}
  .scroll{max-height:300px}
  .v{white-space:normal}
  .r{align-items:flex-start}
}`;

export const ADMIN_CSS = TOKENS + BASE + COMPONENTS + MOBILE + ADMIN_SHELL;
export const STATUS_CSS = TOKENS + BASE + COMPONENTS + MOBILE + STATUS_SHELL;
