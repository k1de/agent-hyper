const http2 = require('http2');
const { errorMonitor } = require('events');
const { isIP, isIPv6 } = require('net');
const tls = require('tls');
const { createProxyConnection, normalizeTimeout } = require('./proxy-connection');

const excludedRequestHeaders = new Set([
    'host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'proxy-authorization', 'proxy-authenticate', 'http2-settings',
]);

const http2TransportDefaults = {
    connectTimeout: 5000,
    idleTimeout: 10000,
};

const streamWindowSize = 6 * 1024 * 1024;
const connectionWindowSize = 15 * 1024 * 1024;

// Shallow copies keep the options fixed when the caller later reuses its objects.
function resolveHttp2TransportOptions(options = {}) {
    return {
        // An empty proxy string, e.g. from an unset environment variable, means a direct connection.
        proxy: options.proxy ? new URL(options.proxy) : null,
        connectTimeout: normalizeTimeout(options.connectTimeout ?? http2TransportDefaults.connectTimeout),
        idleTimeout: normalizeTimeout(options.idleTimeout ?? http2TransportDefaults.idleTimeout),
        proxyRequestOptions: { ...options.proxyRequestOptions, headers: { ...options.proxyRequestOptions?.headers } },
        originTls: { ...options.originTls },
    };
}

function requestHeaders(origin, options) {
    const name = options.hostname || options.host;
    const host = isIPv6(name) ? `[${name}]` : name || origin.hostname;
    const port = options.port ?? (name ? '' : origin.port);
    const protocol = options.protocol || origin.protocol;
    const target = new URL(`${protocol}//${host}${port ? ':' + port : ''}`);
    if (target.origin !== origin.origin) throw new TypeError('REQUEST ORIGIN MISMATCH');

    const headers = {
        __proto__: null,
        ':authority': origin.host,
        ':method': options.method || 'GET',
        ':path': options.path || '/',
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
        if (value === undefined || value === null) continue;
        if (key.startsWith(':') || excludedRequestHeaders.has(key) || connectionFields.has(key)) continue;
        if (key === 'te' && String(value).toLowerCase() !== 'trailers') continue;
        headers[key] = value;
    }
    if (options.auth && !headers.authorization) headers.authorization = 'Basic ' + Buffer.from(options.auth).toString('base64');
    return headers;
}

function transportFor(origin, session, { connectTimeout, idleTimeout }, onClose) {
    let accepting = true;
    let streams = 0;
    let idleTimer;
    // Axios clones plain-object transports, so `this.accepting` could be a stale copy.
    const isAccepting = () => accepting && !session.closed && !session.destroyed;
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
        connectTimeout,
        idleTimeout,
        get accepting() { return isAccepting(); },
        request(options, callback) {
            if (!isAccepting()) throw new Error('TRANSPORT CLOSED');
            const stream = session.request(requestHeaders(origin, options), { endStream: false });
            clearTimeout(idleTimer);
            session.ref();
            streams++;
            stream.once('close', () => {
                streams--;
                idle();
            });
            const onPrematureClose = () => {
                stream.emit('error', Object.assign(new Error('REQUEST CLOSED'), { stage: 'awaiting-response' }));
            };
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

// A peer can close the connection without an error before a handshake completes; `stage` says which one.
async function waitFor(resource, event, stage) {
    let ready, fail;
    const closed = () => fail(Object.assign(new Error('CONNECTION CLOSED'), { stage }));
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

// The signal only cancels connection setup; an open transport ignores it.
async function openTransport(origin, settings, { onClose, signal } = {}) {
    origin = new URL(origin);
    const secure = origin.protocol === 'https:';
    if (!secure && origin.protocol !== 'http:') throw new TypeError('UNSUPPORTED ORIGIN SCHEME');
    const { proxy, originTls, proxyRequestOptions, connectTimeout } = settings;
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    const port = Number(origin.port || (secure ? 443 : 80));
    let active, tunnel, openingError;
    function cancel(err) {
        openingError = err;
        active?.destroy();
    }
    const onAbort = () => cancel(signal.reason);
    signal?.addEventListener('abort', onAbort);
    // While the proxy has not answered CONNECT, the proxy is the one that timed out, as with the agents.
    const timer = connectTimeout && setTimeout(() => {
        cancel(new Error(proxy && !tunnel ? 'PROXY TIMEOUT' : 'CONNECTION TIMEOUT'));
    }, connectTimeout);
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
            await waitFor(socket, 'secureConnect', 'tls-handshake');
            if (openingError) throw openingError;
            if (socket.alpnProtocol !== 'h2') throw new Error('HTTP/2 NOT SUPPORTED BY SERVER');
        }

        // Chrome's receive windows; Node's 64 KB default throttles large responses on high-latency paths.
        const session = http2.connect(origin, {
            settings: { initialWindowSize: streamWindowSize },
            createConnection: socket && (() => socket),
        });
        active = session;
        await waitFor(session, 'remoteSettings', 'http2-handshake').catch((err) => {
            // Over cleartext, a server without HTTP/2 answers the connection preface with bytes that fail as a protocol
            // error; over TLS, ALPN has already confirmed HTTP/2, so a protocol error there means a faulty server.
            if (!secure && err.code === 'ERR_HTTP2_ERROR') throw new Error('HTTP/2 NOT SUPPORTED BY SERVER', { cause: err });
            throw err;
        });
        if (openingError) throw openingError;
        if (session.closed || session.destroyed) {
            throw Object.assign(new Error('CONNECTION CLOSED'), { stage: 'http2-handshake' });
        }
        session.setLocalWindowSize(connectionWindowSize);
        return transportFor(origin, session, settings, onClose);
    } catch (err) {
        active?.destroy();
        tunnel?.destroy();
        throw openingError || err;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

async function createHttp2Transport(origin, options) {
    return openTransport(origin, resolveHttp2TransportOptions(options));
}

module.exports = { createHttp2Transport, openTransport, resolveHttp2TransportOptions };
