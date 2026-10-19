// Debug aid: print the token stream of a rules file.
import { readFileSync } from 'node:fs';
import { CharStream } from 'antlr4';
import FirebaseRulesLexer from '../src/grammar/FirebaseRulesLexer.js';

const lexer: any = new FirebaseRulesLexer(new CharStream(readFileSync(process.argv[2]!, 'utf8')));
const L: any = FirebaseRulesLexer;
for (const t of lexer.getAllTokens()) {
  if (t.channel === 0) process.stdout.write(`${L.symbolicNames[t.type]}<${t.text}> `);
}
console.log();
