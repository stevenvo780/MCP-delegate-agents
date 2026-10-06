import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile as writeFixture } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { readFiles, writeFile } from './file-access.js';

const INSIDE = 'synthetic inside fixture\n';
const OUTSIDE = 'synthetic outside fixture; preserve this content\n';
const SIBLING = 'synthetic sibling fixture; preserve this content\n';

async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(tmpdir(), 'mcp-file-access-test-'));
  t.after(async () => { await rm(temp, { recursive: true, force: true }); });
  const root = path.join(temp, 'repo');
  const outside = path.join(temp, 'elsewhere');
  const sibling = path.join(temp, 'repo-other');
  await Promise.all([
    mkdir(path.join(root, 'sub'), { recursive: true }),
    mkdir(path.join(root, 'deep', 'child'), { recursive: true }),
    mkdir(outside),
    mkdir(sibling),
  ]);
  await Promise.all([
    writeFixture(path.join(root, 'inside.txt'), INSIDE),
    writeFixture(path.join(root, 'sub', 'nested.txt'), 'synthetic nested fixture\n'),
    writeFixture(path.join(outside, 'protected.txt'), OUTSIDE),
    writeFixture(path.join(sibling, 'protected.txt'), SIBLING),
    writeFixture(path.join(root, 'ordinary-file'), 'synthetic parent file\n'),
  ]);
  await Promise.all([
    symlink(outside, path.join(root, 'external-dir'), 'dir'),
    symlink(sibling, path.join(root, 'sibling-dir'), 'dir'),
    symlink(path.join(outside, 'protected.txt'), path.join(root, 'external-file'), 'file'),
    symlink(path.join(root, 'sub'), path.join(root, 'internal-dir'), 'dir'),
    symlink(path.join(root, 'inside.txt'), path.join(root, 'internal-file'), 'file'),
    symlink(path.join(root, 'inside.txt'), path.join(outside, 'internal-alias.txt'), 'file'),
    symlink(path.join(root, 'absent-target'), path.join(root, 'dangling'), 'file'),
    symlink(path.join(outside, 'absent-target'), path.join(root, 'dangling-external'), 'file'),
    symlink('dangling-chain-b', path.join(root, 'dangling-chain-a'), 'file'),
    symlink('chain-target.txt', path.join(root, 'dangling-chain-b'), 'file'),
    symlink(path.join(root, 'deep', 'child'), path.join(root, 'deep-dir-link'), 'dir'),
    symlink('deep-dir-link/../new.txt', path.join(root, 'literal-internal'), 'file'),
    symlink('external-dir/../newfile', path.join(root, 'literal-external'), 'file'),
    symlink(path.join(root, 'missing-parent', 'new.txt'), path.join(root, 'dangling-missing-parent'), 'file'),
    symlink('loop', path.join(root, 'loop'), 'file'),
    symlink(root, path.join(temp, 'trusted-root'), 'dir'),
  ]);
  return { temp, root, outside, sibling, trustedRoot: path.join(temp, 'trusted-root') };
}

function context(input: string, contents: string) {
  return `\n--- FILE: ${input} ---\n${contents}\n`;
}

async function assertAbsent(target: string) {
  await assert.rejects(access(target, constants.F_OK), (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  });
}

async function assertExternalUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(await readFile(path.join(f.outside, 'protected.txt'), 'utf8'), OUTSIDE);
  assert.equal(await readFile(path.join(f.sibling, 'protected.txt'), 'utf8'), SIBLING);
}

test('reads omit traversal and absolute external paths while keeping valid context', async (t) => {
  const f = await fixture(t);
  const inputs = [
    '../repo-other/protected.txt',
    path.join(f.sibling, 'protected.txt'),
    path.join(f.outside, 'protected.txt'),
  ];
  for (const input of inputs) {
    assert.equal(await readFiles(f.root, [input]), '', input);
  }
  assert.equal(await readFiles(f.root, [...inputs, 'inside.txt']), context('inside.txt', INSIDE));
  await assertExternalUnchanged(f);
});

test('writes reject traversal and absolute external paths with no external changes', async (t) => {
  const f = await fixture(t);
  const inputs = [
    '../repo-other/protected.txt',
    path.join(f.sibling, 'protected.txt'),
    path.join(f.outside, 'protected.txt'),
    '../repo-other/new-parent/new.txt',
    path.join(f.outside, 'new-parent', 'new.txt'),
  ];
  for (const input of inputs) {
    assert.equal(await writeFile(f.root, input, 'must never be written'), `Error: Access denied to ${input}`, input);
    await assertExternalUnchanged(f);
  }
  await assertAbsent(path.join(f.outside, 'new-parent'));
  await assertAbsent(path.join(f.sibling, 'new-parent'));
});

