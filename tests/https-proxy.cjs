'use strict';
// Staging-only HTTPS/WSS integration against the actual production Nginx
// template. No production host, third-party endpoint, real NAT or file relay.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const { WebSocket } = require('../server/node_modules/ws');
const { ZeydropServer } = require('../server');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
    const value = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return value;
}
function request(protocol, hostPort, target, method='GET', data) {
    const client = protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = client.request({
            hostname:'127.0.0.1', port:hostPort, path:target, method,
            rejectUnauthorized:false, servername:'localhost',
            headers: data ? {'content-type':'application/octet-stream','content-length':data.length} : {}
        }, res => {
            const buffers = [];
            res.on('data', buf => buffers.push(buf));
            res.once('end', () => resolve({
                status:res.statusCode, headers:res.headers, body:Buffer.concat(buffers).toString()
            }));
        });
        req.once('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
async function websocket(url, origin) {
    const ws = new WebSocket(url, { origin, rejectUnauthorized:false, handshakeTimeout:5000 });
    const messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    await new Promise((resolve, reject) => { ws.once('open',resolve); ws.once('error',reject); });
    const wait = async predicate => {
        for(let i=0;i<200;i++){
            const found=messages.find(predicate);
            if(found) return found;
            await sleep(10);
        }
        throw Error('WSS signaling response timeout');
    };
    return {ws,messages,wait,send:data=>ws.send(JSON.stringify(data))};
}
async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(),'zeydrop-https-smoke-'));
    const httpsPort = await port(), httpPort=await port();
    const backend = new ZeydropServer({
        port:0,host:'127.0.0.1',origins:'https://localhost:'+httpsPort
    });
    let nginx;
    const clients=[];
    try {
        await new Promise((resolve,reject)=>{
            if(backend._wss.address()) return resolve();
            backend._wss.once('listening',resolve);backend._wss.once('error',reject);
        });
        const signalingPort=backend._wss.address().port;
        const key=path.join(temp,'key.pem'),cert=path.join(temp,'cert.pem');
        execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
            '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
            '-keyout',key,'-out',cert], {stdio:'ignore'});
        let site=await fs.readFile(path.join(root,'deployment/nginx.conf'),'utf8');
        const substitutions=[
            ['listen 80;', 'listen 127.0.0.1:'+httpPort+';'],
            ['listen 443 ssl;', 'listen 127.0.0.1:'+httpsPort+' ssl;'],
            ['root /opt/zeydrop/current/dist;', 'root '+path.join(root,'dist')+';'],
            ['proxy_pass http://127.0.0.1:3001;', 'proxy_pass http://127.0.0.1:'+signalingPort+';'],
            ['/var/log/nginx/zeydrop.access.log',path.join(temp,'access.log')],
            ['/var/log/nginx/zeydrop.error.log',path.join(temp,'error.log')],
            ['@DOMAIN@','localhost'],['@TLS_CERT@',cert],['@TLS_KEY@',key]
        ];
        for(const [needle,replacement] of substitutions) {
            if(!site.includes(needle))throw Error('Unexpected production Nginx template change: '+needle);
            site=site.replaceAll(needle,replacement);
        }
        const config=path.join(temp,'nginx.conf');
        await fs.writeFile(config,
            'worker_processes 1;\npid '+path.join(temp,'nginx.pid')+';\n'+
            'error_log '+path.join(temp,'error.log')+' warn;\n'+
            'events { worker_connections 256; }\n'+
            'http { include /etc/nginx/mime.types; access_log off;\n'+site+'\n}\n');
        execFileSync('nginx',['-t','-p',temp+'/', '-c',config], {stdio:'ignore'});
        nginx=spawn('nginx',['-p',temp+'/', '-c',config, '-g','daemon off;'], {stdio:'ignore'});
        let up=false;
        for(let i=0;i<100;i++){
            if(nginx.exitCode!==null)throw Error('Ephemeral nginx exited');
            try{const response=await request('https:',httpsPort,'/health');
                if(response.status===200){up=true;break;}
            }catch{}
            await sleep(50);
        }
        assert.equal(up,true,'Ephemeral TLS proxy must start');
        const health=await request('https:',httpsPort,'/health');
        assert.equal(health.body,'Zeydrop static OK\n');
        assert.match(health.headers['strict-transport-security'],/max-age=/);
        assert.equal(health.headers['referrer-policy'],'no-referrer');
        assert.ok(health.headers['content-security-policy'].includes('object-src \'none\''));
        const html=await request('https:',httpsPort,'/');
        assert.equal(html.status,200);
        assert.ok(html.body.includes('Zeydrop'));
        const blocked=await request('https:',httpsPort,'/','POST',Buffer.from('upload-body'));
        assert.ok([403,405].includes(blocked.status),'Uploading must be denied');
        const forbidden=await request('https:',httpsPort,'/server/upload','POST',Buffer.from('file-payload'));
        assert.ok([403,404,405].includes(forbidden.status));
        const redirect=await request('http:',httpPort,'/nonexistent');
        assert.equal(redirect.status,308);
        const url='wss://127.0.0.1:'+httpsPort+'/server/webrtc';
        const origin='https://localhost:'+httpsPort;
        const a=await websocket(url,origin);clients.push(a.ws);
        a.send({type:'hello'});
        const aHello=await a.wait(msg=>msg.type==='hello');
        assert.equal(typeof aHello.peerId,'string');
        const room='a'.repeat(32);
        a.send({type:'create-room',roomId:room});
        await a.wait(msg=>msg.type==='room-joined');
        const b=await websocket(url,origin);clients.push(b.ws);
        b.send({type:'hello'});
        await b.wait(msg=>msg.type==='hello');
        b.send({type:'join-room',roomId:room});
        await b.wait(msg=>msg.type==='room-joined'&&msg.paired);
        await a.wait(msg=>msg.type==='room-joined'&&msg.paired);
        const bad=new WebSocket(url,{origin:'https://evil.invalid',rejectUnauthorized:false});
        const refused=await new Promise(resolve=>{
            bad.once('unexpected-response',(_,res)=>{res.resume();resolve(res.statusCode);});
            bad.once('error',()=>resolve(0));
        });
        assert.ok([401,403].includes(refused),'Origin protection must apply behind TLS proxy');
        const serverBytes=[...backend.connections.values()].map(peer=>peer.bytes);
        assert.equal(serverBytes.length,2);
        assert.ok(serverBytes.every(n=>n<2048),'Signaling only; no file payload');
        console.log(JSON.stringify({passed:true,scope:'ephemeral self-signed TLS proxy',
            checks:['real Nginx HTTPS static and security headers','HTTP redirect',
                'upload rejection','Origin ACL on WebSocket upgrade',
                'two-client WSS pairing','no file proxy'],httpsPort:undefined}));
    } finally {
        for (const ws of clients) ws.terminate();
        if (nginx && nginx.exitCode===null) {
            nginx.kill('SIGTERM');
            await Promise.race([new Promise(resolve=>nginx.once('exit',resolve)),sleep(2000)]);
            if (nginx.exitCode===null) nginx.kill('SIGKILL');
        }
        await backend.close();
        await fs.rm(temp,{recursive:true,force:true});
    }
}
main().catch(err=>{ console.error(err);process.exitCode=1; });
