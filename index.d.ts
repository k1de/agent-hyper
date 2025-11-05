import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

declare class HttpProxyAgent extends http.Agent {
    constructor(options: HttpProxyAgentOptions);
}

interface HttpProxyAgentOptions extends http.AgentOptions {
    proxy: string | URL;
    proxyRequestOptions?: ProxyAgentRequestOptions;
}

declare class HttpsProxyAgent extends https.Agent {
    constructor(options: HttpsProxyAgentOptions);
}

interface HttpsProxyAgentOptions extends https.AgentOptions {
    proxy: string | URL;
    proxyRequestOptions?: ProxyAgentRequestOptions;
}

interface ProxyAgentRequestOptions {
    ca?: string[];
    headers?: Object;
    rejectUnauthorized?: boolean;
}

interface UsualProxyAgentConfig {
    /** Enable HTTP Keep-Alive for proxy connections */
    keepAlive: true;
    /** How often to send TCP KeepAlive packets in milliseconds */
    keepAliveMsecs: 1000;
    /** Connection scheduling strategy (Last In, First Out) */
    scheduling: 'lifo';
    /** Proxy request timeout in milliseconds */
    timeout: 5000;
}

declare function getUsualProxyAgentConfig(): UsualProxyAgentConfig;

export { HttpProxyAgent, HttpProxyAgentOptions, HttpsProxyAgent, HttpsProxyAgentOptions, ProxyAgentRequestOptions, getUsualProxyAgentConfig };
