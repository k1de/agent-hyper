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

// The origin a request targets; a transport's own origin fills in what the options leave out.
function requestOrigin(options, origin = {}) {
    const name = options.hostname || options.host;
    const host = isIPv6(name) ? `[${name}]` : name || origin.hostname || '';
    const port = options.port ?? (name ? '' : origin.port);
    return new URL(`${options.protocol || origin.protocol}//${host}${port ? ':' + port : ''}`);
}

function requestHeaders(origin, options) {
    if (requestOrigin(options, origin).origin !== origin.origin) throw new TypeError('REQUEST ORIGIN MISMATCH');

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

// Node's close() is graceful: it first sends the rest of the body, so a request axios cancels this way would still
// reach the server whole. destroy() resets the stream at once, as the pool's stand-in does.
function resetStream(_code, callback) {
    if (callback) this.once('close', callback);
    this.destroy();
}

// A class instance, unlike a plain object, is not copied by axios for every request.
class Http2Transport {
    #origin;
    #session;
    #closed;
    #accepting = true;
    #streams = 0;
    #idleTimer = null;

    constructor(origin, session, { connectTimeout, idleTimeout }, onClose) {
        this.connectTimeout = connectTimeout;
        this.idleTimeout = idleTimeout;
        this.#origin = origin;
        this.#session = session;
        // Methods keep working when passed on detached, e.g. `t.after(transport.close)`.
        for (const name of ['request', 'close']) this[name] = this[name].bind(this);
        // GOAWAY closes or destroys the session by itself, which `accepting` checks; unhandled errors would throw.
        session.on('error', () => this.#stop());
        this.#closed = new Promise((resolve) => session.once('close', () => {
            this.#stop();
            onClose?.();
            resolve();
        }));
        this.#idle();
    }

    get accepting() {
        return this.#accepting && !this.#session.closed && !this.#session.destroyed;
    }

    request(options, callback) {
        if (!this.accepting) throw new Error('TRANSPORT CLOSED');
        const stream = this.#session.request(requestHeaders(this.#origin, options), { endStream: false });
        stream.close = resetStream;
        clearTimeout(this.#idleTimer);
        this.#session.ref();
        this.#streams++;
        stream.once('close', () => {
            this.#streams--;
            this.#idle();
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
    }

    close() {
        this.#stop();
        if (!this.#session.destroyed) this.#session.ref();
        this.#session.close();
        return this.#closed;
    }

    #stop() {
        this.#accepting = false;
        clearTimeout(this.#idleTimer);
    }

    #idle() {
        if (!this.#accepting || this.#streams) return;
        this.#session.unref();
        if (this.idleTimeout) this.#idleTimer = setTimeout(this.close, this.idleTimeout).unref();
    }
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
        return new Http2Transport(origin, session, settings, onClose);
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

module.exports = { createHttp2Transport, openTransport, requestOrigin, resolveHttp2TransportOptions };
