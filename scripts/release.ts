import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^v?(\d+\.\d+\.\d+)$/;

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) {
  fail('Usage: pnpm release <version>  (e.g. 0.1.1 or v0.1.1)');
}

const match = SEMVER.exec(raw);
if (!match) {
  fail(`Invalid version "${raw}". Expected semver like 0.1.1 or v0.1.1.`);
}

const version = match[1]!;
const tag = `v${version}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(root, 'package.json');

const branch = run('git', ['branch', '--show-current']);
if (branch !== 'main') {
  fail(`Must release from main (current branch: ${branch || '(detached)'}).`);
}

const dirty = run('git', ['status', '--porcelain']);
if (dirty) {
  fail('Working tree is dirty. Commit or stash changes before releasing.');
}

const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  version: string;
  [key: string]: unknown;
};

if (pkg.version === version) {
  fail(`package.json is already at ${version}.`);
}

pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

run('git', ['add', 'package.json']);
run('git', ['commit', '-m', `Release ${tag}`]);
// Must be annotated: `git push --follow-tags` silently ignores lightweight
// tags, which pushes the version bump without ever triggering the release.
run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
run('git', ['push', 'origin', 'main', '--follow-tags']);

console.log(`Released ${tag}. GitHub Actions will build, publish the GitHub Release, and submit to the Chrome Web Store.`);
