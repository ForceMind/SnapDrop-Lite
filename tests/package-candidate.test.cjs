'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const modulePath = path.resolve('scripts/package-candidate.mjs');
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeydrop-package-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    await write('.gitignore', 'dist/\nnode_modules/\n');
    for (const name of ['README.md', 'LICENSE', 'NOTICE', 'deploy.sh', 'package-lock.json', 'server/index.js', 'client/index.html']) await write(name, 'fixture ' + name + '\n');
    await write('package.json', JSON.stringify({version:'0.3.0-test'}));
    await write('dist/index.html', 'built index');
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.txt']) await write('dist/'+name, 'fixture license');
    await write('dist/build.json', JSON.stringify({revision:'0123456789abcdef',version:'0.3.0-test'}));
    git(['init','-q']); git(['config','user.email','test@localhost']);git(['config','user.name','fixture']);
    const commit = () => { git(['add','.']);git(['commit','-qm','fixture']); };
    await fs.chmod(path.join(root,'deploy.sh'),0o755);commit();
    return {root,write,git,commit,pack:async()=> (await import(modulePath)).packageCandidate({root,verifyBuild:false})};
}
test('candidate packages only tracked sources, verifies content mapping and is byte reproducible', async t => {
    const f=await fixture(t);
    await f.write('server/.env.production','UNTRACKED_SECRET=value');
    await f.write('server/untracked-notes.txt','private local notes');
    await f.write('server/node_modules/private/key.pem','private dependency file');
    const first=await f.pack();let second;const oldMask=process.umask(0o077);
    try { second=await f.pack(); } finally { process.umask(oldMask); }
    assert.equal(first.sha256,second.sha256);assert.equal(first.sourceSnapshot,'clean-HEAD-tracked-files');
    assert.ok(first.files.every(file=> !file.path.includes('untracked') && !file.path.includes('.env') && !file.path.includes('node_modules')));
    assert.equal(first.secretScan.status,'passed-bounded-pattern-scan');
    assert.ok(first.files.find(file=>file.path==='server/index.js').sha256);
    assert.equal(first.files.find(file=>file.path==='deploy.sh').mode,'755');
    const archive=path.join(f.root,'test-results/candidate/zeydrop-candidate.tar.gz');
    const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'});
    assert.ok(!names.includes('UNTRACKED_SECRET') && !names.includes('.env.production') && !names.includes('untracked-notes'));
});
test('candidate rejects a HEAD mismatch, unexpected dist file and a symlink instead of publishing it', async t => {
    const f=await fixture(t);await f.write('server/index.js','dirty');await assert.rejects(f.pack(),/clean tracked/);
    f.git(['checkout','--','server/index.js']);await f.write('dist/unexpected.txt','untracked build');await assert.rejects(f.pack(),/unexpected asset/);
    await fs.rm(path.join(f.root,'dist/unexpected.txt'));await fs.rm(path.join(f.root,'dist/index.html'));
    await fs.symlink(path.join(f.root,'README.md'),path.join(f.root,'dist/index.html'));
    await assert.rejects(f.pack(),/Symlink/);
});
test('candidate rejects tracked credential files and token patterns without revealing their values', async t => {
    const f=await fixture(t);await f.write('server/.env.production','secret-value');f.commit();
    await assert.rejects(f.pack(),/Credential or forbidden path/);
    f.git(['rm','server/.env.production']);f.git(['commit','-qm','remove credential file']);
    const secret=['gh','p_'].join('')+'a'.repeat(36);await f.write('server/index.js',secret);f.commit();
    await assert.rejects(f.pack(),error=> {assert.ok(!error.message.includes(secret));return /github-token/.test(error.message);});
});
test('candidate rejects mismatched build versions and missing generated resources', async t => {
    const f=await fixture(t);await f.write('dist/build.json',JSON.stringify({revision:'0123456789abcdef',version:'other'}));
    await assert.rejects(f.pack(),/mismatched build/);
    await f.write('dist/build.json',JSON.stringify({revision:'0123456789abcdef',version:'0.3.0-test'}));await fs.rm(path.join(f.root,'dist/NOTICE'));
    await assert.rejects(f.pack(),/missing expected asset/);
});
