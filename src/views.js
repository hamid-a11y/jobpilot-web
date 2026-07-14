// HTML rendering plus the shared design system. Everything user-supplied goes
// through esc(), no exceptions. All CSS is inline (strict CSP, no JS). Look:
// a confident deep-blue palette, Space Grotesk display + Manrope UI, gradient
// accents with a soft glow, and a navy dark mode. No long dashes anywhere.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{
  --paper:#F2F5FB; --card:#FFFFFF; --ink:#0F1836; --dim:#54607C; --faint:#8A93AC;
  --line:#E0E6F1; --line-soft:#EBEFF8;
  --accent:#2563EB; --accent-2:#1E40C8; --accent-ink:#FFFFFF; --wash:#E7EEFE;
  --grad:linear-gradient(135deg,#3B6EF6,#1E40C8); --glow:0 2px 12px rgba(37,99,235,.26);
  --green:#167A54; --amber:#A9750F; --red:#C63A2E;
  --shadow:0 1px 2px rgba(16,24,54,.06),0 1px 3px rgba(16,24,54,.04);
  --shadow-lg:0 8px 30px rgba(16,24,54,.12);
  --r:12px; --rs:9px;
}
@media(prefers-color-scheme:dark){:root{
  --paper:#0B1120; --card:#131C31; --ink:#E8EDF9; --dim:#97A1BD; --faint:#66728F;
  --line:#232E48; --line-soft:#18213A;
  --accent:#6E9BFF; --accent-2:#8FB0FF; --accent-ink:#FFFFFF; --wash:#172449;
  --grad:linear-gradient(135deg,#3E6AE6,#2A4FCB); --glow:0 2px 16px rgba(46,79,203,.5);
  --green:#3FA173; --amber:#CDA052; --red:#E06A5C;
  --shadow:0 1px 2px rgba(0,0,0,.4); --shadow-lg:0 12px 38px rgba(0,0,0,.55);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "Manrope",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.mono{font-family:"JetBrains Mono",ui-monospace,monospace}
.disp{font-family:"Space Grotesk","Manrope",sans-serif}
main a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:.06em}
main a:hover{color:var(--accent-2)}

header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 32px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--paper);z-index:10;flex-wrap:wrap}
header h1{font-family:"Space Grotesk",sans-serif;font-size:19px;font-weight:600;margin:0;letter-spacing:-.01em}
header h1 a{color:inherit;text-decoration:none}
header h1 .light{color:var(--accent);font-weight:500}
header .meta{font-size:13px;color:var(--faint)}
.nav{display:flex;gap:22px;align-items:center;flex-wrap:wrap;font-size:14px}
.nav a,.navlink{color:var(--dim);text-decoration:none;background:none;border:none;font:inherit;font-size:14px;cursor:pointer;padding:0;margin:0;transition:color .15s}
.nav a:hover,.navlink:hover{color:var(--ink)}
.nav a.active{color:var(--accent);font-weight:600}

main{max-width:880px;margin:0 auto;padding:36px 20px 88px}
.hero{text-align:center;padding:48px 0 36px}
.hero h2{font-family:"Space Grotesk",sans-serif;font-size:clamp(30px,5.4vw,50px);line-height:1.05;font-weight:700;letter-spacing:-.025em;margin:0 0 16px;color:var(--ink)}
@supports((-webkit-background-clip:text) or (background-clip:text)){.hero h2{background:linear-gradient(120deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}}
.hero p{color:var(--dim);max-width:600px;margin:0 auto;font-size:17px;line-height:1.62}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px 24px;margin:0 0 16px;box-shadow:var(--shadow)}
.card.jobcard{display:flex;gap:16px;align-items:flex-start;padding:18px 20px;transition:box-shadow .15s,border-color .15s}
.card.jobcard:hover{box-shadow:var(--shadow-lg);border-color:var(--accent)}
.band{width:4px;align-self:stretch;border-radius:99px;flex:none}
.band.green{background:var(--green)}.band.yellow{background:var(--amber)}.band.red{background:var(--red)}
.score{font-family:"Space Grotesk",sans-serif;font-size:28px;font-weight:700;min-width:48px;line-height:1;color:var(--accent)}
.score small{display:block;font-family:"Manrope",sans-serif;font-size:10px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-top:3px}

label{display:block;font-size:13px;font-weight:500;color:var(--dim);margin:14px 0 5px}
input,textarea,select{width:100%;border:1px solid var(--line);border-radius:var(--rs);padding:11px 13px;font:inherit;font-size:15px;background:var(--card);color:var(--ink);transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--wash)}
input::placeholder,textarea::placeholder{color:var(--faint)}
textarea{min-height:120px;line-height:1.55;resize:vertical}

button,.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:var(--rs);padding:10px 18px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.2;transition:border-color .15s,background .15s,color .15s,box-shadow .15s}
button:hover,.btn:hover{border-color:var(--accent)}
button.primary,.btn.primary{background:var(--grad);border:none;color:var(--accent-ink);box-shadow:var(--glow)}
button.primary:hover,.btn.primary:hover{filter:brightness(1.06);box-shadow:var(--shadow-lg)}
button.danger{color:var(--red);border-color:transparent;background:none;font-weight:500}
button.danger:hover{background:color-mix(in srgb,var(--red) 12%,transparent);border-color:transparent}
button:disabled,.btn:disabled{opacity:.42;cursor:not-allowed;filter:none}
button.mini{padding:5px 12px;font-size:12.5px;border-radius:7px;font-weight:500}

