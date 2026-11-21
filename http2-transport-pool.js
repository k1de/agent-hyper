const createHttp2Transport = require('./http2-transport');

function createHttp2TransportPool(options) {
    const settings = createHttp2Transport.resolveHttp2TransportOptions(options);
    const byOrigin = new Map();
    // A retired session can still have streams to drain after its replacement opens.
    const live = new Set();

    return {
        async get(url) {
            const target = new URL(url);
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new TypeError('HTTP/2 UNSUPPORTED ORIGIN SCHEME');
            const key = target.origin;
            const cached = byOrigin.get(key);
            if (cached && (!cached.transport || cached.transport.accepting)) return cached.opening;

            const entry = {
                onClose() {
                    live.delete(entry);
                    if (byOrigin.get(key) === entry) byOrigin.delete(key);
                },
            };
            live.add(entry);
            byOrigin.set(key, entry);
            entry.opening = createHttp2Transport(key, settings, entry).catch((err) => {
                entry.onClose();
                throw err;
            });
            return entry.opening;
        },

        async close() {
            const current = Array.from(live);
            byOrigin.clear();
            await Promise.all(current.map((entry) => {
                if (entry.transport) return entry.transport.close();
                entry.cancelOpening?.();
                return entry.opening.catch(() => {});
            }));
        },
    };
}

module.exports = createHttp2TransportPool;
