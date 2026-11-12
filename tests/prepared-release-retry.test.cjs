'use strict';
// Existing release contents are read-only. These are native temporary-filesystem
// and production-shell fixtures, not actual systemd or production acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyPreparedRelease } = require('../scripts/verify-prepared-release.cjs');
const nextRevision = 'aaaaaaaaaaaaaaaa', oldRevision = '1111111111111111';
async function snapshot(root) {
    const entries = [];
    async function walk(name) {
        const file = path.join(root, name), info = await fs.lstat(file, { bigint: true });
        const stamp = ['dev','ino','mode','uid','gid','size','nlink','mtimeNs','ctimeNs'].map(key => String(info[key]));
        const body = info.isFile() ? crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') : info.isSymbolicLink() ? await fs.readlink(file) : null;
        entries.push([name, stamp, body]);
        if (info.isDirectory()) for (const entry of (await fs.readdir(file)).sort()) await walk(path.join(name, entry));
    }
    await walk(''); return entries;
}
async function runtimeFixture(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-prepared-release-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const sourceRoot = path.join(temp, 'checkout'), installationRoot = path.join(temp, 'installation');
    const releaseRoot = path.join(installationRoot, 'releases', nextRevision);
    const files = {
        'dist/build.json': JSON.stringify({ revision: nextRevision }), 'dist/index.html': '<title>fresh</title>',
        'dist/scripts/app.js': '// locally built code', 'server/index.js': '// signaling only',
        'server/package.json': '{}', 'server/package-lock.json': '{}',
        'server/node_modules/.package-lock.json': '{}', 'server/node_modules/ws/index.js': '// locked dependency',
        'server/node_modules/ws/LICENSE': 'test license'
    };
    for (const [name, body] of Object.entries(files)) {
        const file = path.join(sourceRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body, { mode: 0o644 });
    }
    await fs.mkdir(path.join(sourceRoot, 'server/node_modules/ws/empty'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'server/PRIVATE.env'), 'PRIVATE_PREPARED_RELEASE_TOKEN');
    await fs.mkdir(path.join(releaseRoot, 'server'), { recursive: true });
    await fs.cp(path.join(sourceRoot, 'dist'), path.join(releaseRoot, 'dist'), { recursive: true });
    await fs.cp(path.join(sourceRoot, 'server/node_modules'), path.join(releaseRoot, 'server/node_modules'), { recursive: true });
    for (const name of ['index.js','package.json','package-lock.json']) await fs.copyFile(path.join(sourceRoot, 'server', name), path.join(releaseRoot, 'server', name));
    async function normalize(directory) {
        await fs.chmod(directory, 0o755);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await normalize(file); else await fs.chmod(file, 0o644);
        }
    }
    await normalize(installationRoot);
    return { temp, sourceRoot, installationRoot, releaseRoot, files,
        verify: () => verifyPreparedRelease({ sourceRoot, installationRoot, releaseRoot, revision: nextRevision }) };
}

test('exact prepared runtime includes every dependency and empty directory without rewriting identity, mode, ownership or contents', async t => {
    const f = await runtimeFixture(t), before = await snapshot(f.releaseRoot), result = await f.verify();
    assert.deepEqual(result, { files: Object.keys(f.files).length, bytes: Object.values(f.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0), revision: nextRevision, readOnly: true });
    // Kernel read access-time accounting is deliberately excluded from snapshot.
    assert.deepEqual(await snapshot(f.releaseRoot), before);
    await assert.rejects(fs.lstat(path.join(f.releaseRoot, 'server/PRIVATE.env')), { code: 'ENOENT' });
});

