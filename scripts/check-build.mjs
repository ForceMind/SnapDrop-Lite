import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
async function snapshot(dir) {
    const out = {};
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
        const file = dir + '/' + entry.name;
        if (entry.isDirectory()) Object.assign(out, await snapshot(file)); else out[file] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
    return out;
}
const before = await snapshot('dist');
execFileSync(process.execPath, ['scripts/build.mjs']);
assert.deepEqual(await snapshot('dist'), before, 'build must be reproducible');
const html = await readFile('dist/index.html', 'utf8');
for (const match of html.matchAll(/(?:src|href)="((?:scripts|images)\/[^"?]+|config\.js|styles\.css|manifest\.json)(?:\?[^\"]*)?"/g)) await readFile('dist/' + match[1]);
const manifest = JSON.parse(await readFile('dist/manifest.json'));
for (const icon of manifest.icons) await readFile('dist/' + icon.src);
assert.match(await readFile('dist/service-worker.js','utf8'), /zeydrop-shell-[a-f0-9]{16}/);
assert.ok(!html.includes('clipboard.js'));
assert.match(html, /name="build-revision" content="[a-f0-9]{16}"/);
console.log('PASS reproducible shell, icons and local references');
