import * as http from 'http';
import * as https from 'https';
import type { ClientHttp2Stream, IncomingHttpHeaders } from 'http2';
import type { ConnectionOptions } from 'tls';
import { URL } from 'url';

declare class HttpProxyAgent extends http.Agent {
    constructor(options: HttpProxyAgentOptions);
}

interface HttpProxyAgentOptions extends Omit<http.AgentOptions, 'timeout'>, ProxyAgentOwnOptions {}

declare class HttpsProxyAgent extends https.Agent {
    constructor(options: HttpsProxyAgentOptions);
}

interface HttpsProxyAgentOptions extends Omit<https.AgentOptions, 'timeout'>, ProxyAgentOwnOptions {}

interface ProxyAgentOwnOptions {
    proxy: string | URL;
    proxyRequestOptions?: ProxyAgentRequestOptions | undefined;
    /** Limit for the proxy's CONNECT reply in milliseconds. Defaults to 5000. Set to 0 or Infinity to disable. */
    timeout?: number | undefined;
    /** Milliseconds an idle keep-alive socket is kept. Defaults to 10000. Set to 0 or Infinity to disable. */
    idleTimeout?: number | undefined;
}

interface ProxyAgentRequestOptions extends Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> {
    headers?: http.OutgoingHttpHeaders | undefined;
}

interface Http2TransportOptions {
    proxy?: string | URL | undefined;
    proxyRequestOptions?: ProxyAgentRequestOptions | undefined;
    originTls?: Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> | undefined;
    /** Connection setup timeout in milliseconds. Defaults to 5000. Set to 0 or Infinity to disable. */
    timeout?: number | undefined;
    /** Milliseconds without open streams before closing. Defaults to 10000. Set to 0 or Infinity to disable. */
    idleTimeout?: number | undefined;
}

interface Http2Transport {
    /** False once the session is closing or closed; the transport does not reconnect. */
    readonly accepting: boolean;
    request(options: Pick<http.RequestOptions, 'hostname' | 'host' | 'port' | 'protocol' | 'path' | 'method' | 'auth'> & {
        headers?: http.OutgoingHttpHeaders | undefined;
    }, callback?: (response: ClientHttp2Stream & {
        statusCode: number;
        statusMessage: string;
        headers: IncomingHttpHeaders;
    }) => void): ClientHttp2Stream;
    /** Rejects new requests, lets sent ones finish, then closes the session. */
    close(): Promise<void>;
}

declare function createHttp2Transport(origin: string | URL, options?: Http2TransportOptions): Promise<Http2Transport>;

interface Http2TransportPool {
    get(url: string | URL): Promise<Http2Transport>;
    /** Closes cached sessions, cancels pending ones and waits for them and earlier calls. The pool stays usable. */
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
