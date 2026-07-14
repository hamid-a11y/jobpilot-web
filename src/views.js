// HTML rendering. Everything user-supplied goes through esc() — no exceptions.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--paper:#F2F3F1;--card:#FFF;--ink:#171A18;--dim:#5C6360;--line:#DDE0DB;--green:#1E7A46;--amber:#A87508;--red:#B3352C;--act:#24455E;--act-ink:#fff}
@media(prefers-color-scheme:dark){:root{--paper:#161917;--card:#1E221F;--ink:#ECEFEA;--dim:#9AA39E;--line:#2E332F;--act:#5B8BAe;--act-ink:#08131b}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:16px;margin:0;letter-spacing:.02em}header h1 a{color:inherit;text-decoration:none}
header .meta{font-size:12px;color:var(--dim)}
.nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:13px}
.nav a,.navlink{color:var(--dim);text-decoration:none;background:none;border:none;font:inherit;font-size:13px;cursor:pointer;padding:0;margin:0}
.nav a:hover,.navlink:hover{color:var(--ink);text-decoration:underline}
.nav a.active{color:var(--ink);font-weight:600}
.steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-bottom:16px;padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px}
.step{display:flex;align-items:center;gap:6px}.step.now{color:var(--ink);font-weight:600}.step.done{color:var(--green)}
.stepn{display:inline-flex;width:18px;height:18px;border-radius:50%;background:var(--line);color:var(--ink);align-items:center;justify-content:center;font-size:11px;font-weight:600}
.step.now .stepn{background:var(--act);color:var(--act-ink)}.step.done .stepn{background:var(--green);color:#fff}
.steparr{color:var(--line)}
.lede{color:var(--dim);font-size:14px;margin:-4px 0 18px}
main{max-width:820px;margin:0 auto;padding:24px 16px 72px}
.hero{text-align:center;padding:32px 0}.hero h2{font-size:26px;margin:0 0 8px}.hero p{color:var(--dim);max-width:560px;margin:0 auto 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin:0 0 14px}
.card.jobcard{display:flex;gap:14px;align-items:baseline}
.band{width:6px;align-self:stretch;border-radius:3px;flex:none}
.band.green{background:var(--green)}.band.yellow{background:var(--amber)}.band.red{background:var(--red)}
.score{font-size:24px;font-weight:600;min-width:44px}.score small{display:block;font-size:10px;color:var(--dim);font-weight:400}
label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
input,textarea,select{width:100%;border:1px solid var(--line);border-radius:6px;padding:9px 11px;font:inherit;background:var(--card);color:var(--ink)}
textarea{min-height:120px;font:13px/1.5 "IBM Plex Mono",monospace}
input:focus,textarea:focus{outline:2px solid var(--act);outline-offset:1px}
button,.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;padding:10px 18px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary,.btn.primary{background:var(--act);border-color:var(--act);color:var(--act-ink)}
button.danger{color:var(--red);border-color:var(--red)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 9px;font-size:11px;margin-right:6px}
.pill.core{border-color:var(--green);color:var(--green)}.pill.stretch{border-color:var(--act);color:var(--act)}.pill.flag{border-color:var(--red);color:var(--red)}
.title a{color:inherit;font-weight:600;text-decoration:none}.title a:hover{text-decoration:underline}
.tags{font-size:12px;color:var(--dim)}.rationale{font-size:13px;color:var(--dim);margin-top:6px}
.section{margin:22px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.empty{color:var(--dim);text-align:center;padding:40px 0}.note{font-size:12px;color:var(--dim)}
pre{white-space:pre-wrap;font-size:13px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto}
.banner{background:var(--act);color:var(--act-ink);border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:14px}
.warn{border:1px solid var(--red);color:var(--red);border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:12px}
.fcard{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px}
.frow{display:flex;gap:12px;flex-wrap:wrap}.frow>div{min-width:140px}
.checks{display:flex;gap:14px;padding-top:8px}
.chk{display:inline-flex;align-items:center;gap:5px;font-size:14px;color:var(--ink);margin:0}
.chk input{width:auto}
input[type=file]{padding:7px 9px}
button.mini{padding:4px 10px;font-size:12px}
`;

export const BRAND = "Hamid's Friend Agentic Job Portal";

// A 4-step journey guide; `active` (1-4) is the user's current step.
export const steps = (active) => {
  const items = ['Add your API key', 'Build a profile', 'Find &amp; draft jobs', 'Review &amp; apply'];
  return `<div class="steps">${items.map((t, i) => {
    const cls = i + 1 < active ? 'done' : i + 1 === active ? 'now' : '';
    return `<div class="step ${cls}"><span class="stepn">${i + 1 < active ? '✓' : i + 1}</span> ${t}</div>`;
  }).join('<span class="steparr">→</span>')}</div>`;
};

// `nav` is the id of the current page for highlighting: dashboard|profiles|add|settings.
export const page = (title, body, { workspace, nav = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${esc(BRAND)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><h1><a href="${workspace ? `/w/${workspace.id}` : '/'}">Hamid&#39;s Friend <span style="color:var(--dim)">· Agentic Job Portal</span></a></h1>
${workspace ? `<nav class="nav">
  <a href="/w/${workspace.id}" class="${nav === 'dashboard' ? 'active' : ''}">Dashboard</a>
  <a href="/w/${workspace.id}/profiles" class="${nav === 'profiles' ? 'active' : ''}">Profiles</a>
  <a href="/w/${workspace.id}/add" class="${nav === 'add' ? 'active' : ''}">Add job</a>
  <a href="/w/${workspace.id}/settings" class="${nav === 'settings' ? 'active' : ''}">Settings</a>
  <span class="meta">${esc(workspace.name)}</span>
  <form method="post" action="/logout" style="display:inline;margin:0"><button class="navlink">Log out</button></form>
</nav>` : '<span class="meta">agentic job-search assistant</span>'}
</header><main>${body}</main></body></html>`;
