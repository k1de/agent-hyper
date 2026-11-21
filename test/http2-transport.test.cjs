const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const axios = require('axios');
const { createHttp2Transport, createHttp2TransportPool } = require('agent-hyper');
const { certificates, listen, proxy, closeServers } = require('./helpers.cjs');

let dnsCert, ipCert, origin, originURL, cleartextURL, tcpProxy, ipProxy, dnsProxy;
let connections = 0;
let sessions = 0;
let streams = 0;

before(async () => {
    ({ dnsCert, ipCert } = certificates());
    const echo = async (req, res) => {
        if (req.url === '/hold') return;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.writeHead(201, { 'content-type': 'application/json', 'x-answer': 'yes' });
        res.end(JSON.stringify({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString(),
            headers: req.headers, rawHeaders: req.rawHeaders, sni: req.socket.servername }));
    };
    origin = await listen(http2.createSecureServer(dnsCert, echo));
    const cleartextOrigin = await listen(http2.createServer(echo));
    cleartextOrigin.on('session', () => sessions++);
    origin.on('connection', () => connections++);
    origin.on('session', () => sessions++);
    origin.on('stream', () => streams++);
    originURL = 'https://localhost:' + origin.address().port;
    cleartextURL = 'http://localhost:' + cleartextOrigin.address().port;
    tcpProxy = await proxy([origin, cleartextOrigin]);
    ipProxy = await proxy([origin, cleartextOrigin], ipCert);
    dnsProxy = await proxy([origin], dnsCert);
});

after(closeServers);

function options(server, ca = ipCert.cert) {
    return { originTls: { ca: dnsCert.cert }, proxy: server?.url, proxyRequestOptions: { ca } };
}

