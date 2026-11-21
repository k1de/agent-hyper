const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const servers = [];
const sockets = new Set();

function certificate(dir, name, san) {
    const key = join(dir, name + '.key');
    const cert = join(dir, name + '.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=' + name, '-addext', 'subjectAltName=' + san, '-keyout', key, '-out', cert], { stdio: 'pipe' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
}

async function listen(server, host = '127.0.0.1') {
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, host);
    await once(server, 'listening');
    servers.push(server);
    return server;
}

async function proxy(targets, credentials, host) {
    const server = credentials ? https.createServer(credentials) : http.createServer();
    server.requests = [];
    server.on('connect', (req, client, head) => {
        server.requests.push({ target: req.url, headers: req.headers, sni: client.servername });
        client.on('error', () => {});
        if (req.headers['x-deny']) return client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        if (server.stallNext || req.headers['x-stall']) {
            server.stallNext = false;
            client.on('end', () => client.end());
            client.resume();
            return;
        }
        const port = Number(req.url.split(':').pop());
        if (!targets.some((target) => target.address().port === port)) return client.destroy();
        const upstream = net.connect(port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client).pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        upstream.on('close', () => client.destroy());
        client.on('close', () => upstream.destroy());
    });
    await listen(server, host);
    const address = server.address();
    server.url = (credentials ? 'https' : 'http') + '://user:pass@' +
        (net.isIPv6(address.address) ? '[' + address.address + ']' : address.address) + ':' + address.port;
    return server;
}

function certificates() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hyper-'));
    try {
        return {
            dnsCert: certificate(dir, 'localhost', 'DNS:localhost'),
            ipCert: certificate(dir, 'proxy', 'IP:127.0.0.1,IP:::1'),
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function closeServers() {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}

module.exports = { certificates, listen, proxy, closeServers };
