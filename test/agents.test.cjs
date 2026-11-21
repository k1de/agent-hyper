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
    const echo = (req, res) => res.end(JSON.stringify({ path: req.url, headers: req.headers, sni: req.socket.servername }));
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
    test(Agent.name + ' applies defaults and accepts explicit overrides', () => {
        const defaults = { keepAlive: true, keepAliveMsecs: 1000, scheduling: 'lifo', timeout: 5000 };
        const overrides = { keepAlive: false, keepAliveMsecs: 250, scheduling: 'fifo', timeout: 0 };
        for (const options of [{}, overrides]) {
            const agent = new Agent({ proxy: httpProxy.url, ...options });
            for (const [key, value] of Object.entries({ ...defaults, ...options })) assert.equal(agent.options[key], value, key);
        }
    });

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

    test(Agent.name + ' verifies an HTTPS proxy certificate against its IP', async (t) => {
        const agent = new Agent({ proxy: dnsProxy.url, proxyRequestOptions: { ca: dnsCert.cert }, ca: dnsCert.cert });
        t.after(() => agent.destroy());
        const initialConnections = connections;
        await assert.rejects(get(urls[protocol], agent), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        assert.equal(dnsProxy.requests.length, 0);
        assert.equal(connections, initialConnections);
    });

    test(Agent.name + ' reports CONNECT refusal and timeout without reaching the origin', { timeout: 3000 }, async (t) => {
        const initialConnections = connections;
        const start = httpProxy.requests.length;
        for (const [header, message] of [['x-deny', 'PROXY HTTP 407'], ['x-stall', 'PROXY TIMEOUT']]) {
            const agent = new Agent({ proxy: httpProxy.url, proxyRequestOptions: { headers: { [header]: '1' } }, timeout: 150 });
            t.after(() => agent.destroy());
            const closed = once(httpProxy, 'connect').then(([, socket]) => once(socket, 'close'));
            await assert.rejects(get(urls[protocol], agent), { message });
            await closed;
        }
        assert.equal(httpProxy.requests.length - start, 2);
        assert.equal(connections, initialConnections);
    });
}

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
