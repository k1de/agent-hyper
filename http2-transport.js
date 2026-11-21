const http2 = require('http2');
const { errorMonitor } = require('events');
const { isIP, isIPv6 } = require('net');
const tls = require('tls');
const createProxyConnection = require('./proxy-connection');

const http2TransportDefaults = {
    timeout: 5000,
    idleTimeout: 5000,
};

const excludedRequestHeaders = new Set([
    'host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'proxy-authorization', 'proxy-authenticate', 'http2-settings',
]);

// Copy mutable option data while preserving native TLS objects and callbacks.
function cloneTransportOptionValue(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (Array.isArray(value)) return value.map(cloneTransportOptionValue);
    if (value && typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTransportOptionValue(item)]));
        }
    }
    return value;
}

function resolveHttp2TransportOptions(options = {}) {
    return {
        proxy: options.proxy == null ? null : new URL(options.proxy),
        timeout: options.timeout ?? http2TransportDefaults.timeout,
        idleTimeout: options.idleTimeout ?? http2TransportDefaults.idleTimeout,
        proxyRequestOptions: cloneTransportOptionValue(options.proxyRequestOptions || {}),
        originTls: cloneTransportOptionValue(options.originTls),
    };
}

function requestHeaders(origin, options) {
    const name = options.hostname || options.host;
    const host = isIPv6(name) ? `[${name}]` : name || origin.hostname;
    const port = options.port ?? (name ? '' : origin.port);
    const protocol = options.protocol || origin.protocol;
    const target = new URL(`${protocol}//${host}${port ? ':' + port : ''}`);
    if (target.origin !== origin.origin) throw new Error('HTTP/2 REQUEST ORIGIN MISMATCH');
    if (options.socketPath) throw new Error('HTTP/2 UNSUPPORTED SOCKET PATH');

    const method = options.method || 'GET';
    const path = options.path || '/';
    if (!path.startsWith('/') && !(method === 'OPTIONS' && path === '*')) throw new TypeError('HTTP/2 EXPECTED ORIGIN-RELATIVE PATH');
    const headers = {
        __proto__: null,
        ':authority': origin.host,
        ':method': method,
        ':path': path,
        ':scheme': origin.protocol.slice(0, -1),
    };
    const fields = Object.entries(options.headers || {});
    const connectionFields = new Set();
    for (const [name, value] of fields) {
        if (name.toLowerCase() === 'connection') {
            for (const field of String(value).split(',')) connectionFields.add(field.trim().toLowerCase());
        }
    }
    for (const [name, value] of fields) {
        const key = name.toLowerCase();
        if (value == null || key.startsWith(':') || excludedRequestHeaders.has(key) || connectionFields.has(key)) continue;
        if (key === 'te' && String(value).toLowerCase() !== 'trailers') continue;
        headers[key] = value;
    }
    if (options.auth && !headers.authorization) headers.authorization = 'Basic ' + Buffer.from(options.auth).toString('base64');
    return headers;
}

function transportFor(origin, session, idleTimeout, onClose) {
    let accepting = true;
    let streams = 0;
    let idleTimer;
    const stop = () => {
        accepting = false;
        clearTimeout(idleTimer);
    };
    session.once('goaway', stop);
    session.on('error', stop);
    const closed = new Promise((resolve) => session.once('close', () => {
        stop();
        onClose?.();
        resolve();
    }));

    function close() {
        stop();
        if (!session.destroyed) session.ref();
        session.close();
        return closed;
    }

    function idle() {
        if (!accepting || streams) return;
        session.unref();
        if (idleTimeout) idleTimer = setTimeout(close, idleTimeout).unref();
    }
    idle();

    return {
        get accepting() { return accepting && !session.closed && !session.destroyed; },
        request(options, callback) {
            if (!this.accepting) throw new Error('HTTP/2 TRANSPORT CLOSED');
            const stream = session.request(requestHeaders(origin, options), { endStream: false });
            clearTimeout(idleTimer);
            session.ref();
            streams++;
            stream.once('close', () => {
                streams--;
                idle();
            });
            const onPrematureClose = () => stream.emit('error', new Error('HTTP/2 STREAM CLOSED BEFORE RESPONSE HEADERS'));
            stream.once('close', onPrematureClose);
            stream.once(errorMonitor, () => stream.off('close', onPrematureClose));
            stream.once('response', ({ ':status': status, ...headers }) => {
                stream.off('close', onPrematureClose);
                stream.statusCode = status;
                stream.statusMessage = '';
                stream.headers = headers;
                if (callback) callback(stream);
            });
            return stream;
        },
        close,
    };
}

// A peer can close cleanly before the TLS handshake or the first SETTINGS frame.
async function waitFor(resource, event, closedMessage) {
    let ready, fail;
    const closed = () => fail(new Error(closedMessage));
    try {
        await new Promise((resolve, reject) => {
            ready = resolve;
            fail = reject;
            resource.once(event, ready).once('error', fail).once('close', closed);
        });
    } finally {
        resource.off(event, ready).off('error', fail).off('close', closed);
    }
}

async function createHttp2Transport(origin, options, owner) {
    origin = new URL(origin);
    const secure = origin.protocol === 'https:';
    if (!secure && origin.protocol !== 'http:') throw new TypeError('HTTP/2 UNSUPPORTED ORIGIN SCHEME');
    const { proxy, originTls, proxyRequestOptions, timeout, idleTimeout } = owner ? options : resolveHttp2TransportOptions(options);
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const port = Number(origin.port || (secure ? 443 : 80));
    let active, tunnel, openingError;
    function cancel(err) {
        openingError = err;
        active?.destroy();
    }
    if (owner) owner.cancelOpening = () => cancel(new Error('HTTP/2 SETUP CANCELLED BY POOL'));
    const timer = timeout && setTimeout(() => cancel(new Error('HTTP/2 SETUP TIMEOUT')), timeout);
    try {
        if (proxy) {
            tunnel = await new Promise((resolve, reject) => {
                active = createProxyConnection(proxy, proxyRequestOptions, { host, port, keepAlive: true },
                    (err, socket) => err ? reject(err) : resolve(socket));
            });
            if (openingError) throw openingError;
        }
        let socket = tunnel;
        if (secure) {
            socket = tls.connect({
                ...originTls, host, port, socket: tunnel,
                servername: isIP(host) ? undefined : host,
                ALPNProtocols: ['h2'],
            });
            active = socket;
            await waitFor(socket, 'secureConnect', 'HTTP/2 CONNECTION CLOSED DURING TLS HANDSHAKE');
            if (openingError) throw openingError;
            if (socket.alpnProtocol !== 'h2') throw new Error('HTTP/2 ALPN NEGOTIATION FAILED');
        }

        const session = http2.connect(origin, socket ? { createConnection: () => socket } : undefined);
        active = session;
        await waitFor(session, 'remoteSettings', 'HTTP/2 SESSION CLOSED BEFORE SETTINGS');
        if (openingError) throw openingError;
        if (session.closed || session.destroyed) throw new Error('HTTP/2 SESSION CLOSED DURING SETUP');
        const transport = transportFor(origin, session, idleTimeout, owner?.onClose);
        if (owner) owner.transport = transport;
        return transport;
    } catch (err) {
        active?.destroy();
        tunnel?.destroy();
        throw openingError || err;
    } finally {
        clearTimeout(timer);
        if (owner) owner.cancelOpening = undefined;
    }
}

module.exports = createHttp2Transport;
Object.defineProperty(module.exports, 'resolveHttp2TransportOptions', { value: resolveHttp2TransportOptions });
