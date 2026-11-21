# agent-hyper

> Based on [hpagent](https://github.com/delvedor/hpagent) by Tomas Della Vedova  
> Forked for personal needs. **I recommend using the [original package](https://github.com/delvedor/hpagent) for most use cases.**

**HTTP/HTTPS proxy agents and a reusable HTTP/2 client transport for Node.js.**

## Installation

```bash
npm install agent-hyper
```

## Usage

```javascript
import axios from 'axios'
import { HttpsProxyAgent } from 'agent-hyper'
// HttpProxyAgent is also available for HTTP requests

const httpsAgent = new HttpsProxyAgent({ proxy: 'http://localhost:8080' })

const client = axios.create({ httpsAgent })
await client({ method: 'get', url: 'https://api-a.example.org/users' })
```

Both agents default to `keepAlive: true`, `keepAliveMsecs: 1000`, `scheduling: 'lifo'` and `timeout: 5000`.
Pass any of these options to the constructor to override it.

## HTTP/2 transport

`await createHttp2Transport(url, options)` opens a new HTTP/2 session for the URL's origin on every call.
HTTPS negotiates `h2` via ALPN during the TLS handshake. HTTP uses cleartext HTTP/2 (`h2c`) with prior knowledge.
To reuse sessions, create a `transportPool` with fixed options. Its `get(url)` shares one
connection per origin, including when several requests arrive at once.

```javascript
import axios from 'axios'
import { createHttp2TransportPool } from 'agent-hyper'

const transportPool = createHttp2TransportPool({ proxy: 'http://localhost:8080' })
const client = async config => axios({
    ...config,
    transport: await transportPool.get(axios.getUri(config)),
})

try {
    await client({ method: 'get', url: 'https://api-a.example.org/users' })
    await client({ method: 'post', baseURL: 'https://api-b.example.net', url: '/orders', data: { quantity: 1 } })
} finally {
    await transportPool.close()
}
```

Omit `proxy` when creating the transport or pool for a direct connection.
`timeout` limits the entire connection setup. `idleTimeout` closes a session after the specified time without open streams.
Both default to 5000 ms. Set either option to 0 to disable its timer.

`transportPool.close()` clears the cache immediately, cancels pending connections and waits
for existing streams to finish. A new `get(url)` can open a session while the old ones drain.

## Features

-   Keep-alive proxy connections
-   Basic authentication support
-   Custom proxy headers
-   HTTPS proxy support

## License

ISC
