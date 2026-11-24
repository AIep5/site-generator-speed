import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { run } from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const answers = [];
for (let i = 0; i < cases.length; i++) {
  answers.push(run(cases[i].input));
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/answers.json', JSON.stringify(answers));
