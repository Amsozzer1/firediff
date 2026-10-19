import type { HostedLimits } from './hosted.js';

/** Built-in example: trap-01 (read opened to every signed-in user, role guard dropped). */
export const EXAMPLE_BASE = `rules_version = '2';
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

export const EXAMPLE_HEAD = EXAMPLE_BASE.replace('allow read: if isOwner(uid);', 'allow read: if isSignedIn();').replace(
  `allow update: if isOwner(uid)
        && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);`,
  'allow update: if isOwner(uid);',
);

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export const REPO_URL = 'https://github.com/Amsozzer1/firediff';
export const NPM_URL = 'https://www.npmjs.com/package/@amsozzer/firediff';
export const MARKETPLACE_URL = 'https://github.com/marketplace/actions/firediff';
const SOCIAL_IMAGE = 'https://raw.githubusercontent.com/Amsozzer1/firediff/main/docs/social-preview.png';
export const TITLE = 'firediff: Firestore security rules diff playground';
export const DESCRIPTION =
  'Paste two versions of your Firestore security rules and see who the change lets in or out: firediff runs both in the Firestore emulator and diffs the results.';
const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#d1242f"/><path d="M9 8h14v4H13v3h8v4h-8v5H9z" fill="#fff"/></svg>')}`;

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Title, description, canonical URL, social tags and structured data. */
function head(publicUrl?: string): string {
  const url = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/` : undefined;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'firediff',
    description: 'Diff Firestore security rules by behavior: a CLI and GitHub Action that runs the old and new rules in the Firestore emulator and reports who gained or lost access.',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows (Node 22 and Java 21)',
    url: url ?? REPO_URL,
    codeRepository: REPO_URL,
    license: 'https://opensource.org/licenses/MIT',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    sameAs: [REPO_URL, NPM_URL, MARKETPLACE_URL],
  };
  return [
    `<title>${TITLE}</title>`,
    `<meta name="description" content="${attr(DESCRIPTION)}">`,
    url ? `<link rel="canonical" href="${attr(url)}">` : '',
    `<link rel="icon" href="${attr(ICON)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${attr(TITLE)}">`,
    `<meta property="og:description" content="${attr(DESCRIPTION)}">`,
    url ? `<meta property="og:url" content="${attr(url)}">` : '',
    `<meta property="og:image" content="${SOCIAL_IMAGE}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${json(ld)}</script>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the header says about where the comparison runs. */
function about(hosted?: HostedLimits): string {
  if (!hosted) return 'Runs on a local emulator.';
  return `Runs in a Firestore emulator on this server; nothing is stored. Up to ${hosted.rulesBytes / 1024} KB per file and ${hosted.maxRequests} requests.
    For bigger files, run <code>npx @amsozzer/firediff</code> (<a href="https://github.com/Amsozzer1/firediff">GitHub</a>).`;
}

/** The playground page: two editors, a Compare button, and the rendered report. No external resources. */
export function playgroundPage(hosted?: HostedLimits, publicUrl?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head(publicUrl)}
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
  header a { color: inherit; }
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
  .about { color: var(--muted); max-width: 80ch; }
  .about h2 { font-size: 16px; color: var(--fg); margin: 16px 0 4px; }
  .about p { margin: 4px 0; }
  .about a { color: inherit; }
  .about code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 90%; }
</style>
</head>
<body>
<header>
  <h1>firediff playground</h1>
  <p>Paste two versions of a Firestore rules file to see who the change lets in (or out). ${about(hosted)}</p>
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
  <section class="about">
    <h2>What is firediff?</h2>
    <p>firediff diffs Firestore security rules by behavior. It runs the old and new rules side by side in the
      Firestore emulator and sends both the same generated requests: signed-out users, strangers, owners, and users
      with custom claims or role docs. It reports only the requests whose allow/deny flipped, each with a request you
      can replay. It's deterministic and doesn't use an LLM, and it never touches a real Firebase project.</p>
    <h2>Run it on every pull request</h2>
    <p>Add <code>uses: Amsozzer1/firediff@v0.1</code> to a <code>pull_request</code> workflow. It posts one comment
      per PR listing who gained or lost access, and fails the check when access was gained. Locally:
      <code>npx @amsozzer/firediff base.rules head.rules</code>, or <code>npx @amsozzer/firediff --since main</code>.</p>
    <p><a href="${REPO_URL}">GitHub</a> · <a href="${NPM_URL}">npm</a> · <a href="${MARKETPLACE_URL}">GitHub Marketplace</a> · MIT licensed</p>
  </section>
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
  function failure(code) {
    if (code === 504) return 'This comparison took longer than the time limit. Run it locally: npx @amsozzer/firediff base.rules head.rules';
    if (code === 429) return 'Too many comparisons. Try again in a minute.';
    if (code === 413) return 'These rules are too big for this playground. Run it locally: npx @amsozzer/firediff base.rules head.rules';
    return 'Something went wrong (HTTP ' + code + ').';
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
      // A proxy in front (Cloudflare replaces 502/504 bodies) may send no JSON, so fall back on the status.
      let body = null;
      try { body = await res.json(); } catch {}
      if (!res.ok || !body) { status((body && body.error) || failure(res.status), 'error'); return; }
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
