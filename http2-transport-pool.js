const { PassThrough } = require('stream');
const { openTransport, requestOrigin, resolveHttp2TransportOptions } = require('./http2-transport');

// Stands in for the stream while the session opens: the body waits here and is piped on once the session is open.
// Node would still send a stream closed during that time, so none is created if this request was closed first.
class PendingRequest extends PassThrough {
    #stream = null;
    #timer = null;
    #timeout = 0;

    constructor(opening, options, callback) {
        super({ autoDestroy: false }); // like ClientRequest, it lives until the response ends
        opening.then((transport) => {
            if (this.destroyed) return;
            this.#stream = transport.request(options, callback)
                .on('error', (err) => this.destroy(err)).on('close', () => this.destroy())
                .on('timeout', () => this.emit('timeout'));
            this.setTimeout(this.#timeout).pipe(this.#stream);
        }).catch((err) => this.destroy(err));
    }

    setTimeout(ms, callback) {
        if (callback) this.once('timeout', callback);
        this.#timeout = ms;
        clearTimeout(this.#timer);
        if (this.#stream) this.#stream.setTimeout(ms);
        else if (ms) this.#timer = setTimeout(() => this.emit('timeout'), ms);
        return this;
    }

    // The error is reported by this request; the stream is only cancelled.
    _destroy(err, done) {
        clearTimeout(this.#timer);
        this.#stream?.destroy();
        done(err);
    }
}

// A class instance, unlike a plain object, is not copied by axios for every request.
class Http2TransportPool {
    #settings;
    #byOrigin = new Map();
    #closing = Promise.resolve();

    constructor(options) {
        this.#settings = resolveHttp2TransportOptions(options);
        this.connectTimeout = this.#settings.connectTimeout;
        this.idleTimeout = this.#settings.idleTimeout;
        // Methods keep working when passed on detached, e.g. `t.after(pool.close)`.
        for (const name of ['request', 'get', 'close']) this[name] = this[name].bind(this);
    }

    // Synchronous like http.request, so the pool works as an axios `transport`; the origin comes from the options.
    request(options, callback) {
        const entry = this.#entry(requestOrigin(options));
        if (entry.transport) return entry.transport.request(options, callback);
        return new PendingRequest(entry.opening, options, callback);
    }

    async get(url) {
        return this.#entry(new URL(url)).opening;
    }

    // Sessions retired after GOAWAY or an error are already closing on their own.
    async close() {
        const entries = Array.from(this.#byOrigin.values());
        this.#byOrigin.clear();
        const current = Promise.all(entries.map((entry) => {
            entry.controller.abort(Object.assign(new Error('POOL CLOSED'), { code: 'POOL_CLOSED' }));
            if (entry.transport) return entry.transport.close();
            return entry.opening.then((transport) => transport.close(), () => {});
        }));
        // Each call also waits for earlier calls that are still draining.
        this.#closing = Promise.all([this.#closing, current]).then(() => {});
        await this.#closing;
    }

    #entry(target) {
        if (target.protocol !== 'https:' && target.protocol !== 'http:') {
            throw Object.assign(new TypeError('UNSUPPORTED ORIGIN SCHEME'), { code: 'UNSUPPORTED_ORIGIN_SCHEME' });
        }
        const key = target.origin;
        const cached = this.#byOrigin.get(key);
        if (cached && (!cached.transport || cached.transport.accepting)) return cached;

        const entry = { controller: new AbortController() };
        const forget = () => this.#byOrigin.get(key) === entry && this.#byOrigin.delete(key);
        entry.opening = openTransport(key, this.#settings, { onClose: forget, signal: entry.controller.signal }).then(
            (transport) => (entry.transport = transport),
            (err) => {
                forget();
                throw err;
            },
        );
        this.#byOrigin.set(key, entry);
        return entry;
    }
}

function createHttp2TransportPool(options) {
    return new Http2TransportPool(options);
}

module.exports = createHttp2TransportPool;