test('an absolute external symlink spelling is denied even when its target is internal', async (t) => {
  const f = await fixture(t);
  const externalAlias = path.join(f.outside, 'internal-alias.txt');
  assert.equal(await readFile(externalAlias, 'utf8'), INSIDE);
  assert.equal(await readFiles(f.root, [externalAlias]), '');
  assert.equal(await readFiles(f.root, [externalAlias, 'inside.txt']), context('inside.txt', INSIDE));
  assert.equal(await writeFile(f.root, externalAlias, 'must never be written'), `Error: Access denied to ${externalAlias}`);
  assert.equal(await readFile(path.join(f.root, 'inside.txt'), 'utf8'), INSIDE);
  await assertExternalUnchanged(f);
});

test('reads omit directory and file symlinks that point outside the root', async (t) => {
  const f = await fixture(t);
  const inputs = ['external-dir/protected.txt', 'sibling-dir/protected.txt', 'external-file'];
  for (const input of inputs) {
    assert.equal(await readFiles(f.root, [input]), '', input);
  }
  assert.equal(await readFiles(f.root, ['inside.txt', ...inputs]), context('inside.txt', INSIDE));
  await assertExternalUnchanged(f);
});

test('writes reject external symlinks including an existing parent followed by a new suffix', async (t) => {
  const f = await fixture(t);
  const inputs = [
    'external-dir/protected.txt',
    'sibling-dir/protected.txt',
    'external-file',
    'external-dir/new-parent/deeper/new.txt',
    'sibling-dir/new-parent/deeper/new.txt',
  ];
  for (const input of inputs) {
    assert.equal(await writeFile(f.root, input, 'must never be written'), `Error: Access denied to ${input}`, input);
    await assertExternalUnchanged(f);
  }
  await assertAbsent(path.join(f.outside, 'new-parent'));
  await assertAbsent(path.join(f.sibling, 'new-parent'));
});

test('valid relative and absolute reads retain requested labels and ordering', async (t) => {
  const f = await fixture(t);
  const absolute = path.join(f.root, 'inside.txt');
  assert.equal(
    await readFiles(f.root, ['inside.txt', absolute, 'sub/../inside.txt', 'missing.txt']),
    context('inside.txt', INSIDE) + context(absolute, INSIDE) + context('sub/../inside.txt', INSIDE),
  );
});

test('valid writes allow internal normalization, new ancestors, absolute paths and ..cache names', async (t) => {
  const f = await fixture(t);
  const cases: Array<[string, string]> = [
    ['inside.txt', path.join(f.root, 'inside.txt')],
    ['sub/../normalized.txt', path.join(f.root, 'normalized.txt')],
    ['new-parent/deeper/new.txt', path.join(f.root, 'new-parent', 'deeper', 'new.txt')],
    ['..cache/cache.txt', path.join(f.root, '..cache', 'cache.txt')],
    [path.join(f.root, 'absolute.txt'), path.join(f.root, 'absolute.txt')],
  ];
  for (const [input, expectedTarget] of cases) {
    const contents = `synthetic valid write ${input}\n`;
    assert.equal(await writeFile(f.root, input, contents), `Successfully wrote: ${input}`, input);
    assert.equal(await readFile(expectedTarget, 'utf8'), contents, input);
    assert.equal(await readFiles(f.root, [input]), context(input, contents), input);
  }
  await assertExternalUnchanged(f);
});

test('internal file and directory symlinks remain usable for reads and writes', async (t) => {
  const f = await fixture(t);
  assert.equal(await readFiles(f.root, ['internal-file']), context('internal-file', INSIDE));
  assert.equal(await readFiles(f.root, ['internal-dir/nested.txt']), context('internal-dir/nested.txt', 'synthetic nested fixture\n'));
  const cases: Array<[string, string]> = [
    ['internal-file', path.join(f.root, 'inside.txt')],
    ['internal-dir/nested.txt', path.join(f.root, 'sub', 'nested.txt')],
    ['internal-dir/new-parent/deeper/new.txt', path.join(f.root, 'sub', 'new-parent', 'deeper', 'new.txt')],
  ];
  for (const [input, expectedTarget] of cases) {
    const contents = `synthetic symlink write ${input}\n`;
    assert.equal(await writeFile(f.root, input, contents), `Successfully wrote: ${input}`, input);
    assert.equal(await readFile(expectedTarget, 'utf8'), contents, input);
  }
  await assertExternalUnchanged(f);
});

