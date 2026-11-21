const https = require('https');
const http = require('http');
const { URL } = require('url');
const createProxyConnection = require('./proxy-connection');
const createHttp2Transport = require('./http2-transport');
const createHttp2TransportPool = require('./http2-transport-pool');

const proxyAgentDefaults = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    scheduling: 'lifo',
    timeout: 5000,
};

class HttpProxyAgent extends http.Agent {
    constructor(options) {
        const { proxy, proxyRequestOptions, ...opts } = options;
        super({ ...proxyAgentDefaults, ...opts });
        this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
        this.proxyRequestOptions = proxyRequestOptions || {};
    }

    createConnection(options, callback) {
        createProxyConnection(this.proxy, this.proxyRequestOptions,
            { ...options, keepAlive: this.keepAlive }, callback);
    }
}

class HttpsProxyAgent extends https.Agent {
    constructor(options) {
        const { proxy, proxyRequestOptions, ...opts } = options;
        super({ ...proxyAgentDefaults, ...opts });
        this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
        this.proxyRequestOptions = proxyRequestOptions || {};
    }

    createConnection(options, callback) {
        createProxyConnection(this.proxy, this.proxyRequestOptions,
            { ...options, keepAlive: this.keepAlive }, (err, socket) => {
                if (err) return callback(err, null);
                const secureSocket = super.createConnection({ ...options, socket });
                callback(null, secureSocket);
            });
    }
}

module.exports = { HttpProxyAgent, HttpsProxyAgent, createHttp2Transport, createHttp2TransportPool };
Object.defineProperty(module.exports, 'default', { value: module.exports });
