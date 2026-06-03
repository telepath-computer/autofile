const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child_process = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const templateDir = path.join(repo, 'skills', 'vault', 'templates');
const exampleDir = path.join(repo, 'example');

function run(command, options = {}) {
  return child_process.execFileSync(command[0], command.slice(1), {
    cwd: options.cwd || repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('example vault validates with fslint', () => {
  run(['fslint'], { cwd: exampleDir });
});

test('starter template can initialize a minimal vault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-template-'));
  fs.cpSync(path.join(templateDir, 'VAULT.md'), path.join(dir, 'VAULT.md'));
  fs.cpSync(path.join(templateDir, '.fslint.yml'), path.join(dir, '.fslint.yml'));
  for (const folder of ['assets', 'references', 'contacts', 'places', 'events', 'misc', 'special']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'special', 'now.md'), `---\ncreated: "2026-06-03"\nupdated: "2026-06-03"\n---\n\n# Now\n`);
  run(['fslint'], { cwd: dir });
});

test('template and example use VAULT.md as root spec', () => {
  assert.ok(fs.existsSync(path.join(templateDir, 'VAULT.md')));
  assert.ok(fs.existsSync(path.join(exampleDir, 'VAULT.md')));
  assert.equal(fs.existsSync(path.join(exampleDir, 'README.md')), false);
});