async function checkPosts(t, url, server) {
    const target = new URL(url);
    const count = server?.requests.length;
    const start = sessions;
    const transport = await createHttp2Transport(url, { ...options(server), timeout: 1500 });
    t.after(() => transport.close());
    assert.equal(transport.accepting, true);
    const pairs = [['x-end', 'delivered'], ['Proxy-Authorization', 'never-at-origin'], ['Host', 'ignored.invalid'],
        ['Connection', 'x-drop'], ['x-drop', 'drop']];
    for (const [i, fields] of [pairs, [...pairs].reverse()].entries()) {
        const path = '/echo?i=' + i;
        const response = await axios.post(url + path, { i }, {
            transport, proxy: false, timeout: 1500, headers: Object.fromEntries(fields),
        });
        const { headers, rawHeaders, body, sni } = response.data;
        assert.equal(response.status, 201);
        assert.equal(response.statusText, '');
        assert.equal(response.headers['x-answer'], 'yes');
        assert.deepEqual(JSON.parse(body), { i });
        assert.deepEqual(rawHeaders.slice(0, 8), [':authority', target.host, ':method', 'POST', ':path', path, ':scheme', target.protocol.slice(0, -1)]);
        assert.equal(headers['x-end'], 'delivered');
        assert.equal(sni, target.protocol === 'https:' ? 'localhost' : undefined);
        for (const name of ['proxy-authorization', 'x-drop', 'host', 'connection']) assert.equal(headers[name], undefined);
    }
    assert.equal(sessions - start, 1);
    if (server) {
        assert.equal(server.requests.length - count, 1);
        assert.equal(server.requests[count].target, target.host);
        assert.equal(server.requests[count].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:pass').toString('base64'));
        assert.ok(!server.requests[count].sni);
    }
}

for (const mode of ['direct', 'http', 'https']) {
    test(mode + ' sends two Axios POSTs on one TLS session', (t) =>
        checkPosts(t, originURL, { http: tcpProxy, https: ipProxy }[mode]));
    test(mode + ' sends two Axios POSTs on one h2c session', (t) =>
        checkPosts(t, cleartextURL, { http: tcpProxy, https: ipProxy }[mode]));
}

test('request builds its own pseudo-headers and filters connection-specific fields', async (t) => {
    const transport = await createHttp2Transport(originURL, options());
    t.after(() => transport.close());
    const headers = {
        ':scheme': 'http', ':path': '/wrong', ':method': 'DELETE', ':authority': 'wrong.example',
        TE: 'trailers', Connection: ['x-hop', 'Keep-Alive'], 'X-Hop': 'drop', 'X-End': 'keep',
    };
    for (const te of ['trailers', 'gzip']) {
        const stream = transport.request({ method: 'GET', path: '/actual', auth: 'a:b', headers: { ...headers, TE: te } });
        stream.end();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const { rawHeaders, headers: received } = JSON.parse(Buffer.concat(chunks));
        assert.deepEqual(rawHeaders.slice(0, 8), [
            ':authority', new URL(originURL).host, ':method', 'GET', ':path', '/actual', ':scheme', 'https',
        ]);
        assert.deepEqual(rawHeaders.filter((name, i) => i % 2 === 0 && name.startsWith(':')),
            [':authority', ':method', ':path', ':scheme']);
        assert.equal(received.te, te === 'trailers' ? 'trailers' : undefined);
        assert.equal(received['x-hop'], undefined);
        assert.equal(received['x-end'], 'keep');
        assert.equal(received.authorization, 'Basic ' + Buffer.from('a:b').toString('base64'));
    }
});

test('standalone and pooled transports report unsupported schemes and preserve URL parsing errors', async () => {
    const transportPool = createHttp2TransportPool();
    for (const open of [createHttp2Transport, transportPool.get]) {
        await assert.rejects(open('ftp://localhost'), { name: 'TypeError', message: 'HTTP/2 UNSUPPORTED ORIGIN SCHEME' });
        await assert.rejects(open('invalid-url'), { code: 'ERR_INVALID_URL' });
    }
});

test('HTTPS proxy and destination certificates are checked against their own addresses', async () => {
    const mismatch = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' };
    const start = connections;
    await assert.rejects(createHttp2Transport(originURL, options(dnsProxy, dnsCert.cert)), mismatch);
    assert.equal(connections, start);
    await assert.rejects(createHttp2Transport(originURL.replace('localhost', '127.0.0.1'), options(ipProxy)), mismatch);

    const byName = { ...options(dnsProxy, dnsCert.cert), proxy: dnsProxy.url.replace('127.0.0.1', 'localhost') };
    const transport = await createHttp2Transport(originURL, byName);
    await transport.close();
    assert.equal(dnsProxy.requests.at(-1).sni, 'localhost');
});

test('IPv6 proxy literals omit SNI', async (t) => {
    let server;
    try { server = await proxy([origin], ipCert, '::1'); } catch (err) {
        if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) return t.skip('IPv6 loopback unavailable');
        throw err;
    }
    const transport = await createHttp2Transport(originURL, options(server));
    await transport.close();
    assert.ok(!server.requests[0].sni);
});

test('407 prevents a connection to the origin; TLS must negotiate h2', async () => {
    const start = connections;
    await assert.rejects(createHttp2Transport(originURL, {
        ...options(tcpProxy), proxyRequestOptions: { headers: { 'x-deny': '1' } },
    }), { message: 'PROXY HTTP 407' });
    assert.equal(connections - start, 0);
    const server = await listen(https.createServer({ ...ipCert, ALPNProtocols: [] }));
    await assert.rejects(createHttp2Transport('https://127.0.0.1:' + server.address().port,
        { originTls: { ca: ipCert.cert } }), { message: 'HTTP/2 ALPN NEGOTIATION FAILED' });
});

test('h2c sends CONNECT to port 80 when the origin omits the port', async () => {
    const count = tcpProxy.requests.length;
    await assert.rejects(createHttp2Transport('http://localhost', {
        proxy: tcpProxy.url, proxyRequestOptions: { headers: { 'x-deny': '1' } }, timeout: 1500,
    }), { message: 'PROXY HTTP 407' });
    assert.equal(tcpProxy.requests.length, count + 1);
    assert.equal(tcpProxy.requests[count].target, 'localhost:80');
});

