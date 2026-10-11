// Read-only formatter bridge: print before/after for the editor's diff tool.
import fs from 'node:fs/promises';
import prettier from 'prettier';
const file = process.argv[2];
const before = await fs.readFile(file, 'utf8');
const options = await prettier.resolveConfig(file);
const after = await prettier.format(before, { ...options, filepath:file });
process.stdout.write(JSON.stringify({ file, before, after }));
