import * as dgram from 'dgram';

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 10000;

const DNS_SERVER = '8.8.8.8';
const DNS_PORT = 53;

function buildDnsQuery(): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt16BE(0x1234, 0);
  buf.writeUInt16BE(0x0100, 2);
  buf.writeUInt16BE(1, 4);
  buf.writeUInt16BE(0, 6);
  buf.writeUInt16BE(0, 8);
  buf.writeUInt16BE(0, 10);

  const qname = 'example.com'.split('.');
  let offset = 12;
  for (const part of qname) {
    buf.writeUInt8(part.length, offset++);
    buf.write(part, offset, 'ascii');
    offset += part.length;
  }
  buf.writeUInt8(0, offset++);
  buf.writeUInt16BE(1, offset);
  offset += 2;
  buf.writeUInt16BE(1, offset);
  offset += 2;

  return buf.slice(0, offset);
}

function encodeProxyMessage(targetHost: string, targetPort: number, payload: Buffer): Buffer {
  const hostnameBuffer = Buffer.from(targetHost, 'utf8');
  const hostnameLength = hostnameBuffer.length;

  const totalLength = 1 + hostnameLength + 2 + payload.length;
  const buffer = Buffer.alloc(totalLength);

  buffer.writeUInt8(hostnameLength, 0);
  hostnameBuffer.copy(buffer, 1);
  buffer.writeUInt16BE(targetPort, 1 + hostnameLength);
  payload.copy(buffer, 1 + hostnameLength + 2);

  return buffer;
}

function decodeProxyMessage(messageBuffer: Buffer): { targetHost: string; targetPort: number; payload: Buffer } {
  const hostnameLength = messageBuffer.readUInt8(0);
  const targetHost = messageBuffer.toString('utf8', 1, 1 + hostnameLength);
  const targetPort = messageBuffer.readUInt16BE(1 + hostnameLength);
  const payload = messageBuffer.slice(1 + hostnameLength + 2);

  return { targetHost, targetPort, payload };
}

async function main() {
  const socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    console.error('UDP client error:', err);
    socket.close();
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error('Timeout waiting for response');
      socket.close();
      reject(new Error('Timeout waiting for response'));
    }, 5000);

    socket.on('message', (msg, rinfo) => {
      clearTimeout(timeout);

      const { targetHost, targetPort, payload } = decodeProxyMessage(msg);
      console.log(`Received response from ${rinfo.address}:${rinfo.port}`);
      console.log('Decoded proxy target:', targetHost, targetPort);
      console.log('DNS response buffer:', payload);

      const answerCount = payload.readUInt16BE(6);
      console.log('Number of answers in DNS response:', answerCount);

      socket.close();
      resolve();
    });

    socket.bind(55555, () => {
      const dnsQuery = buildDnsQuery();
      const proxyMessage = encodeProxyMessage(DNS_SERVER, DNS_PORT, dnsQuery);

      socket.send(proxyMessage, PROXY_PORT, PROXY_HOST, (err) => {
        if (err) {
          clearTimeout(timeout);
          console.error('Send error:', err);
          socket.close();
          reject(err);
        } else {
          console.log('DNS query sent through proxy from local port 55555');
        }
      });
    });
  });
}

main().catch(console.error);
