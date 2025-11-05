import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

/**
 * Creates a connection through HTTP(S) proxy using CONNECT method
 * @param {URL} proxy - Proxy URL object
 * @param {Object} proxyRequestOptions - Additional proxy request options
 * @param {Object} options - Connection options
 * @param {Function} callback - Callback(err, socket)
 */
function createProxyConnection(proxy, proxyRequestOptions, options, callback) {
    const requestOptions = {
        ...proxyRequestOptions,
        method: 'CONNECT',
        host: proxy.hostname,
        port: proxy.port,
        path: `${options.host}:${options.port}`,
        setHost: false,
        headers: {
            ...proxyRequestOptions.headers,
            connection: options.keepAlive ? 'keep-alive' : 'close',
            host: `${options.host}:${options.port}`,
        },
        agent: false,
        timeout: options.timeout || 0,
    };

    if (proxy.username || proxy.password) {
        const base64 = Buffer.from(
            `${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(proxy.password || '')}`
        ).toString('base64');
        requestOptions.headers['proxy-authorization'] = `Basic ${base64}`;
    }

    if (proxy.protocol === 'https:') {
        requestOptions.servername = proxy.hostname;
    }

    const request = (proxy.protocol === 'http:' ? http : https).request(requestOptions);

    request.once('connect', (response, socket, _head) => {
        request.removeAllListeners();
        socket.removeAllListeners();
        if (response.statusCode === 200) {
            callback(null, socket);
        } else {
            socket.destroy();
            callback(new Error(`PROXY HTTP ${response.statusCode}`), null);
        }
    });

    request.once('timeout', () => {
        request.destroy(new Error(`PROXY TIMEOUT`));
    });

    request.once('error', (err) => {
        request.removeAllListeners();
        callback(err, null);
    });

    request.end();
}

class HttpProxyAgent extends http.Agent {
    constructor(options) {
        const { proxy, proxyRequestOptions, ...opts } = options;
        super(opts);
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
        super(opts);
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

function getUsualProxyAgentConfig() {
    return {
        keepAlive: true,
        keepAliveMsecs: 1000,
        scheduling: 'lifo',
        timeout: 5000,
    }
}

export default { HttpProxyAgent, HttpsProxyAgent, getUsualProxyAgentConfig }