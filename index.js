const https = require('https');
const http = require('http');
const { TLSSocket } = require('tls');
const { createProxyConnection, normalizeTimeout } = require('./proxy-connection');
const { createHttp2Transport } = require('./http2-transport');
const createHttp2TransportPool = require('./http2-transport-pool');

const agentDefaults = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    scheduling: 'lifo',
    connectTimeout: 5000,
    idleTimeout: 10000,
};

// Destroys a socket that does not finish connecting within `timeout`. The ready event follows the socket type, not
// the agent: Node may hand back a plain socket even from https.Agent (e.g. with its `proxyEnv` option).
function limitSetup(socket, timeout) {
    if (!timeout) return socket;
    const timer = setTimeout(() => socket.destroy(new Error('CONNECTION TIMEOUT')), timeout);
    const clear = () => clearTimeout(timer);
    socket.once(socket instanceof TLSSocket ? 'secureConnect' : 'connect', clear).once('close', clear);
    return socket;
}

// Calls back once the tunnel is up and returns nothing: http.Agent would take a returned value for a ready socket.
function tunnel(agent, options, callback) {
    createProxyConnection(agent.proxy, agent.proxyRequestOptions,
        { ...options, keepAlive: agent.keepAlive, timeout: agent.connectTimeout }, callback);
}

// Adds an optional proxy and the connection timeouts to http.Agent / https.Agent.
const withProxy = (Agent) => class extends Agent {
    constructor({ proxy, proxyRequestOptions, ...options } = {}) {
        // `options` is a fresh rest copy, so filling it in place is safe; explicit `undefined` gets the default too.
        for (const [key, value] of Object.entries(agentDefaults)) options[key] ??= value;
        const { connectTimeout, idleTimeout, ...agentOptions } = options;
        // http.Agent applies its own `timeout` to idle keep-alive sockets; connection setup has a separate limit.
        super({ ...agentOptions, timeout: normalizeTimeout(idleTimeout) });
        // A copy keeps the proxy fixed; an empty string, e.g. from an unset environment variable, means a direct connection.
        this.proxy = proxy ? new URL(proxy) : null;
        this.proxyRequestOptions = proxyRequestOptions || {};
        this.connectTimeout = normalizeTimeout(connectTimeout);
    }

    // http.Agent keeps the idle limit as its own `timeout`; this only exposes it under our name.
    get idleTimeout() {
        return this.options.timeout;
    }
};

// Without a proxy both agents connect directly and return the socket, as http.Agent expects.
class HttpAgent extends withProxy(http.Agent) {
    createConnection(options, callback) {
        if (!this.proxy) return limitSetup(super.createConnection(options, callback), this.connectTimeout);
        tunnel(this, options, callback);
    }
}

class HttpsAgent extends withProxy(https.Agent) {
    createConnection(options, callback) {
        if (!this.proxy) return limitSetup(super.createConnection(options, callback), this.connectTimeout);
        tunnel(this, options, (err, socket) => {
            if (err) return callback(err, null);
            let secureSocket;
            // Invalid TLS options throw here, inside an event callback, where an uncaught error would crash the process.
            try {
                secureSocket = super.createConnection({ ...options, socket });
            } catch (error) {
                socket.destroy();
                return callback(error, null);
            }
            callback(null, limitSetup(secureSocket, this.connectTimeout));
        });
    }
}

// The proxy variants differ only in requiring a proxy.
const requireProxy = (Agent) => class extends Agent {
    constructor(options = {}) {
        if (!options.proxy) throw new TypeError('PROXY REQUIRED');
        super(options);
    }
};

class HttpProxyAgent extends requireProxy(HttpAgent) {}
class HttpsProxyAgent extends requireProxy(HttpsAgent) {}

module.exports = { HttpAgent, HttpsAgent, HttpProxyAgent, HttpsProxyAgent, createHttp2Transport, createHttp2TransportPool };
Object.defineProperty(module.exports, 'default', { value: module.exports });
