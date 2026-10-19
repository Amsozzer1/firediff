// Debug aid: print the raw ANTLR parse tree of a rules file (single-child chains collapsed).
import { readFileSync } from 'node:fs';
import { CharStream, CommonTokenStream } from 'antlr4';
import FirebaseRulesLexer from '../src/grammar/FirebaseRulesLexer.js';
import FirebaseRulesParser from '../src/grammar/FirebaseRulesParser.js';

const src = readFileSync(process.argv[2]!, 'utf8');
const parser: any = new FirebaseRulesParser(new CommonTokenStream(new FirebaseRulesLexer(new CharStream(src))));

function dump(node: any, depth: number, prefix = ''): void {
  const pad = '  '.repeat(depth);
  if (node.symbol) return console.log(`${pad}${prefix}'${node.getText()}'`);
  const label = node.constructor.name.replace(/Context$/, '');
  if (node.getChildCount() === 1) return dump(node.getChild(0), depth, `${prefix}${label} > `);
  console.log(`${pad}${prefix}${label}`);
  for (let i = 0; i < node.getChildCount(); i++) dump(node.getChild(i), depth + 1);
}
dump(parser.ruleset(), 0);
