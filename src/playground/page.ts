/** Built-in example: trap-01 (read opened to every signed-in user, role guard dropped). */
const EXAMPLE_BASE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }

    function isOwner(uid) {
      return isSignedIn() && request.auth.uid == uid;
    }

    match /users/{uid} {
      allow read: if isOwner(uid);
      allow create: if isOwner(uid) && request.resource.data.role == 'member';
      allow update: if isOwner(uid)
        && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);
      allow delete: if false;
    }
  }
}
`;

const EXAMPLE_HEAD = EXAMPLE_BASE.replace('allow read: if isOwner(uid);', 'allow read: if isSignedIn();').replace(
  `allow update: if isOwner(uid)
        && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);`,
  'allow update: if isOwner(uid);',
);

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The playground page: two editors, a Compare button, and the rendered report. No external resources. */
export function playgroundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firediff playground</title>
<style>
  :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --panel: #f6f8fa; --accent: #d1242f; --ok: #1a7f37; --code: #eff2f5; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --panel: #151b23; --accent: #f85149; --ok: #3fb950; --code: #262c36; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; }
  header h1 { font-size: 18px; margin: 0; }
  header p { margin: 0; color: var(--muted); }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1400px; margin: 0 auto; }
  .editors { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 800px) { .editors { grid-template-columns: 1fr; } }
  label { display: block; font-weight: 600; margin-bottom: 4px; }
  textarea { width: 100%; min-height: 320px; resize: vertical; padding: 10px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel); color: var(--fg); font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 2; }
  details.config textarea { min-height: 120px; }
  .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border); background: var(--fg); color: var(--bg); cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); }
  button:disabled { opacity: 0.5; cursor: progress; }
  #status { color: var(--muted); }
  #status.error { color: var(--accent); }
  #status.gained { color: var(--accent); font-weight: 600; }
  #status.clean { color: var(--ok); }
  #report { border: 1px solid var(--border); border-radius: 6px; padding: 8px 16px; min-height: 80px; overflow-x: auto; }
  #report:empty::before { content: "The report appears here."; color: var(--muted); }
  #report table { border-collapse: collapse; margin: 8px 0; }
  #report th, #report td { border: 1px solid var(--border); padding: 4px 10px; text-align: left; vertical-align: top; }
  #report code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 90%; }
  #report pre { background: var(--code); padding: 10px; border-radius: 6px; overflow-x: auto; }
  #report pre code { background: none; padding: 0; }
  #report blockquote { margin: 8px 0; padding: 4px 12px; border-left: 4px solid var(--accent); color: var(--muted); }
  #report summary { cursor: pointer; font-weight: 600; margin: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>firediff playground</h1>
  <p>Paste two versions of a Firestore rules file to see who the change lets in (or out). Runs on a local emulator.</p>
</header>
<main>
  <div class="editors">
    <div><label for="base">Base (before)</label><textarea id="base" spellcheck="false"></textarea></div>
    <div><label for="head">Head (after)</label><textarea id="head" spellcheck="false"></textarea></div>
  </div>
  <details class="config"><summary>firediff.yml (optional)</summary>
    <textarea id="config" spellcheck="false" placeholder="claims:&#10;  plan: [pro]"></textarea>
  </details>
  <div class="actions">
    <button id="run">Compare</button>
    <button id="example" class="secondary">Load example</button>
    <button id="copy" class="secondary" disabled>Copy markdown</button>
    <span id="status" role="status"></span>
  </div>
  <section id="report" aria-live="polite"></section>
</main>
<script>
  const EXAMPLE = { base: ${json(EXAMPLE_BASE)}, head: ${json(EXAMPLE_HEAD)} };
  const $ = (id) => document.getElementById(id);
  const fields = ['base', 'head', 'config'];
  let markdown = '';
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem('firediff-playground') || 'null');
      if (saved && saved.base) { for (const f of fields) $(f).value = saved[f] || ''; return; }
    } catch {}
    $('base').value = EXAMPLE.base; $('head').value = EXAMPLE.head;
  }
  function save() {
    try { localStorage.setItem('firediff-playground', JSON.stringify(Object.fromEntries(fields.map((f) => [f, $(f).value])))); } catch {}
  }
  function status(text, cls = '') { $('status').textContent = text; $('status').className = cls; }
  async function run() {
    save();
    $('run').disabled = true; $('copy').disabled = true;
    status('Running against both versions…');
    const t0 = performance.now();
    try {
      const res = await fetch('/api/diff', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base: $('base').value, head: $('head').value, config: $('config').value }) });
      const body = await res.json();
      if (!res.ok) { status(body.error || 'Something went wrong', 'error'); return; }
      markdown = body.markdown;
      $('report').innerHTML = body.html;
      $('copy').disabled = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const g = body.counts.gained;
      status(g ? g + ' gained-access row' + (g === 1 ? '' : 's') + ' · ' + body.counts.requests + ' requests · ' + secs + ' s'
               : 'No gained access in ' + body.counts.requests + ' requests · ' + secs + ' s', g ? 'gained' : 'clean');
    } catch (e) {
      status('Could not reach the playground server. Is it still running?', 'error');
    } finally {
      $('run').disabled = false;
    }
  }
  $('run').addEventListener('click', run);
  $('example').addEventListener('click', () => { $('base').value = EXAMPLE.base; $('head').value = EXAMPLE.head; $('config').value = ''; save(); });
  $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(markdown); status('Markdown copied.', 'clean'); } catch { status('Copy failed.', 'error'); } });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); });
  load();
</script>
</body>
</html>`;
}
