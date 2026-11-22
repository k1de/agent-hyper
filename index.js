const https = require('https');
const http = require('http');
const createProxyConnection = require('./proxy-connection');
const { createHttp2Transport } = require('./http2-transport');
const createHttp2TransportPool = require('./http2-transport-pool');

const proxyAgentDefaults = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    scheduling: 'lifo',
    timeout: 5000,
};

// createConnection must not return a value: http.Agent would treat it as a ready socket.
const withProxy = (Agent) => class extends Agent {
    constructor({ proxy, proxyRequestOptions, ...options }) {
        super({ ...proxyAgentDefaults, ...options });
        this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
        this.proxyRequestOptions = proxyRequestOptions || {};
    }

    tunnel(options, callback) {
        createProxyConnection(this.proxy, this.proxyRequestOptions, { ...options, keepAlive: this.keepAlive }, callback);
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
