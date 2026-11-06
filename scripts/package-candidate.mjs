import { readFile, writeFile, mkdtemp, mkdir, cp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

// Deterministic *unreleased* CI package: no production deploy, tags, domains,
// signing claims, device data or service credentials.
const root=path.resolve(import.meta.dirname,'..');
process.chdir(root);
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const build=JSON.parse(await readFile('dist/build.json','utf8'));
if(!/^[a-f0-9]{40}$/.test(commit)|| !/^[a-f0-9]{16}$/.test(build.revision))
    throw Error('Missing verified source commit or build revision');
const output=path.join(root,'test-results','candidate');
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'zeydrop-pack-'));
const stage=path.join(temp,'zeydrop-candidate');
const entries=['.github','.gitignore','AGENTS.md','README.md','LICENSE','NOTICE',
    'build.sh','deploy.sh','package.json','package-lock.json','client','server',
    'scripts','deployment','docs','tests','dist'];
const forbidden=new Set(['.git','.env','node_modules','test-results','playwright-report']);
try {
    await mkdir(stage);
    for(const entry of entries){
        const source=path.join(root,entry);
        const kind=await stat(source);
        if(kind.isDirectory()) await cp(source,path.join(stage,entry),{
            recursive:true,
            filter:p=>!path.relative(root,p).split(path.sep).some(part=>forbidden.has(part))
        });
        else await cp(source,path.join(stage,entry));
    }
    const raw=path.join(temp,'archive.tar');
    execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0',
        '--numeric-owner','--format=gnu','-cf',raw,'-C',temp,'zeydrop-candidate']);
    const archive=gzipSync(await readFile(raw),{level:9,mtime:0});
    const sha256=createHash('sha256').update(archive).digest('hex');
    const filename='zeydrop-candidate.tar.gz';
    await writeFile(path.join(output,filename),archive);
    await writeFile(path.join(output,filename+'.sha256'),sha256+'  '+filename+'\n');
    const contents=execFileSync('tar',['-tzf',path.join(output,filename)],{encoding:'utf8'}).split('\n');
    for(const required of ['zeydrop-candidate/dist/index.html',
        'zeydrop-candidate/server/index.js','zeydrop-candidate/deploy.sh',
        'zeydrop-candidate/package-lock.json','zeydrop-candidate/LICENSE'])
        if(!contents.includes(required))throw Error('Archive missing '+required);
    if(contents.some(p=>/(^|\/)(node_modules|\.env|\.git|test-results)(\/|$)/.test(p)))
        throw Error('Forbidden input in candidate archive');
    await writeFile(path.join(output,'candidate-manifest.json'),JSON.stringify({
        schema:1,product:'Zeydrop',status:'unreleased-developer-test-candidate',
        commit,revision:build.revision,version:build.version,archive:filename,
        sha256,bytes:archive.length,containsNodeModules:false,excluded:['node_modules','.env','.git','test-results'],secretScan:'not-performed',
        notice:'CI package is NOT a stable release or proof of real ISP NAT reachability. Deploy only in a separate test environment.'
    },null,2)+'\n');
    console.log('PASS reproducible development candidate',commit.slice(0,12),build.revision,sha256);
} finally {
    await rm(temp,{recursive:true,force:true});
}
