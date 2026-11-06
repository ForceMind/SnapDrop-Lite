'use strict';
// Only for disposable GitHub-hosted Ubuntu CI runners. The runner image routes
// its Ubuntu sources through /etc/apt/apt-mirrors.txt, so changing only
// ubuntu.sources would leave the Azure mirror selected.
// https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
// https://manpages.ubuntu.com/manpages/noble/man1/apt-transport-mirror.1.html
// https://documentation.ubuntu.com/security/software-integrity/archive-verification/
// Change only the exact Ubuntu Azure archive URI. Keep keys, Signed-By, suites,
// components, security sources, third-party sources and all APT policy intact.
const fs = require('node:fs/promises');

const FILES = [
    ['/etc/apt/apt-mirrors.txt', 'mirrors'],
    ['/etc/apt/sources.list', 'list'],
    ['/etc/apt/sources.list.d/ubuntu.sources', 'deb822']
];
const OFFICIAL = 'https://archive.ubuntu.com/ubuntu/';
function replaceUriTokens(value) {
    return value.replace(/(^|\s)https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=\s|$)/g, (_match, prefix) => prefix + OFFICIAL);
}
function rewriteAptFile(content, kind) {
    if (!['mirrors', 'list', 'deb822'].includes(kind)) throw new Error('Unknown APT format');
    let field = '';
    return content.split('\n').map(line => {
        if (/^\s*#/.test(line)) return line;
        if (kind === 'mirrors') return line.replace(/^(\s*)https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=[\s#]|$)/,
            (_match, prefix) => prefix + OFFICIAL);
        if (kind === 'list') return line.replace(/^(\s*deb(?:-src)?\s+(?:\[[^\]\r\n]*\]\s+)?)(https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?)(?=\s|$)/,
            (_match, prefix) => prefix + OFFICIAL);
        if (!line.trim()) { field = ''; return line; }
        const match = /^([A-Za-z0-9-]+):/.exec(line);
        if (match) field = match[1].toLowerCase();
        else if (!/^\s/.test(line)) field = '';
        return field === 'uris' ? replaceUriTokens(line) : line;
    }).join('\n');
}

async function configureCiApt(options = {}) {
    const env = options.env || process.env;
    const io = options.io || fs;
    const uid = options.uid ?? process.getuid?.();
    if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Linux'
        || env.RUNNER_ENVIRONMENT !== 'github-hosted' || uid !== 0) throw new Error('Disposable hosted CI only');
    const osRelease = await io.readFile('/etc/os-release', 'utf8');
    if (!/^ID=(?:ubuntu|"ubuntu")\s*$/m.test(osRelease)) throw new Error('Ubuntu CI only');
    // Read and validate every candidate before writing any. No broad recursive
    // replacement of /etc/apt, no alternate keyring, no authentication bypass.
    const changes = [];
    let found = false;
    for (const [file, kind] of FILES) {
        let info;
        try { info = await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected APT file type');
        found = true;
        const original = await io.readFile(file, 'utf8');
        const updated = rewriteAptFile(original, kind);
        if (updated !== original) changes.push({ file, updated });
    }
    if (!found) throw new Error('No supported Ubuntu APT files');
    for (const { file, updated } of changes) await io.writeFile(file, updated, 'utf8');
    return { schema: 1, ciOnly: true, changed: changes.length > 0, signaturePolicyUnchanged: true, passed: true };
}
if (require.main === module) configureCiApt().then(report => console.log(JSON.stringify(report)))
    .catch(() => { console.log(JSON.stringify({ schema: 1, ciOnly: true, passed: false })); process.exitCode = 1; });
module.exports = { configureCiApt, rewriteAptFile };
