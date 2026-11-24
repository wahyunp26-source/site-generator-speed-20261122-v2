// Driver for the site-generator entry: reads every case from the input directory,
// answers each one alone with run() from solve.js, and writes the answers out.
// Runs under node with type stripping; no flags or dependencies beyond node itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for the whole run, before solve.js loads.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; input: unknown };

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const answers: unknown[] = [];
for (const c of cases) {
  answers.push(run(c.input));
}
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
