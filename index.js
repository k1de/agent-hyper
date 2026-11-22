const https = require('https');
const http = require('http');
const { createProxyConnection, normalizeTimeout } = require('./proxy-connection');
const { createHttp2Transport } = require('./http2-transport');
const createHttp2TransportPool = require('./http2-transport-pool');

const proxyAgentDefaults = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    scheduling: 'lifo',
    timeout: 5000,
    idleTimeout: 10000,
};

// createConnection must not return a value: http.Agent would treat it as a ready socket.
const withProxy = (Agent) => class extends Agent {
    constructor({ proxy, proxyRequestOptions, ...options }) {
        // `options` is a fresh rest copy, so filling it in place is safe; explicit `undefined` gets the default too.
        for (const [key, value] of Object.entries(proxyAgentDefaults)) options[key] ??= value;
        const { timeout, idleTimeout, ...agentOptions } = options;
        // http.Agent applies its own `timeout` to idle keep-alive sockets, so CONNECT keeps a separate limit.
        super({ ...agentOptions, timeout: normalizeTimeout(idleTimeout) });
        this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
        this.proxyRequestOptions = proxyRequestOptions || {};
        this.connectTimeout = normalizeTimeout(timeout);
    }

    tunnel(options, callback) {
        createProxyConnection(this.proxy, this.proxyRequestOptions,
            { ...options, keepAlive: this.keepAlive, timeout: this.connectTimeout }, callback);
    }
};

class HttpProxyAgent extends withProxy(http.Agent) {
    createConnection(options, callback) {
        this.tunnel(options, callback);
    }
}

class HttpsProxyAgent extends withProxy(https.Agent) {
    createConnection(options, callback) {
        this.tunnel(options, (err, socket) => (err ? callback(err, null) : callback(null, super.createConnection({ ...options, socket }))));
    }
}

module.exports = { HttpProxyAgent, HttpsProxyAgent, createHttp2Transport, createHttp2TransportPool };
Object.defineProperty(module.exports, 'default', { value: module.exports });