test('opening timeout closes the peer socket during CONNECT, TLS and SETTINGS', { timeout: 5000 }, async () => {
    const tlsStall = await listen(net.createServer((peer) => peer.resume()));
    const settingsStall = await listen(tls.createServer({ ...ipCert, ALPNProtocols: ['h2'] }, (peer) => peer.resume()));
    for (const [server, scheme] of [[tcpProxy, 'https'], [tlsStall, 'https'], [settingsStall, 'https'], [tlsStall, 'http']]) {
        const received = once(server, 'connection').then(([socket]) => once(socket, 'close'));
        const target = server === tcpProxy ? originURL : scheme + '://127.0.0.1:' + server.address().port;
        await assert.rejects(createHttp2Transport(target, {
            proxy: server === tcpProxy ? tcpProxy.url : undefined, proxyRequestOptions: { headers: { 'x-stall': '1' } },
            originTls: { ca: ipCert.cert }, timeout: 100,
        }), { message: 'HTTP/2 SETUP TIMEOUT' });
        await received;
    }
});

test('a clean close before SETTINGS reports the interrupted setup stage', async () => {
    const server = await listen(net.createServer((peer) => peer.once('data', () => peer.end())));
    await assert.rejects(createHttp2Transport('http://127.0.0.1:' + server.address().port), {
        message: 'HTTP/2 SESSION CLOSED BEFORE SETTINGS',
    });
});

