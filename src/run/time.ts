import type { RuleModel } from '../parse/index.js';
import { allowRanges, allowsAt } from '../report/spans.js';

/** `request.time < timestamp.date(2025, 11, 7)` and friends: a rule that's open until (or from) a date. */
export interface TimeLimit {
  /** Line of the comparison. */
  line: number;
  kind: 'until' | 'from';
  /** YYYY-MM-DD */
  date: string;
  /** The allow it belongs to: line, and `<document path> <ops>` for matching base with head. */
  allowLine: number;
  key: string;
}

const NUM = String.raw`\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*`;
const TIME_FIRST = new RegExp(String.raw`request\.time\s*(<=|<|>=|>)\s*timestamp\.date\(${NUM}\)`, 'g');
const DATE_FIRST = new RegExp(String.raw`timestamp\.date\(${NUM}\)\s*(<=|<|>=|>)\s*request\.time`, 'g');

interface Match {
  index: number;
  length: number;
  kind: 'until' | 'from';
  date: string;
}

const pad = (n: string) => n.padStart(2, '0');

function matches(source: string): Match[] {
  const out: Match[] = [];
  const inComment = (i: number) => {
    const lineStart = source.lastIndexOf('\n', i) + 1;
    return source.slice(lineStart, i).includes('//');
  };
  for (const m of source.matchAll(TIME_FIRST)) {
    if (inComment(m.index!)) continue;
    out.push({ index: m.index!, length: m[0].length, kind: m[1]!.startsWith('<') ? 'until' : 'from', date: `${m[2]}-${pad(m[3]!)}-${pad(m[4]!)}` });
  }
  for (const m of source.matchAll(DATE_FIRST)) {
    if (inComment(m.index!)) continue;
    out.push({ index: m.index!, length: m[0].length, kind: m[4]!.startsWith('>') ? 'until' : 'from', date: `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}` });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The source with every time-limit comparison replaced by `true` padded to the same length (newlines
 * kept), so runs evaluate as if inside the window on any day and coverage offsets still line up.
 */
export function neutralizeTimeLimits(source: string): string {
  let out = source;
  for (const m of matches(source).reverse()) {
    const text = source.slice(m.index, m.index + m.length);
    out = out.slice(0, m.index) + 'true' + text.slice(4).replace(/[^\n]/g, ' ') + out.slice(m.index + m.length);
  }
  return out;
}

export function findTimeLimits(source: string, model: RuleModel): TimeLimit[] {
  const ranges = allowRanges(model);
  return matches(source).flatMap((m) => {
    const line = source.slice(0, m.index).split('\n').length;
    return allowsAt(ranges, line).map(({ block, allow }) => ({
      line,
      kind: m.kind,
      date: m.date,
      allowLine: allow.loc.line,
      key: `${block.documentPath ?? block.path} ${allow.ops.join(',')}`,
    }));
  });
}

export interface TimeLimitChange {
  direction: 'gained' | 'lost';
  text: string;
  line: number;
}

/** What changed about time limits between base and head, matched by allow path + ops. */
export function timeLimitChanges(base: TimeLimit[], head: TimeLimit[], headModel: RuleModel): TimeLimitChange[] {
  const out: TimeLimitChange[] = [];
  const headKeys = new Map<string, number>(headModel.matches.flatMap((b) => b.allows.map((a): [string, number] => [`${b.documentPath ?? b.path} ${a.ops.join(',')}`, a.loc.line])));
  const where = (key: string) => `\`${key.split(' ')[0] || '/'}\` ${key.split(' ')[1]}`;
  for (const b of base) {
    const h = head.find((x) => x.key === b.key && x.kind === b.kind);
    const word = b.kind === 'until' ? 'until' : 'from';
    if (!h) {
      const headLine = headKeys.get(b.key);
      if (headLine !== undefined) {
        out.push({
          direction: 'gained',
          line: headLine,
          text: `L${headLine} ${where(b.key)}: was open ${word} ${b.date} (base L${b.line}); head has no date limit`,
        });
      }
    } else if (h.date !== b.date) {
      const later = h.date > b.date;
      out.push({
        direction: (b.kind === 'until') === later ? 'gained' : 'lost',
        line: h.line,
        text: `L${h.line} ${where(b.key)}: open ${word} ${h.date}, was ${b.date} (base L${b.line})`,
      });
    }
  }
  for (const h of head) {
    if (base.some((x) => x.key === h.key && x.kind === h.kind)) continue;
    out.push({ direction: 'lost', line: h.line, text: `L${h.line} ${where(h.key)}: now open only ${h.kind === 'until' ? 'until' : 'from'} ${h.date}` });
  }
  return out.sort((a, b) => a.line - b.line);
}
