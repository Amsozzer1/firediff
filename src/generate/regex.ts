/**
 * Build a short string that fully matches a rules regex (string.matches() is a full match, RE2 syntax).
 * Covers literals, escapes, classes, groups, alternation and quantifiers; returns null when the
 * pattern uses something unsupported or the result doesn't verify.
 */
export function sampleFor(pattern: string): string | null {
  let pos = 0;
  const src = pattern.replace(/^\^/, '').replace(/\$$/, '');

  const fail = (): never => {
    throw new Error('unsupported');
  };

  // A set of allowed chars, possibly negated.
  const classChar = (body: string, negated: boolean): string => {
    const allowed = (ch: string) => {
      let ok = false;
      for (let i = 0; i < body.length; i++) {
        let c = body[i]!;
        if (c === '\\') {
          const e = body[++i]!;
          if (e === 'd' && /\d/.test(ch)) ok = true;
          else if (e === 'w' && /\w/.test(ch)) ok = true;
          else if (e === 's' && /\s/.test(ch)) ok = true;
          else if (e === ch) ok = true;
          continue;
        }
        if (body[i + 1] === '-' && body[i + 2] !== undefined && body[i + 2] !== ']') {
          const hi = body[i + 2]!;
          if (ch >= c && ch <= hi) ok = true;
          i += 2;
          continue;
        }
        if (c === ch) ok = true;
      }
      return negated ? !ok : ok;
    };
    for (const ch of 'abcxyz0123456789ABC._-@') if (allowed(ch)) return ch;
    return fail();
  };

  const atom = (): string => {
    const ch = src[pos++];
    if (ch === undefined) return fail();
    if (ch === '.') return 'a';
    if (ch === '\\') {
      const e = src[pos++];
      if (e === 'd') return '1';
      if (e === 'w') return 'a';
      if (e === 's') return ' ';
      if (e === undefined) return fail();
      return e;
    }
    if (ch === '[') {
      let negated = false;
      if (src[pos] === '^') {
        negated = true;
        pos++;
      }
      let body = '';
      if (src[pos] === ']') body += src[pos++];
      while (src[pos] !== ']') {
        if (src[pos] === undefined) return fail();
        if (src[pos] === '\\') body += src[pos++];
        body += src[pos++];
      }
      pos++;
      return classChar(body, negated);
    }
    if (ch === '(') {
      if (src.startsWith('?:', pos)) pos += 2;
      else if (src[pos] === '?') return fail();
      const inner = alternation();
      if (src[pos++] !== ')') return fail();
      return inner;
    }
    if (ch === ')' || ch === '|' || '*+?{'.includes(ch)) return fail();
    return ch;
  };

  const quantified = (): string => {
    const a = atom();
    const q = src[pos];
    let reps = 1;
    if (q === '*' || q === '+' || q === '?') {
      pos++;
      reps = 1;
    } else if (q === '{') {
      const m = src.slice(pos).match(/^\{(\d+)(,(\d*))?\}/);
      if (!m) return a;
      pos += m[0].length;
      const lo = Number(m[1]);
      const hi = m[3] === undefined ? (m[2] ? Infinity : lo) : m[3] === '' ? Infinity : Number(m[3]);
      reps = Math.max(lo, Math.min(1, hi));
    } else return a;
    if (src[pos] === '?') pos++; // lazy
    return a.repeat(reps);
  };

  const sequence = (): string => {
    let out = '';
    while (pos < src.length && src[pos] !== '|' && src[pos] !== ')') out += quantified();
    return out;
  };

  const alternation = (): string => {
    const first = sequence();
    while (src[pos] === '|') {
      pos++;
      sequence();
    }
    return first;
  };

  try {
    const s = alternation();
    if (pos !== src.length) return null;
    return new RegExp(`^(?:${src})$`).test(s) ? s : null;
  } catch {
    return null;
  }
}
