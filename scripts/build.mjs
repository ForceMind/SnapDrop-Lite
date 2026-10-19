import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
async function files(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const file = path.join(dir, entry.name);
        result.push(...entry.isDirectory() ? await files(file) : [file]);
    }
    return result;
}
const hash = createHash('sha256');
for (const file of [...await files('client'), 'package.json', 'package-lock.json', 'server/index.js', 'server/package.json', 'server/package-lock.json', 'scripts/build.mjs', 'deploy.sh', 'scripts/rollback.sh', ...await files('deployment'), 'LICENSE', 'NOTICE']) { hash.update(file); hash.update(await readFile(file)); }
const revision = hash.digest('hex').slice(0, 16);
await rm('dist', { recursive: true, force: true });
await cp('client', 'dist', { recursive: true });
await build({ entryPoints: ['client/scripts/vendor.js'], outfile: 'dist/scripts/vendor.js', bundle: true, format: 'iife', minify: true, legalComments: 'eof', target: ['es2022'] });
let notices = '';
for (const [label, file] of [['ws', 'server/node_modules/ws/LICENSE'], ['@noble/hashes', 'node_modules/@noble/hashes/LICENSE'], ['qrcode', 'node_modules/qrcode/license'], ['dijkstrajs', 'node_modules/dijkstrajs/LICENSE.md'], ['pngjs', 'node_modules/pngjs/LICENSE']]) {
    notices += label + '\n' + await readFile(file, 'utf8') + '\n\n';
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', notices);
await cp('LICENSE', 'dist/LICENSE'); await cp('NOTICE', 'dist/NOTICE');
const html = (await readFile('client/index.html', 'utf8')).replace('__BUILD_REVISION__', revision).replace(/((?:src|href)="(?:scripts\/[^"?]+\.js|config\.js|styles\.css|manifest\.json))(?:\?[^"\s]*)?"/g, `$1?v=${revision}"`);
await writeFile('dist/index.html', html);
const assets = (await files('dist')).map(file => '/' + file.slice(5)).filter(file => !file.endsWith('service-worker.js') && !file.endsWith('config.js'));
const shell = assets.map(file => /\.(js|css|json)$/.test(file) ? file + '?v=' + revision : file);
shell.push('/');
const sw = (await readFile('client/service-worker.js', 'utf8')).replace('__REVISION__', revision).replace('/*__ASSETS__*/ []', JSON.stringify(shell));
await writeFile('dist/service-worker.js', sw);
await writeFile('dist/build.json', JSON.stringify({ revision, version: JSON.parse(await readFile('package.json')).version }, null, 2) + '\n');
console.log('Zeydrop build', revision);
