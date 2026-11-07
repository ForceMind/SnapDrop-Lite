'use strict';
// Full production shell transaction in a disposable filesystem. Only root/path
// boundaries are adapted; npm, OpenSSL and service control are explicit fixtures.
// This does not install a service or certify a real systemd deployment.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const nextRevision = 'aaaaaaaaaaaaaaaa', oldRevision = '1111111111111111';
async function fixture(t, { failure = '', current = 'absent' } = {}) {
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
    return { root, active, old, managed,
        run: () => spawnSync('bash', [path.join(temp, 'deploy.sh')], { env, encoding: 'utf8', timeout: 10000 }),
        async commands() { return (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    };
}

test('first successful deployment has no fictitious previous release marker', async t => {
    const f = await fixture(t), result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readlink(f.active), path.join(f.root, 'releases', nextRevision));
    const marker = await fs.readFile(path.join(f.root, 'previous'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
    });
    assert.equal(marker, null, 'a first installation has no previous release');
});

for (const failure of ['nginx', 'restart']) test('failed first deployment after ' + failure + ' removes the new active pointer without creating a self-loop', async t => {
    const f = await fixture(t, { failure }), result = f.run(); assert.equal(result.status, 1, result.stderr);
    const pointer = await fs.readlink(f.active).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
    });
    assert.equal(pointer, null, 'failure must not leave current pointing to itself');
    await assert.rejects(fs.lstat(path.join(f.root, 'previous')), { code: 'ENOENT' });
    for (const file of f.managed) assert.equal(await fs.readFile(file, 'utf8'), 'original configuration\n');
});

test('an existing valid release remains selectable and is restored on failed upgrade', async t => {
    const f = await fixture(t, { current: 'valid', failure: 'restart' }), result = f.run();
    assert.equal(result.status, 1, result.stderr); assert.equal(await fs.readlink(f.active), f.old);
    for (const file of f.managed) assert.equal(await fs.readFile(file, 'utf8'), 'original configuration\n');
});

test('existing dangling, self, regular and outside-root active pointers are rejected before managed configuration changes', async t => {
    for (const current of ['dangling', 'self', 'regular', 'outside']) {
        const f = await fixture(t, { current });
        const original = current === 'regular' ? await fs.readFile(f.active, 'utf8') : await fs.readlink(f.active);
        const result = f.run(); assert.equal(result.status, 1, current + ': ' + result.stderr);
        assert.match(result.stderr, /Invalid current release/, current);
        if (current === 'regular') assert.equal(await fs.readFile(f.active, 'utf8'), original);
        else assert.equal(await fs.readlink(f.active), original);
        for (const file of f.managed) assert.equal(await fs.readFile(file, 'utf8'), 'original configuration\n');
        const commands = await f.commands();
        assert.ok(commands.every(c => c.tool !== 'systemctl' || !['enable','restart','stop','disable','daemon-reload','reload'].includes(c.args[0])));
    }
});
