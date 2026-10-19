import type { ChangedUntested, Report, ReportRow } from './build.js';

/** GitHub's comment limit is 65,536; stay well under it. */
export const MAX_CHARS = 60_000;

/** Rule-derived text (labels, literals) must not become HTML when the markdown is rendered. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (s: string) => esc(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

function table(rows: ReportRow[], verb: string): string[] {
  return [`| Who | ${verb} | On |`, '|---|---|---|', ...rows.map((r) => `| ${cell(r.who)} | ${cell(r.can)} | ${code(r.on)} |`)];
}

export function untestedLine(c: ChangedUntested): string {
  const where = c.allowLines.length ? ` (in the rule at L${c.allowLines.join(', L')})` : '';
  return c.text ? `L${c.line} ${code(c.text)}: ${c.why}${where}` : `L${c.line} ${c.why}${where}`;
}

/** "create now accepts different values for role" / "update now rejects …" */
export function dataText(r: ReportRow): string {
  const fields = r.group.fields.length ? r.group.fields.join(', ') : 'a different payload';
  return `${r.group.ops.join(', ')} now ${r.direction === 'gained' ? 'accepts' : 'rejects'} values for ${fields} it ${r.direction === 'gained' ? "didn't" : 'did'} before`;
}

function proof(r: ReportRow, i: number): string[] {
  const verb = r.direction === 'gained' ? 'can now' : 'can no longer';
  const side = r.direction === 'gained' ? 'Base' : 'Head';
  return [
    `**${i}. ${esc(r.who)} ${verb} ${esc(r.can)} · ${code(r.on)}**`,
    '',
    `${side}: ${r.denial}`,
    '',
    '```json',
    JSON.stringify(r.proof, null, 2),
    '```',
    '',
  ];
}

/** The PR comment. Deterministic: no timings, ids, or counts that vary between runs. */
export function renderMarkdown(report: Report): string {
  const changes = report.gained.length + report.lost.length + report.timeChanges.length;
  const out: string[] = [
    changes
      ? `### firediff · ${changes} access change${changes === 1 ? '' : 's'}`
      : `### firediff · no access changes in ${report.requests} requests`,
    '',
  ];

  if (report.lowCoverage) {
    const c = report.lowCoverage;
    out.push(`> [!WARNING]`, `> firediff could only test ${c.reached} of ${c.total} rules in this file; results are incomplete.`);
    if (c.hint) out.push('> ' + c.hint.why, '>', '> ```yaml', ...c.hint.yaml.split('\n').map((l) => `> ${l}`), '> ```');
    out.push('');
  }

  if (report.changedUntested.length) {
    out.push('**Changed in this PR, but never tested**', '');
    for (const c of report.changedUntested) out.push(`- ${untestedLine(c)}`);
    out.push('');
  }

  if (changes) {
    if (report.gained.length) out.push(...table(report.gained, 'Can now'), '');
    else if (!report.timeChanges.some((t) => t.direction === 'gained')) out.push('Nothing gained access.', '');
    if (report.timeChanges.length) {
      out.push('**Time-limited rules**', '', ...report.timeChanges.map((t) => `- ${t.text}`), '');
    }
    if (report.lost.length) {
      out.push(`<details><summary>Lost access (${report.lost.length})</summary>`, '', ...table(report.lost, 'Can no longer'), '', '</details>', '');
    }
  }

  if (report.dataChanged.length) {
    out.push(
      `<details><summary>Accepted data changed (${report.dataChanged.length})</summary>`,
      '',
      '| Who | Change | On |',
      '|---|---|---|',
      ...report.dataChanged.map((r) => `| ${cell(r.who)} | ${cell(dataText(r))} | ${code(r.on)} |`),
      '',
      '</details>',
      '',
    );
  }

  if (report.couldntTest.length) {
    out.push('**Couldn\'t test**', '');
    for (const c of report.couldntTest) out.push(`- ${esc(c.who)} · ${esc(c.can)} · ${code(c.on)}: head needs ${esc(c.missing)}`);
    out.push('');
  }

  out.push('**Not exercised**', '');
  for (const n of report.notExercised) out.push(`- ${n.line !== null ? `L${n.line} ` : ''}${n.text}`);
  out.push('');

  const rows = [...report.gained, ...report.lost, ...report.dataChanged];
  if (rows.length) {
    out.push(`<details><summary>Proof (${rows.length})</summary>`, '');
    rows.forEach((r, i) => out.push(...proof(r, i + 1)));
    out.push('</details>', '');
  }
  return truncate(out.join('\n'));
}

/** Cut at MAX_CHARS on a line boundary, close any open code fence and <details>, and say so. */
export function truncate(md: string, max = MAX_CHARS): string {
  if (md.length <= max) return md;
  const note = '\n_Report truncated at 60,000 characters (GitHub comments max out at 65,536). Run `firediff --format json` for every row._\n';
  let cut = md.slice(0, max - note.length - 64);
  cut = cut.slice(0, cut.lastIndexOf('\n') + 1);
  let tail = '';
  if ((cut.match(/^```/gm)?.length ?? 0) % 2 === 1) tail += '```\n';
  const open = (cut.match(/<details>/g)?.length ?? 0) - (cut.match(/<\/details>/g)?.length ?? 0);
  for (let i = 0; i < open; i++) tail += '\n</details>\n';
  return cut + tail + note;
}
