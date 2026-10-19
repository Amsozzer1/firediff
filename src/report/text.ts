import type { Report, ReportRow } from './build.js';
import { dataText, untestedLine } from './markdown.js';

function table(rows: ReportRow[]): string[] {
  const w = (k: 'who' | 'can') => Math.max(...rows.map((r) => r[k].length));
  return rows.map((r) => `  ${r.who.padEnd(w('who'))}  ${r.can.padEnd(w('can'))}  ${r.on}`);
}

/** Terminal output: same content as the markdown, without HTML. */
export function renderText(report: Report): string {
  const changes = report.gained.length + report.lost.length + report.timeChanges.length;
  const out = [
    changes
      ? `firediff: ${changes} access change${changes === 1 ? '' : 's'} (${report.base} -> ${report.head}, ${report.requests} requests)`
      : `firediff: no access changes in ${report.requests} requests (${report.base} -> ${report.head})`,
    '',
  ];
  if (report.lowCoverage) out.push(`WARNING: firediff could only test ${report.lowCoverage.reached} of ${report.lowCoverage.total} rules in this file; results are incomplete.`, '');
  if (report.changedUntested.length) {
    out.push('Changed in this PR, but never tested');
    for (const c of report.changedUntested) out.push(`  ${untestedLine(c).replace(/`/g, '')}`);
    out.push('');
  }
  if (report.gained.length) out.push('Gained', ...table(report.gained), '');
  if (report.timeChanges.length) out.push('Time-limited rules', ...report.timeChanges.map((t) => `  ${t.text.replace(/`/g, '')}`), '');
  if (report.lost.length) out.push('Lost', ...table(report.lost), '');
  if (report.dataChanged.length) out.push('Accepted data changed', ...report.dataChanged.map((r) => `  ${r.who}  ${dataText(r)}  ${r.on}`), '');
  if (report.couldntTest.length) out.push("Couldn't test", ...report.couldntTest.map((c) => `  ${c.who}  ${c.can}  ${c.on}: head needs ${c.missing}`), '');
  out.push('Not exercised');
  for (const n of report.notExercised) out.push(`  ${n.line !== null ? `L${n.line} ` : ''}${n.text}`);
  out.push('');
  const rows = [...report.gained, ...report.lost, ...report.dataChanged];
  if (rows.length) {
    out.push('Proof');
    rows.forEach((r, i) => {
      out.push(`  ${i + 1}. ${r.who} ${r.direction === 'gained' ? 'can now' : 'can no longer'} ${r.can} · ${r.on}`);
      out.push(`     ${r.direction === 'gained' ? 'base' : 'head'}: ${r.denial}`);
      out.push(`     ${JSON.stringify(r.proof)}`);
    });
    out.push('');
  }
  return out.join('\n');
}
