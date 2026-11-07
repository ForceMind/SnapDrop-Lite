'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { ZeydropServer } = require('../server');
const root = path.resolve(__dirname, '../dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
async function startDev(port = 8080) {
    const httpServer = http.createServer((req, res) => {
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
        let target;
        try { const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)); } catch { res.writeHead(400); res.end(); return; }
        if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
        fs.stat(target, (error, stat) => {
            if (error || !stat.isFile()) { res.writeHead(404); res.end(); return; }
            res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
            res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-cache');
            if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
        });
    });
    await new Promise(resolve => httpServer.listen(port, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + httpServer.address().port;
    const signaling = new ZeydropServer({ noServer: true, origins: origin + ',http://localhost:' + httpServer.address().port });
    httpServer.on('upgrade', (req, socket, head) => signaling._wss.handleUpgrade(req, socket, head, ws => signaling._wss.emit('connection', ws, req)));
    return { origin, signaling, close: async () => { await signaling.close(); httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); } };
}
module.exports = { startDev };
if (require.main === module) startDev(Number(process.env.WEB_PORT || 8080)).then(server => { console.log('Zeydrop development only:', server.origin); for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close().then(() => process.exit())); });
