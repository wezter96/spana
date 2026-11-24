import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsConnection {
  readonly id: string;
  readonly isOpen: boolean;
  send(text: string): void;
  close(code?: number): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1")
    .update(secWebSocketKey + WS_MAGIC_GUID)
    .digest("base64");
}

function createConnection(id: string, socket: Duplex): WsConnection {
  let open = true;
  let buffer = Buffer.alloc(0);
  let fragmentedChunks: Buffer[] = [];
  const messageListeners: Array<(text: string) => void> = [];
  const closeListeners: Array<() => void> = [];

  const emitClose = () => {
    if (!open) return;
    open = false;
    for (const listener of closeListeners) {
      listener();
    }
  };

  const processBuffer = () => {
    while (buffer.length >= 2) {
      const firstByte = buffer[0]!;
      const secondByte = buffer[1]!;
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < offset + 2) return;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buffer.length < offset + 8) return;
        payloadLen = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ maskKey[i % 4]!;
        }
      }

      if (opcode === 0x8) {
        // Close frame
        try {
          socket.write(encodeWsFrame(0x8, Buffer.alloc(0)));
        } catch {
          /* ignore */
        }
        socket.end();
        emitClose();
        return;
      }

      if (opcode === 0x9) {
        // Ping → Pong
        try {
          socket.write(encodeWsFrame(0xa, payload));
        } catch {
          /* ignore */
        }
        continue;
      }

      if (opcode === 0xa) {
        // Pong — ignore
        continue;
      }

      if (opcode === 0x1 || opcode === 0x0) {
        fragmentedChunks.push(payload);
        if (fin) {
          const text = Buffer.concat(fragmentedChunks).toString("utf-8");
          fragmentedChunks = [];
          for (const listener of messageListeners) {
            listener(text);
          }
        }
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });
  socket.on("close", emitClose);
  socket.on("error", emitClose);

  return {
    id,
    get isOpen() {
      return open;
    },
    send(text: string) {
      if (!open) return;
      socket.write(encodeWsFrame(0x1, Buffer.from(text, "utf-8")));
    },
    close(code = 1000) {
      if (!open) return;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      try {
        socket.write(encodeWsFrame(0x8, body));
      } catch {
        /* ignore */
      }
      socket.end();
      emitClose();
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  };
}

export interface MinimalWsServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  onConnection(listener: (conn: WsConnection) => void): void;
  close(): Promise<void>;
}

/**
 * Zero-dependency RFC 6455 WebSocket server over `node:http`.
 * Works identically under both Bun and Node.js runtimes.
 */
export async function startMinimalWsServer(host = "127.0.0.1", port = 0): Promise<MinimalWsServer> {
  const connectionListeners: Array<(conn: WsConnection) => void> = [];
  const activeConnections = new Set<WsConnection>();
  let nextConnId = 1;

  const httpServer: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          connections: activeConnections.size,
        }),
      );
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required (WebSocket)");
  });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = computeAcceptKey(key);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    const conn = createConnection(`ws-${nextConnId++}`, socket);
    activeConnections.add(conn);
    conn.onClose(() => {
      activeConnections.delete(conn);
    });

    for (const listener of connectionListeners) {
      listener(conn);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: actualPort,
    host,
    url: `ws://${host}:${actualPort}`,
    onConnection(listener) {
      connectionListeners.push(listener);
    },
    async close() {
      for (const conn of activeConnections) {
        conn.close();
      }
      activeConnections.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
