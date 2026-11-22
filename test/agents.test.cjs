const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { HttpProxyAgent, HttpsProxyAgent } = require('agent-hyper');
const { certificates, listen, proxy, closeServers } = require('./helpers.cjs');

let dnsCert, ipCert, httpProxy, httpsProxy, dnsProxy;
const urls = {};
let connections = 0;

before(async () => {
    ({ dnsCert, ipCert } = certificates());
    const echo = (req, res) => {
        const reply = () => res.end(JSON.stringify({ path: req.url, headers: req.headers, sni: req.socket.servername }));
        if (req.url === '/slow') setTimeout(reply, 200);
        else reply();
    };
    const httpOrigin = await listen(http.createServer(echo));
    const httpsOrigin = await listen(https.createServer(dnsCert, echo));
    const origins = [httpOrigin, httpsOrigin];
    for (const origin of origins) origin.on('connection', () => connections++);
    urls.http = new URL('http://localhost:' + httpOrigin.address().port);
    urls.https = new URL('https://localhost:' + httpsOrigin.address().port);
    httpProxy = await proxy(origins);
    httpsProxy = await proxy(origins, ipCert);
    dnsProxy = await proxy(origins, dnsCert);
});

after(closeServers);

async function get(url, agent) {
    const client = url.protocol === 'https:' ? https : http;
    const [response] = await once(client.get(url, { agent }), 'response');
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.statusCode, 200);
    return JSON.parse(Buffer.concat(chunks));
}

for (const [protocol, Agent] of [['http', HttpProxyAgent], ['https', HttpsProxyAgent]]) {
    for (const proxyProtocol of ['http', 'https']) {
        test(Agent.name + ' reuses a tunnel through an ' + proxyProtocol.toUpperCase() + ' proxy', async (t) => {
            const server = proxyProtocol === 'http' ? httpProxy : httpsProxy;
            const address = new URL(server.url);
            address.username = 'user%40example';
            address.password = 'p%3Ass';
            const agent = new Agent({
                proxy: proxyProtocol === 'http' ? address.href : address,
                proxyRequestOptions: { ca: ipCert.cert, headers: { 'x-tunnel': 'yes' } },
                ca: dnsCert.cert,
            });
            t.after(() => agent.destroy());
            const start = server.requests.length;
            const initialConnections = connections;
            for (const path of ['/first', '/second?q=2']) {
                const response = await get(new URL(path, urls[protocol]), agent);
                assert.equal(response.path, path);
                assert.equal(response.headers.host, urls[protocol].host);
                assert.equal(response.headers['proxy-authorization'], undefined);
                assert.equal(response.headers['x-tunnel'], undefined);
                if (protocol === 'https') assert.equal(response.sni, 'localhost');
            }
            assert.equal(connections - initialConnections, 1);
            assert.equal(server.requests.length - start, 1);
            const { target, headers, sni } = server.requests[start];
            assert.equal(target, urls[protocol].host);
            assert.equal(headers.host, target);
            assert.equal(headers.connection, 'keep-alive');
            assert.equal(headers['proxy-authorization'], 'Basic ' + Buffer.from('user@example:p:ss').toString('base64'));
            assert.equal(headers['x-tunnel'], 'yes');
            if (proxyProtocol === 'https') assert.equal(sni, false);
        });
    }
}

