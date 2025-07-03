import * as dgram from 'dgram';
import { WebSocketServer, WebSocket } from 'ws';

interface ActiveProxy {
    proxySocket: dgram.Socket;
    proxyHost: { address: string; port: number };
}

export function encodeProxyMessage(targetHost: string, targetPort: number, payload: Buffer): Buffer {
    const hostnameBuffer = Buffer.from(targetHost, 'utf8');
    const hostnameLength = hostnameBuffer.length;

    if (hostnameLength > 255) throw new Error('Hostname is too long (max 255 bytes).');
    if (targetPort < 1 || targetPort > 65535) throw new Error('Target port must be between 1 and 65535.');

    const totalLength = 1 + hostnameLength + 2 + payload.length;
    const buffer = Buffer.alloc(totalLength);

    buffer.writeUInt8(hostnameLength, 0);
    hostnameBuffer.copy(buffer, 1);
    buffer.writeUInt16BE(targetPort, 1 + hostnameLength);
    payload.copy(buffer, 1 + hostnameLength + 2);

    return buffer;
}

export function decodeProxyMessage(messageBuffer: Buffer): { targetHost: string; targetPort: number; payload: Buffer } {
    if (messageBuffer.length < 4) throw new Error('Malformed message: too short.');

    const hostnameLength = messageBuffer.readUInt8(0);
    if (messageBuffer.length < 1 + hostnameLength + 2) throw new Error('Malformed message: incomplete header.');

    const targetHost = messageBuffer.toString('utf8', 1, 1 + hostnameLength);
    const targetPort = messageBuffer.readUInt16BE(1 + hostnameLength);
    const payload = Buffer.from(messageBuffer.slice(1 + hostnameLength + 2));

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
    private wss: WebSocketServer;

    constructor(wsApiPort: number, minProxyPort: number, maxProxyPort: number, token: string) {
        this.wsApiPort = wsApiPort;
        this.minProxyPort = minProxyPort;
        this.maxProxyPort = maxProxyPort;
        this.accessToken = token;
        
        this.activeProxies = new Map<number, ActiveProxy>();
        this.wss = new WebSocketServer({ port: this.wsApiPort });

        console.log(`ProxBoard Backend Service started.`);
        console.log(`WebSocket API: ws://localhost:${this.wsApiPort}`);
        console.log(`Available UDP proxy port range: ${this.minProxyPort}-${this.maxProxyPort}`);

        this.setupWebSocketListeners();
    }

    private setupWebSocketListeners(): void {
        this.wss.on('connection', ws => {
            console.log('WebSocket client connected.');

            let authenticated = false;

            // Start a 5 second timer to receive a valid token
            const authTimeout = setTimeout(() => {
                if (!authenticated) {
                    console.log('Authentication timeout: closing connection.');
                    ws.close(4001, 'Authentication required');
                }
            }, 5000);

            // Override message handler for first message (token auth)
            ws.once('message', msg => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.action === 'auth' && data.token === this.accessToken) {
                        authenticated = true;
                        clearTimeout(authTimeout);
                        ws.send(JSON.stringify({ status: 'success', message: 'Authenticated' }));
                        // Now listen for other messages normally
                        ws.on('message', msg => this.handleWebSocketMessage(ws, msg));
                    } else {
                        ws.send(JSON.stringify({ status: 'error', message: 'Invalid token' }));
                        ws.close(4003, 'Invalid token');
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ status: 'error', message: 'Malformed auth message' }));
                    ws.close(4002, 'Malformed auth message');
                }
            });

            ws.on('close', () => console.log('WebSocket client disconnected.'));
            ws.on('error', err => console.error('WebSocket error:', err));
        });

        console.log(`API Commands:`);
        console.log(`  { "action": "list" }`);
        console.log(`  { "action": "create", "proxyHostAddress": "...", "proxyHostPort": ... }`);
        console.log(`  { "action": "stop", "proxyPort": ... }`);
    }

    private async handleWebSocketMessage(ws: WebSocket, message: import('ws').RawData): Promise<void> {
        try {
            const data = JSON.parse(message.toString());
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
        } catch (error: any) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({ status: 'error', message: error.message }));
        }
    }

    private async findAvailablePort(): Promise<number | null> {
        for (let port = this.minProxyPort; port <= this.maxProxyPort; port++) {
            if (this.activeProxies.has(port)) continue;

            const tempSocket = dgram.createSocket('udp4');
            try {
                await new Promise<void>((resolve, reject) => {
                    tempSocket.once('error', err => {
                        tempSocket.close();
                        if ((err as any).code === 'EADDRINUSE') resolve();
                        else reject(err);
                    });
                    tempSocket.once('listening', () => {
                        tempSocket.close();
                        resolve();
                    });
                    tempSocket.bind(port, '0.0.0.0');
                });
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
            const proxySocket = dgram.createSocket('udp4');
            const proxyHost = { address: proxyHostAddress, port: proxyHostPort };

            proxySocket.on('message', (msg, rinfo) => {
                const isFromProxyHost = rinfo.address === proxyHost.address && rinfo.port === proxyHost.port;

                if (isFromProxyHost) {
                    // Message from proxyHost: decode and forward to target
                    let targetHost: string, targetPort: number, payload: Buffer;
                    try {
                        ({ targetHost, targetPort, payload } = decodeProxyMessage(msg));
                    } catch (err: any) {
                        console.warn(`Proxy ${availablePort}: Invalid message from proxyHost: ${err.message}`);
                        return;
                    }

                    proxySocket.send(payload, targetPort, targetHost, err => {
                        if (err) {
                            console.error(`Proxy ${availablePort}: Failed to send to ${targetHost}:${targetPort}:`, err);
                        }
                    });

                } else {
                    // Message from target host: encode and send back to proxyHost
                    const encodedMsg = encodeProxyMessage(rinfo.address, rinfo.port, msg);
                    proxySocket.send(encodedMsg, proxyHost.port, proxyHost.address, err => {
                        if (err) {
                            console.error(`Proxy ${availablePort}: Failed to send response back to proxyHost:`, err);
                        }
                    });
                }
            });

            proxySocket.on('error', err => {
                console.error(`Proxy ${availablePort} error:`, err);
                proxySocket.close();
                this.activeProxies.delete(availablePort);
            });

            await new Promise<void>((resolve) => {
                proxySocket.bind(availablePort, '0.0.0.0', () => {
                    console.log(`Proxy created on port ${availablePort} for proxyHost ${proxyHostAddress}:${proxyHostPort}`);
                    this.activeProxies.set(availablePort, { proxySocket, proxyHost });
                    resolve();
                });
            });

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

        proxy.proxySocket.close(() => {
            console.log(`Proxy ${proxyPort} stopped.`);
            this.activeProxies.delete(proxyPort);
        });

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

        // Close WebSocket server
        this.wss.close(() => {
            console.log('WebSocket server closed.');
        });
    }
}
