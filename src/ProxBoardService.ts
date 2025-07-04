/**
 * ProxBoard Proxy Message Layout:
 *
 * The proxy message format wraps a UDP payload with the destination info.
 * This allows sending UDP packets through a proxy server that forwards them.
 *
 * Structure:
 * │ Hostname Length (1 byte) │ Hostname (variable length) │ Target Port (2 bytes) │ Payload (remaining bytes) │
 *
 * Fields:
 * - Hostname Length: 1 byte indicating the length of the hostname string (max 255)
 * - Hostname: UTF-8 encoded string representing the target host (e.g., "8.8.8.8" or "example.com")
 * - Target Port: 2 bytes unsigned integer (big-endian) for the UDP destination port (1-65535)
 * - Payload: The actual UDP packet data to forward
 */

import type { Server, ServerWebSocket } from "bun";

interface ActiveProxy {
    proxySocket: any;
    proxyHost: { address: string; port: number };
}

interface WebSocketData {
    authenticated: boolean;
    authTimeout?: NodeJS.Timeout;
}

export function encodeProxyMessage(targetHost: string, targetPort: number, payload: ArrayBuffer): ArrayBuffer {
    const hostnameBuffer = new TextEncoder().encode(targetHost);
    const hostnameLength = hostnameBuffer.length;

    if (hostnameLength > 255) throw new Error('Hostname is too long (max 255 bytes).');
    if (targetPort < 1 || targetPort > 65535) throw new Error('Target port must be between 1 and 65535.');

    const totalLength = 1 + hostnameLength + 2 + payload.byteLength;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);

    // Write hostname length
    view.setUint8(0, hostnameLength);
    
    // Write hostname
    uint8View.set(hostnameBuffer, 1);
    
    // Write target port (big-endian)
    view.setUint16(1 + hostnameLength, targetPort, false);
    
    // Write payload
    uint8View.set(new Uint8Array(payload), 1 + hostnameLength + 2);

    return buffer;
}

export function decodeProxyMessage(messageBuffer: ArrayBuffer): { targetHost: string; targetPort: number; payload: ArrayBuffer } {
    if (messageBuffer.byteLength < 4) throw new Error('Malformed message: too short.');

    const view = new DataView(messageBuffer);
    const uint8View = new Uint8Array(messageBuffer);
    
    const hostnameLength = view.getUint8(0);
    if (messageBuffer.byteLength < 1 + hostnameLength + 2) throw new Error('Malformed message: incomplete header.');

    const hostnameBytes = uint8View.slice(1, 1 + hostnameLength);
    const targetHost = new TextDecoder().decode(hostnameBytes);
    const targetPort = view.getUint16(1 + hostnameLength, false); // big-endian
    const payload = messageBuffer.slice(1 + hostnameLength + 2);

    if (!targetHost || isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
        throw new Error(`Malformed message: Invalid host or port.`);
    }

    return { targetHost, targetPort, payload };
}

export class ProxBoardService {
    private readonly wsApiPort: number;
    private readonly minProxyPort: number;
    private readonly maxProxyPort: number;
    private readonly accessToken: string;
    private activeProxies: Map<number, ActiveProxy>;
    private server: Server;

    constructor(wsApiPort: number, minProxyPort: number, maxProxyPort: number, token: string) {
        this.wsApiPort = wsApiPort;
        this.minProxyPort = minProxyPort;
        this.maxProxyPort = maxProxyPort;
        this.accessToken = token;
        
        this.activeProxies = new Map<number, ActiveProxy>();
        
        this.server = Bun.serve({
            port: this.wsApiPort,
            fetch: this.handleHttpRequest.bind(this),
            websocket: {
                open: this.handleWebSocketOpen.bind(this),
                message: this.handleWebSocketMessage.bind(this),
                close: this.handleWebSocketClose.bind(this)
            }
        });

        console.log(`ProxBoard Backend Service started.`);
        console.log(`WebSocket API: ws://localhost:${this.wsApiPort}`);
        console.log(`Available UDP proxy port range: ${this.minProxyPort}-${this.maxProxyPort}`);
        
        this.printApiCommands();
    }

    private handleHttpRequest(req: Request): Response | undefined {
        const url = new URL(req.url);
        
        if (req.headers.get('upgrade') === 'websocket') {
            const success = this.server.upgrade(req, {
                data: { authenticated: false } as WebSocketData
            });
            if (success) {
                return undefined; // upgrade successful
            }
        }
        
        return new Response('ProxBoard WebSocket API', { status: 200 });
    }

    private handleWebSocketOpen(ws: ServerWebSocket<WebSocketData>): void {
        console.log('WebSocket client connected.');
        
        // Initialize data
        ws.data = {
            authenticated: false
        };
        
        // Start a 5 second timer to receive a valid token
        const authTimeout = setTimeout(() => {
            if (!ws.data.authenticated) {
                console.log('Authentication timeout: closing connection.');
                ws.close(4001, 'Authentication required');
            }
        }, 5000);
        
        ws.data.authTimeout = authTimeout;
    }