// The constructor, timers and CONNECT code are shared by both agents, so these run once on the HTTPS agent.
test('agents apply defaults and accept explicit overrides', () => {
    // http.Agent's own `timeout` option holds idleTimeout; the CONNECT limit is kept separately.
    const settings = (agent) => ({ keepAlive: agent.keepAlive, keepAliveMsecs: agent.keepAliveMsecs,
        scheduling: agent.scheduling, timeout: agent.connectTimeout, idleTimeout: agent.options.timeout });
    const defaults = { keepAlive: true, keepAliveMsecs: 1000, scheduling: 'lifo', timeout: 5000, idleTimeout: 10000 };
    const overrides = { keepAlive: false, keepAliveMsecs: 250, scheduling: 'fifo', timeout: 0, idleTimeout: 0 };
    const unset = Object.fromEntries(Object.keys(defaults).map((key) => [key, undefined]));
    for (const [options, expected] of [[{}, defaults], [unset, defaults], [overrides, overrides]]) {
        assert.deepEqual(settings(new HttpsProxyAgent({ proxy: httpProxy.url, ...options })), expected);
    }
    // Values Node's timers cannot hold disable the timer; the largest valid delay is kept.
    for (const [value, expected] of [[Infinity, 0], [2 ** 31 - 0.5, 0], [2 ** 31 - 1, 2 ** 31 - 1]]) {
        const limits = settings(new HttpsProxyAgent({ proxy: httpProxy.url, timeout: value, idleTimeout: value }));
        assert.deepEqual([limits.timeout, limits.idleTimeout], [expected, expected]);
    }
});

test('agents keep idle sockets for idleTimeout, independently of the CONNECT timeout', async (t) => {
    for (const [options, opened] of [[{ timeout: 50, idleTimeout: 1000 }, 1], [{ timeout: 5000, idleTimeout: 50 }, 2]]) {
        const agent = new HttpsProxyAgent({ proxy: httpProxy.url, ca: dnsCert.cert, ...options });
        t.after(() => agent.destroy());
        const start = connections;
        await get(urls.https, agent);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await get(urls.https, agent);
        assert.equal(connections - start, opened, JSON.stringify(options));
    }
});

// Here the raw tunnel socket carries the request, so a CONNECT timer left on it would cut the response.
test('a response may outlast the CONNECT timeout on new and reused sockets', async (t) => {
    const agent = new HttpProxyAgent({ proxy: httpProxy.url, timeout: 50 });
    t.after(() => agent.destroy());
    const start = connections;
    for (let i = 0; i < 2; i++) assert.equal((await get(new URL('/slow', urls.http), agent)).path, '/slow');
    assert.equal(connections - start, 1);
});

test('agents verify an HTTPS proxy certificate against its IP', async (t) => {
    const agent = new HttpsProxyAgent({ proxy: dnsProxy.url, proxyRequestOptions: { ca: dnsCert.cert }, ca: dnsCert.cert });
    t.after(() => agent.destroy());
    const initialConnections = connections;
    await assert.rejects(get(urls.https, agent), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    assert.equal(dnsProxy.requests.length, 0);
    assert.equal(connections, initialConnections);
});

test('agents report CONNECT refusal and timeout without reaching the origin', { timeout: 3000 }, async (t) => {
    const initialConnections = connections;
    const start = httpProxy.requests.length;
    for (const [header, message] of [['x-deny', 'PROXY HTTP 407'], ['x-stall', 'PROXY TIMEOUT']]) {
        const agent = new HttpsProxyAgent({ proxy: httpProxy.url, proxyRequestOptions: { headers: { [header]: '1' } }, timeout: 150 });
        t.after(() => agent.destroy());
        const closed = once(httpProxy, 'connect').then(([, socket]) => once(socket, 'close'));
        await assert.rejects(get(urls.https, agent), { message });
        await closed;
    }
    assert.equal(httpProxy.requests.length - start, 2);
    assert.equal(connections, initialConnections);
});

test('HttpsProxyAgent verifies the destination certificate inside an established tunnel', async (t) => {
    const agent = new HttpsProxyAgent({ proxy: httpsProxy.url, proxyRequestOptions: { ca: ipCert.cert }, ca: dnsCert.cert });
    t.after(() => agent.destroy());
    const url = new URL(urls.https);
    url.hostname = '127.0.0.1';
    const start = httpsProxy.requests.length;
    await assert.rejects(get(url, agent), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    assert.equal(httpsProxy.requests.length - start, 1);
    assert.equal(httpsProxy.requests[start].target, url.host);
});
