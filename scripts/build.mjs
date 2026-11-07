import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_CLIENT_FILES, readApprovedSourceFile, snapshotPublicClient, writePublicClient } from './public-assets.mjs';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const publicClient = await snapshotPublicClient(root);
const inputs = new Map(publicClient);
for (const file of ['package.json', 'package-lock.json', 'server/index.js', 'server/package.json', 'server/package-lock.json', 'scripts/build.mjs', 'scripts/public-assets.mjs', 'deploy.sh', 'scripts/rollback.sh', 'scripts/check-signaling.cjs', 'deployment/nginx.conf', 'deployment/zeydrop.service', 'LICENSE', 'NOTICE']) inputs.set(file, await readApprovedSourceFile(root, file));
const hash = createHash('sha256');
for (const [file, bytes] of inputs) { hash.update(file); hash.update(bytes); }
const revision = hash.digest('hex').slice(0, 16);
// Snapshot validation completes before removing the last successful build.
await rm('dist', { recursive: true, force: true });
await writePublicClient(publicClient, path.join(root, 'dist'));
// Use the validated entry bytes, rather than reopening a changed source path.
await build({ stdin: { contents: publicClient.get('client/scripts/vendor.js').toString('utf8'), resolveDir: path.join(root, 'client/scripts'), sourcefile: 'vendor.js' }, outfile: 'dist/scripts/vendor.js', bundle: true, format: 'iife', minify: true, legalComments: 'eof', target: ['es2022'] });
// The dedicated hasher uses the same validated source snapshot and locked
// Noble implementation; no runtime module/CDN fetch is required by the worker.
await build({ stdin: { contents: publicClient.get('client/scripts/file-hash-worker.js').toString('utf8'), resolveDir: path.join(root, 'client/scripts'), sourcefile: 'file-hash-worker.js' }, outfile: 'dist/scripts/file-hash-worker.js', bundle: true, format: 'iife', minify: true, legalComments: 'eof', target: ['es2022'] });
let notices = '';
for (const [label, file] of [['ws', 'server/node_modules/ws/LICENSE'], ['@noble/hashes', 'node_modules/@noble/hashes/LICENSE'], ['qrcode', 'node_modules/qrcode/license'], ['dijkstrajs', 'node_modules/dijkstrajs/LICENSE.md'], ['pngjs', 'node_modules/pngjs/LICENSE']]) {
    notices += label + '\n' + await readFile(file, 'utf8') + '\n\n';
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', notices);
await writeFile('dist/LICENSE', inputs.get('LICENSE')); await writeFile('dist/NOTICE', inputs.get('NOTICE'));
const html = publicClient.get('client/index.html').toString('utf8').replace('__BUILD_REVISION__', revision).replace(/((?:src|href)="(?:scripts\/[^"?]+\.js|config\.js|styles\.css|manifest\.json))(?:\?[^"\s]*)?"/g, `$1?v=${revision}"`);
await writeFile('dist/index.html', html);
const assets = [...PUBLIC_CLIENT_FILES.map(file => '/' + file.slice('client/'.length)), '/THIRD_PARTY_LICENSES.txt', '/LICENSE', '/NOTICE'].filter(file => !file.endsWith('service-worker.js') && !file.endsWith('config.js'));
const shell = assets.map(file => /\.(js|css|json)$/.test(file) ? file + '?v=' + revision : file);
shell.push('/');
const sw = publicClient.get('client/service-worker.js').toString('utf8').replace('__REVISION__', revision).replace('/*__ASSETS__*/ []', JSON.stringify(shell));
await writeFile('dist/service-worker.js', sw);
await writeFile('dist/build.json', JSON.stringify({ revision, version: JSON.parse(inputs.get('package.json').toString('utf8')).version }, null, 2) + '\n');
console.log('Zeydrop build', revision);