test('opening defaults to five seconds and explicit zero waits for the proxy reply', { timeout: 9000 }, async (t) => {
    const server = await proxy([origin]);
    server.on('connect', (_, peer) => {
        peer.setTimeout(5500, () => peer.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
    });
    const config = { proxy: server.url, proxyRequestOptions: { headers: { 'x-stall': '1' } } };
    const transportPool = createHttp2TransportPool({ ...config, timeout: 0 });
    t.after(() => transportPool.close());
    const start = performance.now();
    await Promise.all([
        assert.rejects(createHttp2Transport(originURL, config), { message: 'HTTP/2 SETUP TIMEOUT' }).then(() => {
            assert.ok(performance.now() - start >= 4900);
        }),
        assert.rejects(transportPool.get(originURL), { message: 'PROXY HTTP 407' }),
    ]);
});

test('a bound transport rejects other origins; timeout and cancellation leave the session usable', async (t) => {
    const transport = await createHttp2Transport(originURL, options());
    t.after(() => transport.close());
    const config = { transport, proxy: false };
    const start = connections;
    const beforeRequests = streams;
    for (const url of [originURL.replace('localhost', '127.0.0.1'), 'https://localhost', originURL.replace('https:', 'http:')]) {
        await assert.rejects(axios.get(url, config), { message: 'HTTP/2 REQUEST ORIGIN MISMATCH' });
    }
    assert.throws(() => transport.request({ socketPath: '/socket' }), { message: 'HTTP/2 UNSUPPORTED SOCKET PATH' });
    assert.throws(() => transport.request({ path: 'relative' }), { name: 'TypeError', message: 'HTTP/2 EXPECTED ORIGIN-RELATIVE PATH' });
    assert.equal(connections, start);
    assert.equal(streams, beforeRequests);
    await assert.rejects(axios.get(originURL + '/hold', { ...config, timeout: 60 }), { code: 'ECONNABORTED' });
    const controller = new AbortController();
    const arrived = once(origin, 'stream');
    const aborted = axios.get(originURL + '/hold', { ...config, signal: controller.signal });
    await arrived;
    controller.abort();
    await assert.rejects(aborted, { code: 'ERR_CANCELED' });
    assert.equal((await axios.get(originURL, config)).status, 201);
    assert.equal(connections, start);
});

test('a reset before response headers rejects the Axios request and preserves the session', { timeout: 2000 }, async (t) => {
    const start = sessions;
    const transport = await createHttp2Transport(originURL, options());
    t.after(() => transport.close());
    const config = { transport, proxy: false, timeout: 10000 };
    origin.once('stream', (stream) => stream.close(http2.constants.NGHTTP2_CANCEL));
    await assert.rejects(axios.get(originURL + '/hold', config), (err) =>
        axios.isAxiosError(err) && !err.response && err.message === 'HTTP/2 STREAM CLOSED BEFORE RESPONSE HEADERS');
    assert.equal((await axios.get(originURL, config)).status, 201);
    assert.equal(sessions - start, 1);
});

test('Axios receives the native HTTP/2 error code when a stream is refused', async (t) => {
    const transport = await createHttp2Transport(originURL, options());
    t.after(() => transport.close());
    origin.once('stream', (stream) => {
        stream.once('error', () => {});
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    });
    await assert.rejects(axios.get(originURL + '/hold', { transport, proxy: false, timeout: 1500 }), {
        code: 'ERR_HTTP2_STREAM_ERROR',
    });
});

test('a failed session stops accepting requests and can be closed', async () => {
    const connected = once(origin, 'session');
    const transport = await createHttp2Transport(originURL, options());
    const [session] = await connected;
    session.destroy(undefined, http2.constants.NGHTTP2_INTERNAL_ERROR);
    await once(session, 'close');
    for (let i = 0; transport.accepting && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(transport.accepting, false);
    assert.throws(() => transport.request({}), { message: 'HTTP/2 TRANSPORT CLOSED' });
    await transport.close();
});

test('standalone factories and separate pools open independent sessions', async (t) => {
    const config = options();
    const start = sessions;
    const [first, second] = await Promise.all([
        createHttp2Transport(originURL, config), createHttp2Transport(originURL, config),
    ]);
    t.after(() => Promise.all([first.close(), second.close()]));
    assert.notEqual(first, second);
    const transportPool = createHttp2TransportPool(config);
    const otherTransportPool = createHttp2TransportPool(config);
    t.after(() => Promise.all([transportPool.close(), otherTransportPool.close()]));
    const [third, fourth] = await Promise.all([transportPool.get(originURL), otherTransportPool.get(originURL)]);
    assert.equal(new Set([first, second, third, fourth]).size, 4);
    assert.equal(sessions - start, 4);
});

test('a pool shares concurrent opens by HTTPS origin and serves different domains', async (t) => {
    const other = await listen(http2.createSecureServer(ipCert, (req, res) => res.end('other origin')));
    const otherURL = 'https://127.0.0.1:' + other.address().port;
    const transportPool = createHttp2TransportPool({ originTls: { ca: [dnsCert.cert, ipCert.cert] } });
    t.after(() => transportPool.close());
    const start = sessions;
    const [first, second] = await Promise.all([
        transportPool.get(originURL + '/one'), transportPool.get(new URL(originURL + '/two')),
    ]);
    assert.equal(first, second);
    const alternate = await transportPool.get(otherURL);
    assert.notEqual(alternate, first);
    assert.equal(await transportPool.get(originURL), first);
    const client = async config => axios({ ...config, transport: await transportPool.get(axios.getUri(config)) });
    assert.equal((await client({ method: 'get', url: otherURL })).data, 'other origin');
    const { data } = await client({ method: 'post', baseURL: originURL, url: '/echo', params: { q: 1 }, data: 'body' });
    assert.deepEqual([data.method, data.path, data.body], ['POST', '/echo?q=1', 'body']);
    assert.equal(sessions - start, 1);
});

test('a pool distinguishes h2c and TLS origins and reuses each session', { timeout: 4000 }, async (t) => {
    const transportPool = createHttp2TransportPool({ ...options(), timeout: 1500 });
    t.after(() => transportPool.close());
    const [cleartext, secure] = await Promise.all([transportPool.get(cleartextURL), transportPool.get(originURL)]);
    assert.notEqual(cleartext, secure);
    // Same host and port as the cached TLS session, but the server only accepts TLS.
    await assert.rejects(transportPool.get(originURL.replace('https:', 'http:')));
    for (const [url, transport, scheme] of [[cleartextURL, cleartext, 'http'], [originURL, secure, 'https']]) {
        assert.equal(await transportPool.get(url + '/echo'), transport);
        const { data } = await axios.get(url + '/echo', { transport, proxy: false, timeout: 1500 });
        assert.equal(data.headers[':scheme'], scheme);
    }
});

test('pool options are fixed, including proxy address, CONNECT headers and TLS trust', async (t) => {
    const config = options(ipProxy);
    config.proxy = new URL(config.proxy);
    config.proxyRequestOptions.headers = { 'x-route': 'original' };
    config.originTls.ca = Buffer.from(dnsCert.cert);
    const transportPool = createHttp2TransportPool(config);
    t.after(() => transportPool.close());
    config.proxy.port = 1;
    config.proxyRequestOptions.headers['x-route'] = 'changed';
    config.originTls.ca.fill(0);

    const start = ipProxy.requests.length;
    const first = await transportPool.get(originURL);
    assert.equal(await transportPool.get(originURL), first);
    assert.equal(ipProxy.requests.length - start, 1);
    assert.equal(ipProxy.requests.at(-1).headers['x-route'], 'original');
    const closing = first.close();
    const second = await transportPool.get(originURL);
    await closing;
    assert.notEqual(first, second);
    assert.equal(await transportPool.get(originURL), second);

    const deny = options(ipProxy);
    deny.proxyRequestOptions.headers = { 'x-deny': '1' };
    const deniedTransportPool = createHttp2TransportPool(deny);
    t.after(() => deniedTransportPool.close());
    for (let i = 0; i < 2; i++) await assert.rejects(deniedTransportPool.get(originURL), { message: 'PROXY HTTP 407' });
    assert.equal(ipProxy.requests.length - start, 4);
    const untrusted = createHttp2TransportPool({ ...options(ipProxy), originTls: { ca: ipCert.cert } });
    t.after(() => untrusted.close());
    await assert.rejects(untrusted.get(originURL), /certificate/i);
});

test('pool close cancels ongoing CONNECT and immediately allows new gets for the same origin', { timeout: 3000 }, async (t) => {
    const server = await proxy([origin]);
    server.stallNext = true;
    const transportPool = createHttp2TransportPool({ ...options(server), timeout: 0 });
    t.after(() => transportPool.close());
    const connected = once(server, 'connect');
    const rejected = [1, 2].map(() => assert.rejects(transportPool.get(originURL), { message: 'HTTP/2 SETUP CANCELLED BY POOL' }));
    const [, client] = await connected;
    const socketClosed = once(client, 'close');
    const drained = transportPool.close();
    const next = transportPool.get(originURL);
    await Promise.all([...rejected, drained, socketClosed]);
    const transport = await next;
    assert.equal(server.requests.length, 2);
    assert.equal(await transportPool.get(originURL), transport);
    assert.equal((await axios.get(originURL, { transport, proxy: false })).status, 201);
});

test('pool close drains active streams while a new session serves the same origin', { timeout: 3000 }, async (t) => {
    const transportPool = createHttp2TransportPool(options());
    t.after(() => transportPool.close());
    const first = await transportPool.get(originURL);
    const arrived = once(origin, 'stream');
    const held = axios.get(originURL + '/hold', { transport: first, proxy: false });
    const [stream] = await arrived;
    try {
        let finished = false;
        const draining = transportPool.close().then(() => { finished = true; });
        const again = transportPool.close();
        assert.equal(first.accepting, false);
        const next = await transportPool.get(originURL);
        assert.notEqual(next, first);
        assert.equal((await axios.get(originURL, { transport: next, proxy: false })).status, 201);
        assert.equal(finished, false);
        stream.respond({ ':status': 200 });
        stream.end('drained');
        assert.equal((await held).data, 'drained');
        await Promise.all([draining, again]);
        assert.equal(await transportPool.get(originURL), next);
    } finally {
        stream.close();
    }
});

test('pool close cancels pending TLS and SETTINGS even with the opening timeout disabled', { timeout: 3000 }, async () => {
    const tlsStall = await listen(net.createServer((peer) => peer.resume()));
    const settingsStall = await listen(tls.createServer({ ...ipCert, ALPNProtocols: ['h2'] }, (peer) => peer.resume()));
    for (const server of [tlsStall, settingsStall]) {
        const transportPool = createHttp2TransportPool({ originTls: { ca: ipCert.cert }, timeout: 0 });
        const connected = once(server, server === tlsStall ? 'connection' : 'secureConnection');
        const rejected = assert.rejects(transportPool.get('https://127.0.0.1:' + server.address().port), {
            message: 'HTTP/2 SETUP CANCELLED BY POOL',
        });
        const [socket] = await connected;
        const closed = once(socket, 'close');
        await Promise.all([transportPool.close(), rejected, closed]);
    }
});

test('idle sessions close after five seconds by default and stay open with idleTimeout zero', { timeout: 8000 }, async (t) => {
    const transportPool = createHttp2TransportPool({ ...options(), timeout: 0 });
    const persistent = await createHttp2Transport(originURL, { ...options(), idleTimeout: 0 });
    t.after(() => Promise.all([persistent.close(), transportPool.close()]));
    const standalone = await createHttp2Transport(originURL, options());
    t.after(() => standalone.close());
    const closed = once(origin, 'session').then(([peer]) => once(peer, 'close'));
    const start = performance.now();
    const pooled = await transportPool.get(originURL);
    await closed;
    assert.ok(performance.now() - start >= 4900);
    assert.equal(standalone.accepting, false);
    assert.equal(pooled.accepting, false);
    assert.equal(persistent.accepting, true);
    const next = await transportPool.get(originURL);
    assert.notEqual(next, pooled);
    assert.equal((await axios.get(originURL, { transport: next, proxy: false })).status, 201);
});

test('idle expiry starts on open and restarts only after the last stream closes', { timeout: 4000 }, async (t) => {
    const config = { ...options(), idleTimeout: 50 };
    const transportPool = createHttp2TransportPool(config);
    t.after(() => transportPool.close());
    const connected = once(origin, 'session');
    const unused = await transportPool.get(originURL);
    const [peer] = await connected;
    await once(peer, 'close');
    assert.equal(unused.accepting, false);

    const next = once(origin, 'session');
    const transport = await transportPool.get(originURL);
    assert.notEqual(transport, unused);
    t.after(() => transport.close());
    const [session] = await next;
    const arrived = once(origin, 'stream');
    const axiosConfig = { transport, proxy: false, timeout: 1500 };
    const held = axios.get(originURL + '/hold', axiosConfig);
    const [stream] = await arrived;
    assert.equal((await axios.get(originURL, axiosConfig)).status, 201);
    await new Promise((resolve) => setTimeout(resolve, config.idleTimeout * 2));
    assert.equal(transport.accepting, true);
    const closed = once(session, 'close');
    stream.respond({ ':status': 200 });
    stream.end('done');
    assert.equal((await held).data, 'done');
    await closed;
    assert.equal(transport.accepting, false);
});

test('GOAWAY drains the accepted stream and close is idempotent', { timeout: 4000 }, async (t) => {
    const transportPool = createHttp2TransportPool(options());
    t.after(() => transportPool.close());
    const transport = await transportPool.get(originURL);
    const arrived = once(origin, 'stream');
    const response = axios.get(originURL + '/hold', { transport, proxy: false, timeout: 2000 });
    const [stream] = await arrived;
    try {
        stream.session.goaway(0, stream.id);
        for (let i = 0; transport.accepting && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(transport.accepting, false);
        assert.throws(() => transport.request({ path: '/' }), { message: 'HTTP/2 TRANSPORT CLOSED' });
        const closed = transport.close();
        assert.equal(transport.close(), closed);
        const successor = await transportPool.get(originURL);
        assert.notEqual(successor, transport);
        stream.respond({ ':status': 200 });
        stream.end('finished');
        assert.equal((await response).data, 'finished');
        await closed;
        await transport.close();
        assert.equal(await transportPool.get(originURL), successor);
    } finally {
        stream.close();
        await transport.close();
    }
});