test('partial, different, unexpected and missing-on-both-sides prepared files are rejected without repair', async t => {
    for (const kind of ['partial','different','unexpected','both-metadata-missing','both-entry-missing']) {
        const f = await runtimeFixture(t);
        if (kind === 'partial') await fs.rm(path.join(f.releaseRoot, 'server/node_modules/ws/LICENSE'));
        else if (kind === 'different') await fs.writeFile(path.join(f.releaseRoot, 'server/node_modules/ws/index.js'), '// corrupted bytes');
        else if (kind === 'unexpected') await fs.writeFile(path.join(f.releaseRoot, 'server/untracked-private.txt'), 'PRIVATE_PREPARED_RELEASE_TOKEN');
        else for (const root of [f.sourceRoot, f.releaseRoot]) await fs.rm(path.join(root, kind === 'both-metadata-missing' ? 'dist/build.json' : 'dist/index.html'));
        const before = await snapshot(f.releaseRoot); await assert.rejects(f.verify(), { code: 'mismatch' });
        assert.deepEqual(await snapshot(f.releaseRoot), before, kind + ' must remain untouched for diagnosis');
    }
});

test('symlinks, hardlinks, FIFOs and writable prepared modes are rejected without following or normalizing them', async t => {
    for (const kind of ['symlink','hardlink','fifo','file-mode','directory-mode','ancestor-mode']) {
        const f = await runtimeFixture(t), target = path.join(f.releaseRoot, 'server/node_modules/ws/index.js');
        if (kind === 'symlink') { await fs.rm(target); await fs.symlink(path.join(f.sourceRoot, 'server/index.js'), target); }
        else if (kind === 'hardlink') await fs.link(target, path.join(f.temp, 'outside-hardlink'));
        else if (kind === 'fifo') { await fs.rm(target); assert.equal(spawnSync('mkfifo', [target]).status, 0); }
        else if (kind === 'file-mode') await fs.chmod(target, 0o666);
        else if (kind === 'directory-mode') await fs.chmod(path.dirname(target), 0o777);
        else await fs.chmod(f.installationRoot, 0o777);
        const before = await snapshot(f.releaseRoot); await assert.rejects(f.verify(), { code: 'unsafe' });
        assert.deepEqual(await snapshot(f.releaseRoot), before);
    }
});

test('a symlinked installation ancestor and a wrong fresh build revision are rejected', async t => {
    const f = await runtimeFixture(t), alias = path.join(f.temp, 'alias');
    await fs.symlink(f.installationRoot, alias);
    await assert.rejects(verifyPreparedRelease({ sourceRoot: f.sourceRoot, installationRoot: alias, releaseRoot: path.join(alias, 'releases', nextRevision), revision: nextRevision }), { code: 'unsafe' });
    for (const root of [f.sourceRoot, f.releaseRoot]) await fs.writeFile(path.join(root, 'dist/build.json'), JSON.stringify({ revision: oldRevision }));
    await assert.rejects(f.verify(), { code: 'mismatch' });
});

