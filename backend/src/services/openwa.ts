import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

export interface IncomingMedia {
  chatId: string;
  messageId: string;
  mimetype: string;
  data?: string;
  sizeBytes?: number;
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const simulatorLogs: { phone: string; message: string; timestamp: string; sender: 'bot' | 'user'; mediaUrl?: string; mediaType?: string; }[] = [];

const deliveryContext = new AsyncLocalStorage<{ key: string; sendIndex: number }>();

// Keys stay stable across webhook retries. OpenWA retains send keys for 24 hours.
export function withWebhookDelivery<T>(key: string, process: () => Promise<T>): Promise<T> {
  return deliveryContext.run({ key, sendIndex: 0 }, process);
}

function configuration() {
  const { OPENWA_BASE_URL, OPENWA_API_KEY, OPENWA_SESSION_ID } = process.env;
  if (!OPENWA_BASE_URL || !OPENWA_API_KEY || !OPENWA_SESSION_ID) {
    throw new Error('OPENWA_BASE_URL, OPENWA_API_KEY and OPENWA_SESSION_ID are required');
  }
  const url = new URL(OPENWA_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OPENWA_BASE_URL must be an HTTP(S) API base URL without credentials, query or fragment');
  }
  return {
    base: `${url.href.replace(/\/$/, '')}/sessions/${encodeURIComponent(OPENWA_SESSION_ID)}`,
    headers: { 'X-API-Key': OPENWA_API_KEY },
  };
}

export async function sendMessage(to: string, text: string): Promise<void> {
  if (!/^\+?[1-9]\d{6,14}$/.test(to)) throw new Error('Recipient must be an international phone number');
  if (!text || text.includes('\0')) throw new Error('Message text must be nonempty and contain no NUL');
  const config = configuration();
  const context = deliveryContext.getStore();
  const sendKey = context ? `${context.key}:${context.sendIndex++}` : randomUUID();
  // No blind transport retries: uncertain outcomes must remain visible to the caller.
  for (let start = 0, part = 0; start < text.length; part++) {
    let end = Math.min(start + 4096, text.length);
    // Do not cut a UTF-16 surrogate pair between messages.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const chunk = text.slice(start, end);
    const key = createHash('sha256').update(`${sendKey}:${part}`).digest('hex');
    const response = await axios.post(
      `${config.base}/messages/send-text`,
      { chatId: `${to.replace(/^\+/, '')}@c.us`, text: chunk },
      { headers: { ...config.headers, 'Idempotency-Key': key }, timeout: 30000, maxRedirects: 0 },
    );
    if (typeof response.data?.messageId !== 'string' || !response.data.messageId) {
      throw new Error('OpenWA returned no accepted messageId');
    }
    simulatorLogs.push({ phone: to, message: chunk, timestamp: new Date().toISOString(), sender: 'bot' });
    if (simulatorLogs.length > 100) simulatorLogs.shift();
    start = end;
  }
}

export async function downloadMedia(media: IncomingMedia): Promise<{ buffer: Buffer; contentType: string }> {
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/.test(media.mimetype)) {
    throw new Error('Invalid media MIME type');
  }
  if (media.sizeBytes !== undefined && (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 0 || media.sizeBytes > MAX_MEDIA_BYTES)) {
    throw new Error('Media exceeds the 10 MiB limit or has an invalid size');
  }
  let buffer: Buffer;
  if (media.data !== undefined) {
    // OpenWA supplies raw base64, never a URL or data URI. Reject before decoding/allocating.
    if (media.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || media.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(media.data)) {
      throw new Error('Invalid or oversized inline media');
    }
    buffer = Buffer.from(media.data, 'base64');
  } else {
    if (!media.chatId || !media.messageId) throw new Error('Missing media chat/message identity');
    const config = configuration();
    const response = await axios.get<ArrayBuffer>(
      `${config.base}/messages/${encodeURIComponent(media.chatId)}/${encodeURIComponent(media.messageId)}/media`,
      { headers: config.headers, responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_MEDIA_BYTES, maxRedirects: 0 },
    );
    buffer = Buffer.from(response.data);
  }
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw new Error('Empty or oversized media');
  // The download endpoint deliberately serves documents as octet-stream; retain the signed webhook MIME.
  return { buffer, contentType: media.mimetype };
}