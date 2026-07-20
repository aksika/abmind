export const FRAME_HEADER_BYTES = 4;
export const FRAME_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const FRAME_MAX_TOTAL_BYTES = FRAME_HEADER_BYTES + FRAME_MAX_PAYLOAD_BYTES;

export const CONNECTION_MAX_INFLIGHT = 32;
export const CONNECTION_MAX_QUEUED_WRITES = 64;
export const CONNECTION_IDLE_TIMEOUT_MS = 60_000;
export const CONNECTION_MAX_LINGER_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const RECONNECT_BASE_DELAY_MS = 100;
export const RECONNECT_MAX_DELAY_MS = 10_000;
export const RECONNECT_MAX_ATTEMPTS = 10;

export class FrameCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameCodecError";
  }
}

export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > FRAME_MAX_PAYLOAD_BYTES) {
    throw new FrameCodecError(`Payload exceeds ${FRAME_MAX_PAYLOAD_BYTES} bytes`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export function decodeFrameHead(buffer: Buffer): { length: number; headerSize: number } | null {
  if (buffer.length < FRAME_HEADER_BYTES) return null;
  const length = buffer.readUInt32BE(0);
  if (length === 0) throw new FrameCodecError("Zero-length frame");
  if (length > FRAME_MAX_PAYLOAD_BYTES) throw new FrameCodecError(`Declared length ${length} exceeds max ${FRAME_MAX_PAYLOAD_BYTES}`);
  return { length, headerSize: FRAME_HEADER_BYTES };
}

export interface FrameAccumulator {
  push(chunk: Buffer): void;
  readFrame(): { headerSize: number; payload: Buffer } | null;
}

export function createFrameAccumulator(): FrameAccumulator {
  let buf = Buffer.alloc(0);

  return {
    push(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > FRAME_MAX_TOTAL_BYTES) {
        buf = Buffer.alloc(0);
        throw new FrameCodecError("Accumulator exceeded max frame size");
      }
    },

    readFrame(): { headerSize: number; payload: Buffer } | null {
      const head = decodeFrameHead(buf);
      if (!head) return null;
      const total = head.headerSize + head.length;
      if (buf.length < total) return null;
      const payload = buf.subarray(head.headerSize, total);
      buf = buf.subarray(total);
      return { headerSize: head.headerSize, payload };
    },
  };
}
