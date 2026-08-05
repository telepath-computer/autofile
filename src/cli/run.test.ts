import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { run } from './run.ts';

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function vault(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'autofile-run-'));
  roots.push(root);
  await writeFile(join(root, 'autofile.yml'), config);
  return root;
}

/**
 * Whether the schema validator has been loaded into this process. Ajv is
 * CommonJS, so importing it — statically or not — leaves its files in the
 * require cache, which is the only place a module already loaded shows up.
 */
const require = createRequire(import.meta.url);
function loadedAjv(): boolean {
  return Object.keys(require.cache).some((file) => file.includes('/node_modules/ajv'));
}

describe('run', () => {
  it('answers --help without loading the schema validator', async () => {
    // The commands are a static registry, so every command's imports are this
    // module's imports, and a binary that only prints its usage would otherwise
    // pay to load and compile a schema validator it never runs. Asserting a
    // vault run does load it is what keeps the probe honest.
    const root = await vault('paths:\n  /contacts: {}\n');
    assert.equal(loadedAjv(), false, 'the schema validator was loaded at import');

    await run(['--help'], root);
    assert.equal(loadedAjv(), false, 'printing usage loaded the schema validator');

    await run(['validate'], root);
    assert.equal(loadedAjv(), true, 'checking a vault did not load the schema validator');
  });
});