test('the local verifier CLI rejects extra empty arguments with a fixed error and no private paths or contents', async t => {
    const f = await runtimeFixture(t);
    const result = spawnSync(process.execPath, [path.resolve('scripts/verify-prepared-release.cjs'), f.releaseRoot, f.installationRoot, nextRevision, ''],
        { cwd: f.sourceRoot, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Invalid prepared release validation arguments/);
    assert.ok(!result.stderr.includes(f.temp) && !result.stderr.includes('PRIVATE_PREPARED_RELEASE_TOKEN'));
    assert.equal(result.stdout, '');
});

test('a file changed after it was hashed is rejected by the final inventory fence with every opened handle closed', async t => {
    const f = await runtimeFixture(t), originalOpen = fs.open; let changed = false, opened = 0, closed = 0;
    fs.open = async (...args) => {
        const handle = await originalOpen(...args); opened++;
        return new Proxy(handle, { get(target, name) {
            if (name === 'read') return async (...readArgs) => {
                const result = await target.read(...readArgs);
                if (!changed && args[0] === path.join(f.sourceRoot, 'server/node_modules/ws/index.js')) {
                    changed = true; await fs.writeFile(path.join(f.releaseRoot, 'dist/index.html'), '<title>changed while another file is read</title>');
                }
                return result;
            };
            if (name === 'close') return async () => { closed++; return target.close(); };
            const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
        } });
    };
    try { await assert.rejects(f.verify(), { code: 'changed' }); assert.equal(changed, true); assert.ok(opened > 0); assert.equal(closed, opened); }
    finally { fs.open = originalOpen; }
});

async function deployFixture(t, { failure = '', current = 'absent' } = {}) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-deploy-transaction-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, 'installation'), bin = path.join(temp, 'bin'), etc = path.join(temp, 'etc');
    for (const dir of [bin, path.join(root, 'releases'), path.join(etc, 'nginx/conf.d'),
        path.join(etc, 'systemd/system'), path.join(temp, 'server/node_modules'), path.join(temp, 'dist'),
        path.join(temp, 'deployment'), path.join(temp, 'scripts')]) await fs.mkdir(dir, { recursive: true });
    const log = path.join(temp, 'commands.jsonl');
    const record = `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),tool=path.basename(process.argv[1]);fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool,args})+'\\n');`;
    const command = async (name, body) => fs.writeFile(path.join(bin, name), '#!/usr/bin/env node\n' + record + body + '\n', { mode: 0o755 });
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    await command('npm', '');
    // Drain the entire public-key pipe so pipefail observes the actual command
    // status rather than a synthetic SIGPIPE from an early-exiting consumer.
    await command('openssl', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('fixture-public-key\\n'));`);
    await command('systemctl', `if(args[0]==='is-active'){if(args.includes('snapdrop'))process.exit(3);const active=fs.existsSync(process.env.TEST_SERVICE_STATE);process.stdout.write(active?'active\\n':'inactive\\n');process.exit(active?0:3);}if(args[0]==='is-enabled'){process.stdout.write('disabled\\n');process.exit(1);}if(args[0]==='restart'){if(process.env.TEST_FAIL==='restart')process.exit(1);fs.writeFileSync(process.env.TEST_SERVICE_STATE,'active');}if(args[0]==='stop')fs.rmSync(process.env.TEST_SERVICE_STATE,{force:true});`);
    await command('nginx', `if(args[0]==='-t'&&process.env.TEST_FAIL==='nginx')process.exit(1);`);
    await command('id', ''); // Never create or modify a host service account.
    await command('useradd', `throw Error('unexpected fixture account creation');`);
    await command('chown', '');
    await command('install', `for(const name of args)if(path.isAbsolute(name))fs.mkdirSync(name,{recursive:true,mode:0o755});`);
    for (const [name, body] of Object.entries({
        'server/index.js': '// fixture entry\n', 'server/package.json': '{}\n', 'server/package-lock.json': '{}\n',
        'dist/build.json': JSON.stringify({ revision: nextRevision }), 'dist/index.html': '<title>fixture</title>',
        'deployment/zeydrop.service': 'ExecStart=@NODE@\n', 'deployment/nginx.conf': 'server_name @DOMAIN@;\n',
        'scripts/check-signaling.cjs': 'process.exit(0);\n'
    })) await fs.writeFile(path.join(temp, name), body);
    const source = await fs.readFile('deploy.sh', 'utf8');
    const guard = "if [[ ${EUID} -ne 0 ]]; then echo 'Run as root on the deployment host.' >&2; exit 1; fi";
    assert.ok(source.includes(guard));
    await fs.copyFile('scripts/verify-prepared-release.cjs', path.join(temp, 'scripts/verify-prepared-release.cjs'));
    const isolated = source.replace(guard, '# Disposable non-root transaction fixture')
        .replaceAll('/opt/zeydrop', root).replaceAll('/etc/', etc + '/');
    await fs.writeFile(path.join(temp, 'deploy.sh'), isolated);
    const certificate = path.join(temp, 'certificate.pem'); await fs.writeFile(certificate, 'fixture certificate');
    const old = path.join(root, 'releases', oldRevision), active = path.join(root, 'current');
    const makeRelease = async directory => {
        await fs.mkdir(path.join(directory, 'dist'), { recursive: true }); await fs.mkdir(path.join(directory, 'server'));
        await fs.writeFile(path.join(directory, 'dist/build.json'), JSON.stringify({ revision: oldRevision }));
        await fs.writeFile(path.join(directory, 'server/index.js'), '// original release');
    };
    if (current === 'valid') { await makeRelease(old); await fs.symlink(old, active); }
    else if (current === 'dangling') await fs.symlink(old, active);
    else if (current === 'self') await fs.symlink(active, active);
    else if (current === 'regular') await fs.writeFile(active, 'do not replace this file');
    else if (current === 'outside') {
        const outside = path.join(temp, 'outside'); await makeRelease(outside); await fs.symlink(outside, active);
    }
    const managed = [path.join(etc, 'zeydrop/signaling.env'), path.join(etc, 'systemd/system/zeydrop.service'), path.join(etc, 'nginx/conf.d/zeydrop.conf')];
    await fs.mkdir(path.join(etc, 'zeydrop')); for (const file of managed) await fs.writeFile(file, 'original configuration\n');
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DOMAIN: 'test.example',
        TLS_CERT: certificate, TLS_KEY: certificate, TEST_LOG: log, TEST_FAIL: failure,
        TEST_SERVICE_STATE: path.join(temp, 'service-active') };
    return { root, active, old, managed, env, sourceRoot: temp,
        run: () => spawnSync('bash', [path.join(temp, 'deploy.sh')], { env, encoding: 'utf8', timeout: 10000 }),
        async commands() { return (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    };
}

for (const failure of ['nginx','restart']) test('a retained complete release from failed ' + failure + ' is reused read-only on a successful retry', async t => {
    const f = await deployFixture(t, { failure }), first = f.run(); assert.equal(first.status, 1, first.stderr);
    const release = path.join(f.root, 'releases', nextRevision), before = await snapshot(release);
    f.env.TEST_FAIL = ''; const retry = f.run(); assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /Verified exact prepared release/);
    assert.equal(await fs.readlink(f.active), release); assert.deepEqual(await snapshot(release), before);
    await assert.rejects(fs.lstat(path.join(f.root, 'previous')), { code: 'ENOENT' });
    const commands = await f.commands();
    assert.equal(commands.filter(c => c.tool === 'chown' && c.args.includes('-R')).length, 1, 'retry must not normalize or chown an existing runtime');
});

test('retrying the already-current revision refuses before changing runtime, config, pointers or real previous marker', async t => {
    const f = await deployFixture(t); assert.equal(f.run().status, 0);
    const release = path.join(f.root, 'releases', nextRevision);
    await fs.writeFile(path.join(f.root, 'previous'), f.old + '\n');
    const before = await snapshot(release), config = await Promise.all(f.managed.map(file => fs.readFile(file)));
    const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /already current/);
    assert.equal(await fs.readlink(f.active), release); assert.equal(await fs.readFile(path.join(f.root, 'previous'), 'utf8'), f.old + '\n');
    assert.deepEqual(await snapshot(release), before);
    for (const [index, file] of f.managed.entries()) assert.deepEqual(await fs.readFile(file), config[index]);
});

test('a partial or changed retained release stays untouched and retry stops before publishing configuration', async t => {
    for (const kind of ['partial','changed']) {
        const f = await deployFixture(t, { failure: 'nginx' }); assert.equal(f.run().status, 1);
        const release = path.join(f.root, 'releases', nextRevision);
        if (kind === 'partial') await fs.rm(path.join(release, 'server/package-lock.json'));
        else await fs.writeFile(path.join(release, 'server/index.js'), '// changed retained runtime');
        const before = await snapshot(release); f.env.TEST_FAIL = '';
        const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /Prepared release/);
        assert.deepEqual(await snapshot(release), before);
        await assert.rejects(fs.lstat(f.active), { code: 'ENOENT' });
        for (const file of f.managed) assert.equal(await fs.readFile(file, 'utf8'), 'original configuration\n');
    }
});
