# agent-hyper

> Based on [hpagent](https://github.com/delvedor/hpagent) by Tomas Della Vedova.
> Forked for personal needs — for most use cases, prefer the [original package](https://github.com/delvedor/hpagent).

HTTP/HTTPS agents with an optional proxy and an HTTP/2 client transport for Node.js 20+.

```bash
npm install agent-hyper
```

> **Disclaimer:** always pass `proxy: false` to axios. Otherwise axios may apply a global proxy from `HTTP_PROXY` /
> `HTTPS_PROXY` on top of the agent or transport, and requests may not go through them as configured.

## Agents

`HttpAgent` / `HttpsAgent` connect directly, or through a proxy when `proxy` is set.
`HttpProxyAgent` / `HttpsProxyAgent` are the same but require a proxy.

```javascript
import axios from 'axios'
import { HttpsAgent } from 'agent-hyper' // HttpAgent for http:// targets

const client = axios.create({
    httpsAgent: new HttpsAgent({ proxy: config.proxy }), // direct when config.proxy is not set
    proxy: false,
})
await client.get('https://api.example.org/users')
```

| Option | Description | Default |
| --- | --- | --- |
| `proxy` | Proxy URL with credentials (`http://user:pass@host:port`); omit or leave empty for a direct connection | — |
| `proxyRequestOptions` | `headers`, `ca`, `cert`, `key`, `rejectUnauthorized` for the CONNECT request | — |
| `connectTimeout` | Limit for establishing a connection, ms | `5000` |
| `idleTimeout` | Closes a keep-alive socket after this long without requests, ms | `10000` |
| `keepAlive` | Reuses sockets between requests | `true` |
| `keepAliveMsecs` | Delay before TCP keep-alive probes on an idle socket, ms | `1000` |
| `scheduling` | Which free socket is reused first | `'lifo'` |

Other `http.Agent` / `https.Agent` options pass through. `0` or `Infinity` disables a timer.

## HTTP/2 transport

Speaks HTTP/2 to the origin directly or through an HTTP/HTTPS proxy: `h2` via ALPN for HTTPS, cleartext `h2c` for HTTP.
Receive windows match Chrome (6 MB per stream, 15 MB per connection), so large responses are not throttled on slow links.

**Single transport** — one session for a batch of requests that you open and close yourself.
It does not reconnect: once `transport.accepting` is `false`, create a new one.

```javascript
import { createHttp2Transport } from 'agent-hyper'

const transport = await createHttp2Transport('https://api.example.org', {
    proxy: 'http://localhost:8080',
})
try {
    await axios.post('https://api.example.org/orders', { quantity: 1 }, {
        transport,
        proxy: false,
    })
} finally {
    await transport.close()
}
```

Axios does not follow redirects when a custom `transport` is set.

**Pool** — for long-lived clients, with one origin or many: one shared session per origin,
reopened on the next `get()` after it closes.

```javascript
import { createHttp2TransportPool } from 'agent-hyper'

const transportPool = createHttp2TransportPool({ proxy: 'http://localhost:8080' })
const client = async config => axios({
    ...config,
    proxy: false,
    transport: await transportPool.get(axios.getUri(config)),
})

await client({ url: 'https://api-a.example.org/users' })
await client({
    method: 'post',
    baseURL: 'https://api-b.example.net',
    url: '/orders',
    data: { quantity: 1 },
})
```

Both take the same options:

| Option | Description | Default |
| --- | --- | --- |
| `proxy` | Proxy URL; omit or leave empty for a direct connection | — |
| `proxyRequestOptions` | Same as for the agents | — |
| `originTls` | `ca`, `cert`, `key`, `rejectUnauthorized` for the origin | — |
| `connectTimeout` | Limit for establishing a connection, ms | `5000` |
| `idleTimeout` | Closes a session after this long with no requests in flight, ms | `10000` |

`0` (as in axios) or `Infinity` disables a timer. Idle sessions never keep the process alive.

### Closing

Closing is optional: idle sessions close by themselves after `idleTimeout`. `transport.close()` and
`transportPool.close()` reject new requests at once, let the ones in flight finish and resolve when the sessions
are closed. The pool also cancels connections still being set up; a later `get()` opens a new session.

To stop without waiting for responses, give the pool client a shared signal and abort it before closing:

```javascript
const shutdown = new AbortController()
const client = async config => axios({
    ...config,
    proxy: false,
    signal: shutdown.signal,
    transport: await transportPool.get(axios.getUri(config)),
})
// …
shutdown.abort()
await transportPool.close()
```

## License

MIT. Based on hpagent © 2020 Tomas Della Vedova.