.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 11px;font-size:11.5px;font-weight:600;margin-right:6px;color:var(--dim)}
.pill.core{border-color:transparent;background:color-mix(in srgb,var(--green) 15%,transparent);color:var(--green)}
.pill.stretch{border-color:transparent;background:var(--wash);color:var(--accent)}
.pill.flag{border-color:transparent;background:color-mix(in srgb,var(--red) 13%,transparent);color:var(--red)}
.title a{color:inherit;font-weight:600;text-decoration:none;font-size:16px}
.title a:hover{color:var(--accent)}
.tags{font-size:13px;color:var(--dim);margin-top:3px}
.rationale{font-size:13.5px;color:var(--dim);margin-top:8px;line-height:1.55}
.section{margin:28px 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--faint)}
.lede{color:var(--dim);font-size:15px;line-height:1.62;margin:-2px 0 22px;max-width:660px}
.empty{color:var(--dim);text-align:center;padding:48px 20px;font-size:15px}
.note{font-size:13px;color:var(--faint);line-height:1.5}
pre{white-space:pre-wrap;font-size:13px;line-height:1.55;background:var(--line-soft);border:1px solid var(--line);border-radius:var(--rs);padding:14px 16px;overflow-x:auto;font-family:"JetBrains Mono",ui-monospace,monospace}
.banner{background:var(--wash);color:var(--accent-2);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:var(--r);padding:13px 18px;margin-bottom:16px;font-size:14px;font-weight:600}
.warn{background:color-mix(in srgb,var(--red) 8%,transparent);border:1px solid color-mix(in srgb,var(--red) 28%,transparent);color:var(--red);border-radius:var(--r);padding:12px 16px;font-size:13.5px;margin-bottom:14px}

.steps{display:flex;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--dim);margin-bottom:24px;padding:16px 20px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.step{display:flex;align-items:center;gap:8px;padding:2px 4px}
.step.now{color:var(--ink);font-weight:700}.step.done{color:var(--green)}
.stepn{display:inline-flex;width:22px;height:22px;border-radius:50%;background:var(--line);color:var(--dim);align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:none}
.step.now .stepn{background:var(--grad);color:var(--accent-ink);box-shadow:var(--glow)}
.step.done .stepn{background:var(--green);color:#fff}
.steparr{color:var(--line);margin:0 10px;flex:none}

.fcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:14px;box-shadow:var(--shadow)}
.frow{display:flex;gap:14px;flex-wrap:wrap}.frow>div{min-width:150px}
.checks{display:flex;gap:16px;padding-top:8px;flex-wrap:wrap}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--ink);margin:0;font-weight:400}
.chk input{width:auto}
input[type=file]{padding:9px 11px;font-size:14px}
@media(max-width:560px){main{padding:24px 16px 72px}.hero{padding:32px 0 24px}.steparr{display:none}}
`;

export const BRAND = "Hamid's Friend Agentic Job Portal";
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%232563EB'/%3E%3Ctext x='50' y='72' font-size='58' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'%3EH%3C/text%3E%3C/svg%3E";

// A 4-step journey guide. `active` (1 to 4) is the user's current step.
export const steps = (active) => {
  const items = ['Add your API key', 'Build a profile', 'Find &amp; draft jobs', 'Review &amp; apply'];
  return `<div class="steps">${items.map((t, i) => {
    const cls = i + 1 < active ? 'done' : i + 1 === active ? 'now' : '';
    return `<div class="step ${cls}"><span class="stepn">${i + 1 < active ? '✓' : i + 1}</span> ${t}</div>`;
  }).join('<span class="steparr">→</span>')}</div>`;
};

// `nav` is the current page id for highlighting: dashboard|profiles|add|settings.
export const page = (title, body, { workspace, nav = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${esc(BRAND)}</title>
<link rel="icon" href="${FAVICON}">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><h1><a href="${workspace ? `/w/${workspace.id}` : '/'}">Hamid&#39;s Friend <span class="light">· Agentic Job Portal</span></a></h1>
${workspace ? `<nav class="nav">
  <a href="/w/${workspace.id}" class="${nav === 'dashboard' ? 'active' : ''}">Dashboard</a>
  <a href="/w/${workspace.id}/profiles" class="${nav === 'profiles' ? 'active' : ''}">Profiles</a>
  <a href="/w/${workspace.id}/add" class="${nav === 'add' ? 'active' : ''}">Add job</a>
  <a href="/w/${workspace.id}/settings" class="${nav === 'settings' ? 'active' : ''}">Settings</a>
  <span class="meta">${esc(workspace.name)}</span>
  <form method="post" action="/logout" style="display:inline;margin:0"><button class="navlink">Log out</button></form>
</nav>` : '<span class="meta">agentic job-search assistant</span>'}
</header><main>${body}</main></body></html>`;
