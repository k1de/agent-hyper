# agent-hyper

> Based on [hpagent](https://github.com/delvedor/hpagent) by Tomas Della Vedova  
> Forked for personal needs. **I recommend using the [original package](https://github.com/delvedor/hpagent) for most use cases.**

**HTTP/HTTPS proxy agents with persistent connections.**

## Installation

```bash
npm install agent-hyper
```

## Usage

```javascript
import axios from 'axios'
import { HttpsProxyAgent, getUsualProxyAgentConfig } from 'agent-hyper'
// HttpProxyAgent is also available for HTTP requests

const httpsAgent = new HttpsProxyAgent({
    ...getUsualProxyAgentConfig(),
    proxy: 'http://localhost:8080',
})

const client = axios.create({ httpsAgent })
```

## Default Configuration

`getUsualProxyAgentConfig()` returns:

```javascript
{
    keepAlive: true,
    keepAliveMsecs: 1000,
    scheduling: 'lifo',
    timeout: 5000
}
```

## Features

-   Keep-alive proxy connections
-   Basic authentication support
-   Custom proxy headers
-   HTTPS proxy support

## License

ISC
