import * as http from 'http';
import * as https from 'https';
import type { ClientHttp2Stream, IncomingHttpHeaders } from 'http2';
import type { Writable } from 'stream';
import type { ConnectionOptions } from 'tls';
import { URL } from 'url';

/** Keep-alive agent that connects directly or, with `proxy`, through a CONNECT tunnel. */
declare class HttpAgent extends http.Agent {
    constructor(options?: HttpAgentOptions);
    /** Copy of the proxy URL, or null for direct connections. */
    readonly proxy: URL | null;
    readonly proxyRequestOptions: ProxyAgentRequestOptions;
    /** Connection setup limit in milliseconds; 0 when disabled. */
    readonly connectTimeout: number;
    /** Idle keep-alive socket limit in milliseconds; 0 when disabled. */
    readonly idleTimeout: number;
}

declare class HttpsAgent extends https.Agent {
    constructor(options?: HttpsAgentOptions);
    /** Copy of the proxy URL, or null for direct connections. */
    readonly proxy: URL | null;
    readonly proxyRequestOptions: ProxyAgentRequestOptions;
    /** Connection setup limit in milliseconds; 0 when disabled. */
    readonly connectTimeout: number;
    /** Idle keep-alive socket limit in milliseconds; 0 when disabled. */
    readonly idleTimeout: number;
}

/** Same as HttpAgent, but a proxy is required. */
declare class HttpProxyAgent extends HttpAgent {
    constructor(options: HttpProxyAgentOptions);
}

/** Same as HttpsAgent, but a proxy is required. */
declare class HttpsProxyAgent extends HttpsAgent {
    constructor(options: HttpsProxyAgentOptions);
}

interface AgentOwnOptions {
    /** Proxy URL; omit or leave empty for a direct connection. */
    proxy?: string | URL | undefined;
    proxyRequestOptions?: ProxyAgentRequestOptions | undefined;
    /**
     * Limit in milliseconds for establishing a connection: the whole direct DNS/TCP/TLS setup, or, through a proxy,
     * the CONNECT reply and then the TLS handshake inside the tunnel, each with its own limit.
     * Defaults to 5000. Set to 0 or Infinity to disable.
     */
    connectTimeout?: number | undefined;
    /** Milliseconds an idle keep-alive socket is kept. Defaults to 10000. Set to 0 or Infinity to disable. */
    idleTimeout?: number | undefined;
}

interface HttpAgentOptions extends Omit<http.AgentOptions, 'timeout'>, AgentOwnOptions {}

interface HttpsAgentOptions extends Omit<https.AgentOptions, 'timeout'>, AgentOwnOptions {}

interface HttpProxyAgentOptions extends HttpAgentOptions {
    proxy: string | URL;
}

interface HttpsProxyAgentOptions extends HttpsAgentOptions {
    proxy: string | URL;
}

interface ProxyAgentRequestOptions extends Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> {
    headers?: http.OutgoingHttpHeaders | undefined;
}

interface Http2TransportOptions {
    proxy?: string | URL | undefined;
    proxyRequestOptions?: ProxyAgentRequestOptions | undefined;
    originTls?: Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized'> | undefined;
    /**
     * Limit in milliseconds for establishing a connection, from CONNECT through TLS to the HTTP/2 handshake.
     * Defaults to 5000. Set to 0 or Infinity to disable.
     */
    connectTimeout?: number | undefined;
    /** Milliseconds without open streams before closing. Defaults to 10000. Set to 0 or Infinity to disable. */
    idleTimeout?: number | undefined;
}

interface Http2RequestOptions extends Pick<http.RequestOptions, 'hostname' | 'host' | 'port' | 'protocol' | 'path' | 'method' | 'auth'> {
    headers?: http.OutgoingHttpHeaders | undefined;
}

type Http2Response = ClientHttp2Stream & { statusCode: number; statusMessage: string; headers: IncomingHttpHeaders };

interface Http2Transport {
    /** Connection setup limit the transport was opened with, in milliseconds; 0 when disabled. */
    readonly connectTimeout: number;
    /** Idle session limit in milliseconds; 0 when disabled. */
    readonly idleTimeout: number;
    /** False once the session is closing or closed; the transport does not reconnect. */
    readonly accepting: boolean;
    /** The stream's close() resets it at once, without sending the rest of the body first. */
    request(options: Http2RequestOptions, callback?: (response: Http2Response) => void): ClientHttp2Stream;
    /** Rejects new requests, lets sent ones finish, then closes the session. */
    close(): Promise<void>;
}

declare function createHttp2Transport(origin: string | URL, options?: Http2TransportOptions): Promise<Http2Transport>;

interface Http2TransportPool {
    /** Connection setup limit for new sessions in milliseconds; 0 when disabled. */
    readonly connectTimeout: number;
    /** Idle session limit in milliseconds; 0 when disabled. */
    readonly idleTimeout: number;
    /**
     * Takes the origin from the options and returns at once, so the pool works as an axios `transport`.
     * While the session opens, a stand-in holds the body and sends nothing if it is closed first.
     */
    request(options: Http2RequestOptions, callback?: (response: Http2Response) => void): Writable & Pick<ClientHttp2Stream, 'setTimeout'>;
    get(url: string | URL): Promise<Http2Transport>;
    /** Closes cached sessions, cancels pending ones and waits for them and earlier calls. The pool stays usable. */
    close(): Promise<void>;
}

declare function createHttp2TransportPool(options?: Http2TransportOptions): Http2TransportPool;

export { HttpAgent, HttpAgentOptions, HttpsAgent, HttpsAgentOptions, HttpProxyAgent, HttpProxyAgentOptions,
    HttpsProxyAgent, HttpsProxyAgentOptions, ProxyAgentRequestOptions,
    createHttp2Transport, Http2Transport, Http2TransportOptions, createHttp2TransportPool, Http2TransportPool };

declare const api: {
    HttpAgent: typeof HttpAgent;
    HttpsAgent: typeof HttpsAgent;
    HttpProxyAgent: typeof HttpProxyAgent;
    HttpsProxyAgent: typeof HttpsProxyAgent;
    createHttp2Transport: typeof createHttp2Transport;
    createHttp2TransportPool: typeof createHttp2TransportPool;
};
export default api;
