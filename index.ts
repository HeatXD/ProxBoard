import { ProxBoardService } from './src/ProxBoardService';

const WS_API_PORT = Number(process.env.WS_API_PORT) || 3000;
const MIN_PROXY_PORT = Number(process.env.MIN_PROXY_PORT) || 10000;
const MAX_PROXY_PORT = Number(process.env.MAX_PROXY_PORT) || 10100;
const WS_ACCESS_TOKEN = process.env.WS_ACCESS_TOKEN || '127.0.0.1';

const service = new ProxBoardService(WS_API_PORT, MIN_PROXY_PORT, MAX_PROXY_PORT, WS_ACCESS_TOKEN);

console.log("ProxBoard service initialized and running.");

process.on('SIGINT', () => service.shutdown()); // Ctrl+C
process.on('SIGTERM', () => service.shutdown()); // kill PID