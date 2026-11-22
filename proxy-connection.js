const https = require('https');
const http = require('http');
const { isIP, isIPv6 } = require('net');

// Node's timers reject or clamp values above 2^31 - 1 (`setTimeout` fires them after 1 ms), so 0 (no timer) is used instead.
const normalizeTimeout = (value) => (value > 0 && value <= 2 ** 31 - 1 ? value : 0);

/**
 * Creates a connection through HTTP(S) proxy using CONNECT method
 * @param {URL} proxy - Proxy URL object
 * @param {Object} proxyRequestOptions - Additional proxy request options
 * @param {Object} options - Connection options
 * @param {Function} callback - Callback(err, socket)
 */
function createProxyConnection(proxy, proxyRequestOptions, options, callback) {
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
    const targetHost = isIPv6(options.host) ? `[${options.host}]` : options.host;
    const authority = `${targetHost}:${options.port}`;
    const requestOptions = {
        ...proxyRequestOptions,
        method: 'CONNECT',
        hostname: proxyHost,
        port: proxy.port,
        path: authority,
        setHost: false,
        headers: {
            ...proxyRequestOptions.headers,
            connection: options.keepAlive ? 'keep-alive' : 'close',
            host: authority,
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
        // An empty servername prevents https.Agent from deriving SNI from the CONNECT Host header.
        requestOptions.servername = isIP(proxyHost) ? '' : proxyHost;
    }

    const request = (proxy.protocol === 'http:' ? http : https).request(requestOptions);

    request.once('connect', (response, socket, head) => {
        if (response.statusCode === 200) {
            socket.setTimeout(0);
            if (head.length) socket.unshift(head);
            callback(null, socket);
        } else {
            socket.destroy();
            callback(new Error(`PROXY HTTP ${response.statusCode}`), null);
        }
    });

    request.once('timeout', () => {
        request.destroy(new Error('PROXY TIMEOUT'));
    });

    request.once('error', (err) => {
        callback(err, null);
    });

    return request.end();
}

module.exports = { createProxyConnection, normalizeTimeout };