test('a trusted symlink root supports valid paths and still rejects external paths', async (t) => {
  const f = await fixture(t);
  const absolute = path.join(f.trustedRoot, 'inside.txt');
  assert.equal(await readFiles(f.trustedRoot, ['inside.txt', absolute]), context('inside.txt', INSIDE) + context(absolute, INSIDE));
  for (const input of ['new-parent/new.txt', path.join(f.trustedRoot, 'absolute.txt')]) {
    assert.equal(await writeFile(f.trustedRoot, input, 'synthetic trusted root write\n'), `Successfully wrote: ${input}`, input);
  }
  assert.equal(await readFile(path.join(f.root, 'new-parent', 'new.txt'), 'utf8'), 'synthetic trusted root write\n');
  assert.equal(await readFile(path.join(f.root, 'absolute.txt'), 'utf8'), 'synthetic trusted root write\n');
  for (const input of ['../repo-other/protected.txt', 'external-file', 'external-dir/new-parent/new.txt']) {
    assert.equal(await readFiles(f.trustedRoot, [input]), '', input);
    assert.equal(await writeFile(f.trustedRoot, input, 'must never be written'), `Error: Access denied to ${input}`, input);
  }
  await assertExternalUnchanged(f);
  await assertAbsent(path.join(f.outside, 'new-parent'));
});

test('writes can create a trusted root that does not exist yet', async (t) => {
  const f = await fixture(t);
  const futureRoot = path.join(f.temp, 'future-root');
  await assertAbsent(futureRoot);
  assert.equal(await readFiles(futureRoot, ['missing.txt']), '');
  for (const input of ['../repo-other/protected.txt', path.join(f.outside, 'protected.txt')]) {
    assert.equal(await writeFile(futureRoot, input, 'must never be written'), `Error: Access denied to ${input}`, input);
  }
  await assertAbsent(futureRoot);
  const relative = 'new-parent/deeper/new.txt';
  const absolute = path.join(futureRoot, 'absolute.txt');
  for (const input of [relative, absolute]) {
    const contents = `synthetic future root write ${input}\n`;
    assert.equal(await writeFile(futureRoot, input, contents), `Successfully wrote: ${input}`, input);
    assert.equal(await readFiles(futureRoot, [input]), context(input, contents), input);
  }
  assert.equal(await readFile(path.join(futureRoot, relative), 'utf8'), `synthetic future root write ${relative}\n`);
  assert.equal(await readFile(absolute, 'utf8'), `synthetic future root write ${absolute}\n`);
  await assertExternalUnchanged(f);
});

test('dangling internal leaf symlinks can create their targets when the real parent exists', async (t) => {
  const f = await fixture(t);
  assert.equal(await readFiles(f.root, ['dangling']), '');
  const child = 'dangling/new.txt';
  assert.equal(await readFiles(f.root, [child]), '');
  const childResult = await writeFile(f.root, child, 'must never be written');
  assert.ok(childResult.startsWith(`Error writing ${child}: `), childResult);
  await assertAbsent(path.join(f.root, 'absent-target'));
  const contents = 'synthetic dangling internal leaf write\n';
  assert.equal(await writeFile(f.root, 'dangling', contents), 'Successfully wrote: dangling');
  assert.equal(await readFile(path.join(f.root, 'absent-target'), 'utf8'), contents);
  assert.equal(await readFiles(f.root, ['dangling']), context('dangling', contents));
  await assertExternalUnchanged(f);
});

test('a chain of dangling internal leaf symlinks can create its final target', async (t) => {
  const f = await fixture(t);
  const input = 'dangling-chain-a';
  assert.equal(await readFiles(f.root, [input, 'dangling-chain-b']), '');
  const contents = 'synthetic dangling chain write\n';
  assert.equal(await writeFile(f.root, input, contents), `Successfully wrote: ${input}`);
  assert.equal(await readFile(path.join(f.root, 'chain-target.txt'), 'utf8'), contents);
  assert.equal(
    await readFiles(f.root, [input, 'dangling-chain-b']),
    context(input, contents) + context('dangling-chain-b', contents),
  );
  await assertExternalUnchanged(f);
});

