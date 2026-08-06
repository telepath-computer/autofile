import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * This package sits on the model and nothing else here: the storage format is
 * visible in it, and a package above — the CLI, a server — is written against
 * the vault interface rather than against markdown. The build does not say so
 * on its own, since once another package has been built, importing from it
 * resolves and type-checks clean. So the direction is checked over the sources,
 * where an import that should not exist is a failing test rather than a
 * convention.
 */
describe('the vault-markdown package', () => {
  it('imports no @autofile package but core', async () => {
    const src = fileURLToPath(new URL('.', import.meta.url));
    const entries = await readdir(src, { recursive: true, withFileTypes: true });
    const sources = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
    // Reading nothing would pass, and pass forever.
    assert.ok(sources.length > 0, `found no sources under ${src}`);

    // `from '…'`, a bare `import '…'`, `import('…')` and `require('…')` all.
    const imports = /(?:from|import|require)\s*\(?\s*['"](@autofile\/[^'"]+)['"]/g;

    const offenders: string[] = [];
    for (const source of sources) {
      const path = join(source.parentPath, source.name);
      const text = await readFile(path, 'utf8');
      for (const [, specifier] of text.matchAll(imports)) {
        if (specifier === '@autofile/core') continue;
        offenders.push(`${relative(src, path)} imports ${specifier}`);
      }
    }

    assert.deepEqual(offenders, []);
  });
});
