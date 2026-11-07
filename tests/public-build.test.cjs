'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const sourceRoot = path.resolve('.');
async function fixture(t) {
    const { PUBLIC_CLIENT_FILES } = await import(path.join(sourceRoot,'scripts/public-assets.mjs'));
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'zeydrop-public-build-test-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const sourceFiles=[...PUBLIC_CLIENT_FILES,'package.json','package-lock.json','server/index.js','server/package.json','server/package-lock.json','scripts/build.mjs','scripts/public-assets.mjs','scripts/check-signaling.cjs','deploy.sh','scripts/rollback.sh','deployment/nginx.conf','deployment/zeydrop.service','LICENSE','NOTICE'];
    for(const name of sourceFiles){const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(sourceRoot,name),target);}
    // Reuse the same already-installed locked dependency tree only for reads.
    // The source fixture intentionally has no .git metadata or private files.
    await fs.symlink(path.join(sourceRoot,'node_modules'),path.join(root,'node_modules'),'dir');
    await fs.symlink(path.join(sourceRoot,'server/node_modules'),path.join(root,'server/node_modules'),'dir');
    const run=()=>spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,encoding:'utf8',timeout:10000});
    const build=async()=>{const result=run();assert.equal(result.status,0,result.stderr);return JSON.parse(await fs.readFile(path.join(root,'dist/build.json'),'utf8'));};
    return {root,run,build};
}
test('real Git-free build publishes only approved client files; extra local files cannot affect bytes or revision',async t=>{
    const f=await fixture(t);await assert.rejects(fs.stat(path.join(f.root,'.git')),{code:'ENOENT'});
    const first=await f.build();const firstHtml=await fs.readFile(path.join(f.root,'dist/index.html'),'utf8');
    await fs.writeFile(path.join(f.root,'client/.env.local'),'SYNTHETIC_ONLY=fixture\n');
    await fs.writeFile(path.join(f.root,'client/private-notes.txt'),'synthetic unapproved notes');
    await fs.mkdir(path.join(f.root,'client/drafts'));await fs.writeFile(path.join(f.root,'client/drafts/unapproved.js'),'unapproved fixture');
    const second=await f.build();assert.equal(second.revision,first.revision);assert.equal(await fs.readFile(path.join(f.root,'dist/index.html'),'utf8'),firstHtml);
    for(const name of ['.env.local','private-notes.txt','drafts'])await assert.rejects(fs.stat(path.join(f.root,'dist',name)),{code:'ENOENT'});
    assert.ok(!(await fs.readFile(path.join(f.root,'dist/service-worker.js'),'utf8')).includes('private-notes'));
    await fs.appendFile(path.join(f.root,'client/styles.css'),'\n/* approved asset changed */\n');
    assert.notEqual((await f.build()).revision,first.revision,'approved asset changes must change revision');
});
for(const kind of ['file-symlink','images-parent-symlink','client-parent-symlink','special-file'])test('real build rejects '+kind+' and retains the last complete build',async t=>{
    const f=await fixture(t);await f.build();const before=await fs.readFile(path.join(f.root,'dist/index.html'));
    if(kind==='file-symlink'){
        const outside=path.join(f.root,'outside-private.txt');await fs.writeFile(outside,'synthetic private fixture');
        await fs.rm(path.join(f.root,'client/styles.css'));await fs.symlink(outside,path.join(f.root,'client/styles.css'));
    }else if(kind==='images-parent-symlink'){
        await fs.rename(path.join(f.root,'client/images'),path.join(f.root,'images-outside-client'));
        await fs.symlink(path.join(f.root,'images-outside-client'),path.join(f.root,'client/images'),'dir');
    }else if(kind==='client-parent-symlink'){
        await fs.rename(path.join(f.root,'client'),path.join(f.root,'client-outside'));
        await fs.symlink(path.join(f.root,'client-outside'),path.join(f.root,'client'),'dir');
    }else{
        await fs.rm(path.join(f.root,'client/styles.css'));execFileSync('mkfifo',[path.join(f.root,'client/styles.css')]);
    }
    const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,kind==='special-file'?/Non-regular approved input/:/Symbolic link rejected/);
    assert.deepEqual(await fs.readFile(path.join(f.root,'dist/index.html')),before);
    assert.ok(!result.stderr.includes('synthetic private fixture'));
});
