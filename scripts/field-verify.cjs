'use strict';
// Local-only manual field evidence verifier. No network calls or file uploads.
// This is not cryptographic attestation of the network used by either browser.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const allowedScenarios = new Set([
    'same-wifi', 'different-broadband', 'broadband-cellular',
    'different-carriers', 'ipv6-dual-stack', 'strict-nat',
    'network-switch', 'unknown'
]);
const typeSet = new Set(['host', 'srflx', 'prflx']);
const familySet = new Set(['IPv4', 'IPv6 / 双栈', '地址族未公开']);
const revisionPattern = /^[a-f0-9]{16}$/;
const help = `Usage: node scripts/field-verify.cjs
  --sender-diag A.json --receiver-diag B.json
  --scenario same-wifi|different-broadband|broadband-cellular|different-carriers|ipv6-dual-stack|strict-nat|network-switch|unknown
  [--sender-file original.bin --receiver-file received.bin]
  [--out local-report.json]

All inputs stay on this computer. The output never contains file names, paths,
private IPs, invite tokens, raw diagnostics or file hashes. Browser reports are
self-reported; no claim of public NAT success or ISP topology is inferred.
`;
function parseArgs(argv) {
    if (argv.length === 1 && argv[0] === '--help') return { help: true };
    const names = new Set(['--sender-diag', '--receiver-diag','--scenario','--sender-file','--receiver-file','--out']);
    const result = {};
    if (argv.length % 2 !== 0) throw Error('参数需以 --name value 成对提供');
    for (let i = 0; i < argv.length; i += 2) {
        const name = argv[i], value = argv[i+1];
        if (!names.has(name) || !value || value.startsWith('--') || result[name]) throw Error('无效或重复的命令行参数');
        result[name] = value;
    }
    if (!result['--sender-diag'] || !result['--receiver-diag'] || !allowedScenarios.has(result['--scenario']))
        throw Error('需要两个诊断 JSON 和指定场景；使用 --help 查看');
    if (!!result['--sender-file'] !== !!result['--receiver-file'])
        throw Error('文件完整性核验需要同时指定发送文件与接收文件');
    return result;
}
function selectedSummary(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)
        || report.schema !== 1 || report.product !== 'Zeydrop'
        || !revisionPattern.test(report.revision)
        || typeof report.version !== 'string' || !/^[\w.+-]{1,40}$/.test(report.version)
        || !Array.isArray(report.events) || report.events.length > 120)
        throw Error('无效或不兼容的本机连接诊断格式');
    // Never use a historical good path if the latest connection event is
    // disconnected/failed. The report itself is client-provided evidence only.
    const last = report.events.filter(event => event?.kind === 'connection').at(-1);
    const path = last?.path || {};
    const direct = last?.state === 'connected' && last?.ready === true
        && last?.identityConfirmed === true && path.direct === true
        && path.status === 'selected' && ['udp', 'tcp'].includes(path.protocol)
        && typeSet.has(path.localType) && typeSet.has(path.remoteType);
    return {
        revision: report.revision, version: report.version,
        selectedDirectAtExport: direct,
        path: direct ? {
            protocol: path.protocol,
            localType: path.localType,
            remoteType: path.remoteType,
            family: familySet.has(path.family) ? path.family : '地址族未公开',
            rttMs: Number.isFinite(path.rttMs) && path.rttMs >= 0 && path.rttMs <= 600000
                ? Math.round(path.rttMs) : null
        } : null,
        // The only output fields are fixed allowlisted values, not raw source.
        connectionEvidencePresent: !!last
    };
}
function assessReports(sender, receiver, scenario, fileProof = null) {
    if (!allowedScenarios.has(scenario)) throw Error('无效的网络测试场景');
    const a = selectedSummary(sender), b = selectedSummary(receiver);
    const sameRevision = a.revision === b.revision && a.version === b.version;
    const selectedOnBoth = sameRevision && a.selectedDirectAtExport && b.selectedDirectAtExport;
    const filesMatch = fileProof?.provided === true && fileProof.equal === true;
    return {
        schema: 1, product: 'Zeydrop', kind: 'local-field-evidence-review',
        generatedAt: new Date().toISOString(), scenario,
        clientReportedOnly: true,
        sampleCount: 1,
        sender: a, receiver: b,
        sameBuild: sameRevision,
        selectedNonRelayOnBoth: !!selectedOnBoth,
        fileCheck: fileProof ? {
            provided: true,
            senderBytes: fileProof.senderBytes,
            receiverBytes: fileProof.receiverBytes,
            sha256Equal: fileProof.equal === true,
            hashAndPathsOmitted: true
        } : { provided: false, sha256Equal: null, hashAndPathsOmitted: true },
        verdict: fileProof?.provided && !fileProof.equal ? 'integrity-mismatch'
            : selectedOnBoth && filesMatch ? 'evidence-consistent'
            : selectedOnBoth ? 'direct-route-diagnostic-only' : 'not-confirmed',
        limitation: 'Client-exported diagnostics and locally compared files are not independent network-path attestation. Do not claim cross-ISP NAT success rate without physical endpoint and server-side evidence.',
        dataHandling: 'No network calls. No original file names, system paths, IP addresses, invite tokens, raw events or file digests included.'
    };
}
async function readDiagnostic(file) {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) throw Error('诊断 JSON 大小无效');
    return JSON.parse(await fsp.readFile(file, 'utf8'));
}
async function hashFile(file) {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw Error('必须提供普通文件');
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
    return { size: stat.size, digest: hash.digest('hex') };
}
async function verifyFiles(sender, receiver) {
    const [a,b] = await Promise.all([hashFile(sender), hashFile(receiver)]);
    return { provided:true, senderBytes:a.size, receiverBytes:b.size,
        equal:a.size===b.size && crypto.timingSafeEqual(Buffer.from(a.digest,'hex'), Buffer.from(b.digest,'hex')) };
}
async function run(argv = process.argv.slice(2)) {
    const opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(help); return null; }
    const [a,b,files] = await Promise.all([
        readDiagnostic(opts['--sender-diag']),
        readDiagnostic(opts['--receiver-diag']),
        opts['--sender-file']
            ? verifyFiles(opts['--sender-file'], opts['--receiver-file']) : Promise.resolve(null)
    ]);
    const report = assessReports(a,b,opts['--scenario'],files);
    const output = JSON.stringify(report,null,2)+'\n';
    if (opts['--out']) await fsp.writeFile(opts['--out'],output,{mode:0o600,flag:'wx'});
    else process.stdout.write(output);
    if (report.verdict!=='evidence-consistent') process.exitCode=2;
    return report;
}
if (require.main===module) {
    run().catch(error => { console.error('Field verification failed: '+String(error.message).slice(0,160));
        process.exitCode=1; });
}
module.exports={parseArgs,selectedSummary,assessReports,verifyFiles,readDiagnostic,run};