test('a literal symlink target with .. after an internal directory symlink uses its real parent', async (t) => {
  const f = await fixture(t);
  const input = 'literal-internal';
  const contents = 'synthetic physical parent write\n';
  assert.equal(await readFiles(f.root, [input]), '');
  assert.equal(await writeFile(f.root, input, contents), `Successfully wrote: ${input}`);
  assert.equal(await readFile(path.join(f.root, 'deep', 'new.txt'), 'utf8'), contents);
  await assertAbsent(path.join(f.root, 'new.txt'));
  assert.equal(await readFiles(f.root, [input]), context(input, contents));
  await assertExternalUnchanged(f);
});

test('a literal symlink target with .. after an external directory symlink is denied', async (t) => {
  const f = await fixture(t);
  const input = 'literal-external';
  assert.equal(await readFiles(f.root, [input]), '');
  assert.equal(await writeFile(f.root, input, 'must never be written'), `Error: Access denied to ${input}`);
  await assertAbsent(path.join(f.temp, 'newfile'));
  await assertAbsent(path.join(f.root, 'newfile'));
  await assertExternalUnchanged(f);
});

test('dangling external leaf symlinks are denied without creating their targets', async (t) => {
  const f = await fixture(t);
  const absentExternalTarget = path.join(f.outside, 'absent-target');
  const leaf = 'dangling-external';
  assert.equal(await readFiles(f.root, [leaf]), '');
  assert.equal(await writeFile(f.root, leaf, 'must never be written'), `Error: Access denied to ${leaf}`);
  await assertAbsent(absentExternalTarget);
  const child = 'dangling-external/new.txt';
  assert.equal(await readFiles(f.root, [child]), '');
  const childResult = await writeFile(f.root, child, 'must never be written');
  assert.ok(childResult.startsWith(`Error writing ${child}: `), childResult);
  await assertAbsent(absentExternalTarget);
  assert.equal(await readFile(path.join(f.root, 'inside.txt'), 'utf8'), INSIDE);
  await assertExternalUnchanged(f);
});

test('a trailing slash in a dangling symlink target keeps directory error semantics', async (t) => {
  const f = await fixture(t);
  const input = 'dangling-directory';
  await symlink('missing-directory/', path.join(f.root, input), 'dir');
  assert.equal(await readFiles(f.root, [input]), '');
  const result = await writeFile(f.root, input, 'must never be written');
  assert.ok(result.startsWith(`Error writing ${input}: `), result);
  if (process.platform === 'linux') assert.match(result, /\bEISDIR\b/);
  await assertAbsent(path.join(f.root, 'missing-directory'));
  assert.equal(await readFiles(f.root, [input]), '');
  await assertExternalUnchanged(f);
});

test('a dangling leaf with a missing target parent retains ENOENT and does not create that parent', async (t) => {
  const f = await fixture(t);
  const input = 'dangling-missing-parent';
  assert.equal(await readFiles(f.root, [input]), '');
  const result = await writeFile(f.root, input, 'must never be written');
  assert.ok(result.startsWith(`Error writing ${input}: `), result);
  assert.match(result, /\bENOENT\b/);
  await assertAbsent(path.join(f.root, 'missing-parent'));
  await assertExternalUnchanged(f);
});

test('ordinary filesystem errors keep write error status and disappear from read context', async (t) => {
  const f = await fixture(t);
  const cases: Array<[string, string]> = [
    ['ordinary-file/new.txt', process.platform === 'linux' ? 'EEXIST' : ''],
    ['loop', 'ELOOP'],
    ['loop/new.txt', 'ELOOP'],
  ];
  for (const [input, errno] of cases) {
    assert.equal(await readFiles(f.root, [input]), '', input);
    const result = await writeFile(f.root, input, 'must never be written');
    assert.ok(result.startsWith(`Error writing ${input}: `), result);
    if (errno) assert.match(result, new RegExp(`\\b${errno}\\b`), input);
  }
  assert.equal(await readFiles(f.root, ['dangling', 'ordinary-file/new.txt', 'loop', 'inside.txt']), context('inside.txt', INSIDE));
  await assertAbsent(path.join(f.root, 'absent-target'));
  assert.equal(await readFile(path.join(f.root, 'ordinary-file'), 'utf8'), 'synthetic parent file\n');
  await assertExternalUnchanged(f);
});
