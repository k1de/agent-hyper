import * as http from 'http';
import * as https from 'https';
import type { ClientHttp2Stream, IncomingHttpHeaders } from 'http2';
import type { ConnectionOptions } from 'tls';
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

interface ProxyAgentRequestOptions extends Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> {
    headers?: Object;
}

interface Http2TransportOptions {
    proxy?: string | URL;
    proxyRequestOptions?: ProxyAgentRequestOptions;
    originTls?: Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'>;
    /** Connection setup timeout in milliseconds. Defaults to 5000. Set to 0 to disable. */
    timeout?: number;
    /** Milliseconds without open streams before closing. Defaults to 5000. Set to 0 to disable. */
    idleTimeout?: number;
}

interface Http2Transport {
    readonly accepting: boolean;
    request(options: Pick<http.RequestOptions, 'hostname' | 'host' | 'port' | 'protocol' | 'path' | 'method' | 'auth'> & {
        headers?: http.OutgoingHttpHeaders;
    }, callback?: (response: ClientHttp2Stream & {
        statusCode: number;
        statusMessage: string;
        headers: IncomingHttpHeaders;
    }) => void): ClientHttp2Stream;
    close(): Promise<void>;
}

declare function createHttp2Transport(origin: string | URL, options?: Http2TransportOptions): Promise<Http2Transport>;

interface Http2TransportPool {
    get(url: string | URL): Promise<Http2Transport>;
    close(): Promise<void>;
}

declare function createHttp2TransportPool(options?: Http2TransportOptions): Http2TransportPool;

export { HttpProxyAgent, HttpProxyAgentOptions, HttpsProxyAgent, HttpsProxyAgentOptions, ProxyAgentRequestOptions,
    createHttp2Transport, Http2Transport, Http2TransportOptions, createHttp2TransportPool, Http2TransportPool };

declare const api: {
    HttpProxyAgent: typeof HttpProxyAgent;
    HttpsProxyAgent: typeof HttpsProxyAgent;
    createHttp2Transport: typeof createHttp2Transport;
    createHttp2TransportPool: typeof createHttp2TransportPool;
};
export default api;
