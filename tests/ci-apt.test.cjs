'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configureCiApt, rewriteAptFile } = require('../scripts/configure-ci-apt.cjs');
const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted' };

test('CI mirror list changes only exact Azure archive URI and preserves priority, official security and comments', () => {
    const original = '# http://azure.archive.ubuntu.com/ubuntu/\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
    const expected = original.replace('\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1', '\nhttps://archive.ubuntu.com/ubuntu/\tpriority:1');
    assert.equal(rewriteAptFile(original, 'mirrors'), expected);
    assert.equal(rewriteAptFile(expected, 'mirrors'), expected);
});
test('CI deb822 URI fields support continuations while preserving signing policy, suite and unrelated source bytes', () => {
    const original = 'Types: deb deb-src\nURIs: http://azure.archive.ubuntu.com/ubuntu/\n https://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: https://security.ubuntu.com/ubuntu/\nSuites: noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
    const updated = rewriteAptFile(original, 'deb822');
    assert.equal(updated, original.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/').replace('https://azure.archive.ubuntu.com/ubuntu\n', 'https://archive.ubuntu.com/ubuntu/\n'));
    assert.ok(!/Trusted:|Allow-Insecure:/.test(updated));
    assert.equal(rewriteAptFile(updated, 'deb822'), updated);
});
test('CI legacy source options are retained and similarly named hosts, paths and disabled sources stay untouched', () => {
    const original = 'deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ noble main\n# deb http://azure.archive.ubuntu.com/ubuntu/ noble universe\ndeb https://azureXarchiveXubuntuXcom/ubuntu/ noble main\ndeb https://azure.archive.ubuntu.com/ubuntu-other/ noble main\ndeb https://azure.archive.ubuntu.com.evil.example/ubuntu/ noble main\n';
    assert.equal(rewriteAptFile(original, 'list'), original.replace('] http://azure.archive.ubuntu.com/ubuntu/', '] https://archive.ubuntu.com/ubuntu/'));
    assert.equal(rewriteAptFile('Signed-By: http://azure.archive.ubuntu.com/ubuntu/\n', 'deb822'), 'Signed-By: http://azure.archive.ubuntu.com/ubuntu/\n');
    assert.throws(() => rewriteAptFile(original, 'unknown'));
});
function fakeIo(files) {
    const reads = [], writes = [];
    return { reads, writes, async readFile(file) { reads.push(file); if (file === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\n'; if (!(file in files)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files[file]; },
        async lstat(file) { if (!(file in files)) throw Object.assign(new Error(), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false }; },
        async writeFile(file, content) { writes.push({ file, content }); } };
}
test('CI APT configuration refuses local, self-hosted, non-Linux and non-root execution before filesystem access', async () => {
    for (const [env, uid] of [[{}, 0], [{ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, 0], [{ ...hosted, RUNNER_OS: 'macOS' }, 0], [hosted, 1000]]) {
        const io = fakeIo({}); await assert.rejects(configureCiApt({ env, uid, io })); assert.deepEqual(io.reads, []); assert.deepEqual(io.writes, []);
    }
});
test('CI APT configuration changes only fixed supported files and refuses non-Ubuntu before writes', async () => {
    const io = fakeIo({ '/etc/apt/apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n' });
    const report = await configureCiApt({ env: hosted, uid: 0, io }); assert.equal(report.passed, true); assert.equal(report.changed, true);
    assert.deepEqual(io.writes, [{ file: '/etc/apt/apt-mirrors.txt', content: 'https://archive.ubuntu.com/ubuntu/\tpriority:1\n' }]);
    const wrongOs = fakeIo({}); wrongOs.readFile = async () => 'ID=debian\n';
    await assert.rejects(configureCiApt({ env: hosted, uid: 0, io: wrongOs })); assert.deepEqual(wrongOs.writes, []);
});
test('CI APT configuration refuses symlinks and unexpected layouts rather than weakening signature checks', async () => {
    const io = fakeIo({ '/etc/apt/apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu/\n' });
    io.lstat = async () => ({ isFile: () => true, isSymbolicLink: () => true });
    await assert.rejects(configureCiApt({ env: hosted, uid: 0, io })); assert.deepEqual(io.writes, []);
    await assert.rejects(configureCiApt({ env: hosted, uid: 0, io: fakeIo({}) }));
});
