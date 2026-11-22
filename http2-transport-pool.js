const { openTransport, resolveHttp2TransportOptions } = require('./http2-transport');

function createHttp2TransportPool(options) {
    const settings = resolveHttp2TransportOptions(options);
    const byOrigin = new Map();
    let closing = Promise.resolve();

    return {
        async get(url) {
            const target = new URL(url);
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new TypeError('HTTP/2 UNSUPPORTED ORIGIN SCHEME');
            const key = target.origin;
            const cached = byOrigin.get(key);
            if (cached && (!cached.transport || cached.transport.accepting)) return cached.opening;

            const entry = { controller: new AbortController() };
            const forget = () => byOrigin.get(key) === entry && byOrigin.delete(key);
            entry.opening = openTransport(key, settings, { onClose: forget, signal: entry.controller.signal }).then(
                (transport) => (entry.transport = transport),
                (err) => {
                    forget();
                    throw err;
                },
            );
            byOrigin.set(key, entry);
            return entry.opening;
        },

        // Sessions retired after GOAWAY or an error are already closing on their own.
        async close() {
            const entries = Array.from(byOrigin.values());
            byOrigin.clear();
            const current = Promise.all(entries.map((entry) => {
                entry.controller.abort(new Error('HTTP/2 SETUP CANCELLED BY POOL'));
                return entry.transport ? entry.transport.close() : entry.opening.then((transport) => transport.close(), () => {});
            }));
            // Each call also waits for earlier calls that are still draining.
            closing = Promise.all([closing, current]).then(() => {});
            await closing;
        },
    };
}

module.exports = createHttp2TransportPool;
