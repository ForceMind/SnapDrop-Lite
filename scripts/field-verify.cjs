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
const CHUNK_BYTES = 1024 * 1024;
const errorMessages = Object.freeze({
    argumentPairs: '参数需以 --name value 成对提供',
    arguments: '无效或重复的命令行参数',
    scenarioRequired: '需要两个诊断 JSON 和指定场景；使用 --help 查看',
    pairedFiles: '文件完整性核验需要同时指定发送文件与接收文件',
    diagnosticFormat: '无效或不兼容的本机连接诊断格式，请重新导出',
    scenario: '无效的网络测试场景',
    diagnosticSize: '诊断 JSON 大小无效，最多 1 MiB',
    regularFile: '必须提供普通文件',
    fileSize: '本机文件大小无法安全核验',
    fileChanged: '文件读取期间发生变化，请停止写入后重试'
});
const safeErrors = new WeakSet();
function fieldError(code) {
    const error = Error(errorMessages[code]); error.code = code;
    safeErrors.add(error); return error;
}
function cliFailure(error) {
    // Native fs and JSON errors can contain paths, input snippets or tokens.
    // Only locally constructed, fixed messages may reach a shareable console.
    if (safeErrors.has(error)) return errorMessages[error.code];
    if (error?.code === 'EEXIST') return '输出文件已存在，请使用新的输出位置；不会覆盖已有报告';
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return '本机输入文件或输出目录不存在，请检查参数';
    if (['EACCES', 'EPERM'].includes(error?.code)) return '没有本机文件读写权限，请检查权限后重试';
    return '本机文件核验失败，请检查输入格式、文件状态及读写权限后重试';
}
const help = `Usage: node scripts/field-verify.cjs
  --sender-diag A.json --receiver-diag B.json
  --scenario same-wifi|different-broadband|broadband-cellular|different-carriers|ipv6-dual-stack|strict-nat|network-switch|unknown
  [--sender-file original.bin --receiver-file received.bin]
  [--out local-report.json]

All inputs stay on this computer. The output never contains file names, paths,
private IPs, invite tokens, raw diagnostics or file hashes. Browser reports are
self-reported; no claim of public NAT success or ISP topology is inferred.
Keep inputs unchanged while checking. Observed size/metadata/path changes fail
without a success report; filesystem metadata checks are not an atomic snapshot.
`;
function parseArgs(argv) {
    if (argv.length === 1 && argv[0] === '--help') return { help: true };
    const names = new Set(['--sender-diag', '--receiver-diag','--scenario','--sender-file','--receiver-file','--out']);
    const result = {};
    if (argv.length % 2 !== 0) throw fieldError('argumentPairs');
    for (let i = 0; i < argv.length; i += 2) {
        const name = argv[i], value = argv[i+1];
        if (!names.has(name) || !value || value.startsWith('--') || result[name]) throw fieldError('arguments');
        result[name] = value;
    }
    if (!result['--sender-diag'] || !result['--receiver-diag'] || !allowedScenarios.has(result['--scenario']))
        throw fieldError('scenarioRequired');
    if (!!result['--sender-file'] !== !!result['--receiver-file'])
        throw fieldError('pairedFiles');
    return result;
}
function selectedSummary(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)
        || report.schema !== 1 || report.product !== 'Zeydrop'
        || !revisionPattern.test(report.revision)
        || typeof report.version !== 'string' || !/^[\w.+-]{1,40}$/.test(report.version)
        || !Array.isArray(report.events) || report.events.length > 120)
        throw fieldError('diagnosticFormat');
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
    if (!allowedScenarios.has(scenario)) throw fieldError('scenario');
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
const sameFile = (a, b) => a.isFile() && b.isFile()
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function pathStillMatches(file, before) {
    let current;
    try { current = await fsp.stat(file, { bigint: true }); }
    catch { throw fieldError('fileChanged'); }
    if (!sameFile(before, current)) throw fieldError('fileChanged');
}
async function readStable(file, consume, diagnostic = false) {
    // Anchor all reads to one opened regular file. O_NONBLOCK prevents a path
    // replaced by a FIFO/device from blocking before the type check on POSIX.
    // Stable symlinks remain usable, but retargeting is detected by path stat.
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw fieldError('regularFile');
        if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fieldError('fileSize');
        const size = Number(before.size);
        if (diagnostic && (size < 2 || size > CHUNK_BYTES)) throw fieldError('diagnosticSize');
        await pathStillMatches(file, before);
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, size)));
        let position = 0;
        while (position < size) {
            const requested = Math.min(chunk.length, size - position);
            const { bytesRead } = await handle.read(chunk, 0, requested, position);
            if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > requested) throw fieldError('fileChanged');
            consume(chunk.subarray(0, bytesRead)); position += bytesRead;
        }
        // Read at most the initially declared size plus a one-byte growth
        // probe. An actively growing file must not extend hashing indefinitely.
        const { bytesRead } = await handle.read(chunk, 0, 1, size);
        if (bytesRead !== 0) throw fieldError('fileChanged');
        const after = await handle.stat({ bigint: true });
        if (!sameFile(before, after)) throw fieldError('fileChanged');
        await pathStillMatches(file, before);
        return { size: position, stamp: before };
    } finally { await handle.close(); }
}
async function readDiagnostic(file) {
    const chunks = [];
    await readStable(file, chunk => chunks.push(Buffer.from(chunk)), true);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fieldError('diagnosticFormat'); }
}
async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    const { size, stamp } = await readStable(file, chunk => hash.update(chunk));
    return { size, stamp, digest: hash.digest('hex') };
}
async function settledInputs(jobs) {
    // Do not return an error while the other descriptor is still hashing.
    const results = await Promise.allSettled(jobs);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map(result => result.value);
}
async function verifyFiles(sender, receiver) {
    const [a,b] = await settledInputs([hashFile(sender), hashFile(receiver)]);
    // One file can finish before the other. Reject changes observed during
    // that remaining window too, without exporting internal file metadata.
    await settledInputs([pathStillMatches(sender, a.stamp), pathStillMatches(receiver, b.stamp)]);
    return { provided:true, senderBytes:a.size, receiverBytes:b.size,
        equal:a.size===b.size && crypto.timingSafeEqual(Buffer.from(a.digest,'hex'), Buffer.from(b.digest,'hex')) };
}
async function run(argv = process.argv.slice(2)) {
    const opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(help); return null; }
    const [a,b] = await settledInputs([
        readDiagnostic(opts['--sender-diag']),
        readDiagnostic(opts['--receiver-diag'])
    ]);
    // Validate diagnostics before reading potentially large user files.
    const diagnosticReport = assessReports(a,b,opts['--scenario']);
    const files = opts['--sender-file'] ? await verifyFiles(opts['--sender-file'], opts['--receiver-file']) : null;
    const report = files ? assessReports(a,b,opts['--scenario'],files) : diagnosticReport;
    const output = JSON.stringify(report,null,2)+'\n';
    if (opts['--out']) await fsp.writeFile(opts['--out'],output,{mode:0o600,flag:'wx'});
    else process.stdout.write(output);
    if (report.verdict!=='evidence-consistent') process.exitCode=2;
    return report;
}
if (require.main===module) {
    run().catch(error => { console.error('Field verification failed: '+cliFailure(error));
        process.exitCode=1; });
}
module.exports={parseArgs,selectedSummary,assessReports,verifyFiles,readDiagnostic,run};