    private handleWebSocketMessage(ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void {
        try {
            const data = JSON.parse(message.toString());
            
            // Handle authentication
            if (!ws.data.authenticated) {
                if (data.action === 'auth' && data.token === this.accessToken) {
                    ws.data.authenticated = true;
                    if (ws.data.authTimeout) {
                        clearTimeout(ws.data.authTimeout);
                    }
                    ws.send(JSON.stringify({ status: 'success', message: 'Authenticated' }));
                } else {
                    ws.send(JSON.stringify({ status: 'error', message: 'Invalid token' }));
                    ws.close(4003, 'Invalid token');
                }
                return;
            }
            
            // Handle authenticated messages
            this.handleAuthenticatedMessage(ws, data);
            
        } catch (error: any) {
            console.error('WebSocket message error:', error);
            if (!ws.data.authenticated) {
                ws.send(JSON.stringify({ status: 'error', message: 'Malformed auth message' }));
                ws.close(4002, 'Malformed auth message');
            } else {
                ws.send(JSON.stringify({ status: 'error', message: error.message }));
            }
        }
    }

    private async handleAuthenticatedMessage(ws: ServerWebSocket<WebSocketData>, data: any): Promise<void> {
        const action = data.action;
        let response: any;

        switch (action) {
            case 'list':
                response = this.listProxies();
                break;
            case 'create':
                const { proxyHostAddress, proxyHostPort } = data;
                response = await this.createProxy(proxyHostAddress, proxyHostPort);
                break;
            case 'stop':
                response = this.stopProxy(data.proxyPort);
                break;
            default:
                response = { status: 'error', message: 'Unknown action.' };
        }

        ws.send(JSON.stringify(response));
    }

    private handleWebSocketClose(ws: ServerWebSocket<WebSocketData>): void {
        console.log('WebSocket client disconnected.');
        if (ws.data.authTimeout) {
            clearTimeout(ws.data.authTimeout);
        }
    }

    private printApiCommands(): void {
        console.log(`API Commands:`);
        console.log(`  { "action": "auth", "token": ... }`);
        console.log(`  { "action": "list" }`);
        console.log(`  { "action": "create", "proxyHostAddress": "...", "proxyHostPort": ... }`);
        console.log(`  { "action": "stop", "proxyPort": ... }`);
    }

    private async findAvailablePort(): Promise<number | null> {
        for (let port = this.minProxyPort; port <= this.maxProxyPort; port++) {
            if (this.activeProxies.has(port)) continue;

            try {
                // Try to create a UDP socket on this port
                const testSocket = await Bun.udpSocket({
                    port,
                    hostname: '0.0.0.0',
                    socket: {
                        data: () => {},
                        error: () => {}
                    }
                });
                
                testSocket.close();
                return port;
            } catch {
                continue;
            }
        }
        return null;
    }

    private async createProxy(proxyHostAddress: string, proxyHostPort: number): Promise<any> {
        if (!proxyHostAddress || typeof proxyHostPort !== 'number') {
            return { status: 'error', action: 'create', message: 'Invalid proxyHostAddress or proxyHostPort.' };
        }

        const availablePort = await this.findAvailablePort();
        if (availablePort === null) {
            return { status: 'error', action: 'create', message: 'No available proxy ports.' };
        }

        try {
            const proxyHost = { address: proxyHostAddress, port: proxyHostPort };

            const proxySocket = await Bun.udpSocket({
                port: availablePort,
                hostname: '0.0.0.0',
                socket: {
                    data: (socket, buf, port, address) => {
                        const arrayBuffer = new Uint8Array(buf).buffer;
                        const isFromProxyHost = address === proxyHost.address && port === proxyHost.port;

                        if (isFromProxyHost) {
                            // Message from proxyHost: decode and forward to target
                            let targetHost: string, targetPort: number, payload: ArrayBuffer;
                            try {
                                ({ targetHost, targetPort, payload } = decodeProxyMessage(arrayBuffer));
                            } catch (err: any) {
                                console.warn(`Proxy ${availablePort}: Invalid message from proxyHost: ${err.message}`);
                                return;
                            }

                            socket.send(payload, targetPort, targetHost);

                        } else {
                            // Message from target host: encode and send back to proxyHost
                            const encodedMsg = encodeProxyMessage(address, port, arrayBuffer);
                            socket.send(encodedMsg, proxyHost.port, proxyHost.address);
                        }
                    },
                    error: (socket, error) => {
                        console.error(`Proxy ${availablePort} error:`, error);
                        socket.close();
                        this.activeProxies.delete(availablePort);
                    }
                }
            });

            console.log(`Proxy created on port ${availablePort} for proxyHost ${proxyHostAddress}:${proxyHostPort}`);
            this.activeProxies.set(availablePort, { proxySocket, proxyHost });

            return {
                status: 'success',
                action: 'create',
                message: `Proxy created on port ${availablePort}`,
                proxyPort: availablePort
            };

        } catch (err: any) {
            console.error('Proxy creation failed:', err);
            return { status: 'error', action: 'create', message: err.message };
        }
    }

    private stopProxy(proxyPort: number): any {
        const proxy = this.activeProxies.get(proxyPort);
        if (!proxy) {
            return { status: 'error', action: 'stop', message: 'Proxy not found.' };
        }

        proxy.proxySocket.close();
        this.activeProxies.delete(proxyPort);
        console.log(`Proxy ${proxyPort} stopped.`);

        return { status: 'success', action: 'stop', message: `Proxy on port ${proxyPort} stopped.` };
    }

    private listProxies(): any {
        const proxies = Array.from(this.activeProxies.entries()).map(([port, proxy]) => ({
            proxyPort: port,
            proxyHost: proxy.proxyHost
        }));
        return { status: 'success', action: 'list', proxies };
    }

    public shutdown(): void {
        console.log('Shutting down ProxBoardService...');

        // Close all active proxy sockets
        for (const [port, proxy] of this.activeProxies.entries()) {
            proxy.proxySocket.close();
            this.activeProxies.delete(port);
            console.log(`Closed proxy on port ${port}`);
        }

        // Stop the server
        this.server.stop();
        console.log('Server stopped.');
        process.exit(0);
    }
}