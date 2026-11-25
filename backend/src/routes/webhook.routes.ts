import { Router } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { IncomingMedia, withWebhookDelivery } from '../services/openwa';

type IncomingHandler = (sender: string, text: string, media?: IncomingMedia) => Promise<void>;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createWebhookRouter(
  handleMessage: IncomingHandler,
  recordDirectory = path.resolve(__dirname, '../../data/openwa-webhooks'),
) {
  const router = Router();
  const pending = new Map<string, Promise<void>>();
  const senderTails = new Map<string, Promise<void>>();

  // ponytail: one backend process, persistent local disk. No cross-process locking.
  // Keep success markers for replay protection (disk grows one tiny file per event).
  // Supabase effects and this marker are NOT one transaction: a crash/failed handler
  // after a business write can repeat that write. Distributed exactly-once needs an outbox.
  async function processOnce(key: string, sender: string, process: () => Promise<void>): Promise<string> {
    const existing = pending.get(key);
    if (existing) {
      await existing;
      return 'duplicate';
    }
    let duplicate = false;
    const work = (senderTails.get(sender) || Promise.resolve()).then(async () => {
      await mkdir(recordDirectory, { recursive: true });
      const marker = path.join(recordDirectory, `${key}.done`);
      try {
        await access(marker);
        duplicate = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await withWebhookDelivery(key, process);
      const file = await open(marker, 'wx');
      try {
        await file.writeFile(new Date().toISOString());
        await file.sync();
      } finally {
        await file.close();
      }
    });
    pending.set(key, work);
    const tail = work.then(() => {}, () => {});
    senderTails.set(sender, tail);
    try {
      await work;
      return duplicate ? 'duplicate' : 'processed';
    } finally {
      pending.delete(key);
      if (senderTails.get(sender) === tail) senderTails.delete(sender);
    }
  }

  router.post('/whatsapp', async (req, res) => {
    try {
      const secret = process.env.OPENWA_WEBHOOK_SECRET;
      const sessionId = process.env.OPENWA_SESSION_ID;
      if (!secret || !sessionId) throw new Error('OpenWA webhook secret/session configuration is missing');
      if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Expected raw application/json' });
      if (!verifySignature(req.body, req.get('X-OpenWA-Signature'), secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      let payload: JsonObject | undefined;
      try {
        payload = object(JSON.parse(req.body.toString('utf8')));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      if (!payload) return res.status(400).json({ error: 'Invalid webhook payload' });
      // Only signed body fields drive routing/deduplication; convenience headers are unsigned.
      if (payload.sessionId !== sessionId || payload.event !== 'message.received') {
        return res.json({ status: 'ignored' });
      }
      const message = object(payload.data);
      if (!message) return res.status(400).json({ error: 'Missing message data' });
      if (message.fromMe !== false || message.isGroup !== false ||
          message.kind !== 'individual' || message.isStatusBroadcast === true) {
        return res.json({ status: 'ignored' });
      }
      const from = typeof message.from === 'string' ? message.from : '';
      const chatId = typeof message.chatId === 'string' ? message.chatId : '';
      const individual = /^\d+@(c\.us|s\.whatsapp\.net|lid)$/;
      if (!individual.test(from) || !individual.test(chatId)) return res.json({ status: 'ignored' });
      const phoneMatch = /^([1-9]\d{6,14})@(c\.us|s\.whatsapp\.net)$/.exec(from);
      const sender = phoneMatch?.[1] || (from.endsWith('@lid') &&
        typeof message.senderPhone === 'string' && /^[1-9]\d{6,14}$/.test(message.senderPhone)
        ? message.senderPhone : undefined);
      if (!sender) {
        console.warn('[OpenWA] Ignoring message: sender phone unresolved (check RESOLVE_LID_TO_PHONE)');
        return res.json({ status: 'ignored', reason: 'unresolved_sender' });
      }
      if (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey ||
          typeof message.id !== 'string' || (message.body !== undefined && typeof message.body !== 'string')) {
        return res.status(400).json({ error: 'Invalid message identity or body' });
      }
      const text = typeof message.body === 'string' ? message.body : '';
      let media: IncomingMedia | undefined;
      if (message.media !== undefined && message.media !== null) {
        const attachment = object(message.media);
        if (!attachment || typeof attachment.mimetype !== 'string' || !attachment.mimetype ||
            (attachment.data !== undefined && typeof attachment.data !== 'string') ||
            (attachment.sizeBytes !== undefined && (typeof attachment.sizeBytes !== 'number' ||
              !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)) ||
            (attachment.data === undefined && !message.id)) {
          return res.status(400).json({ error: 'Invalid media metadata' });
        }
        media = {
          chatId, messageId: message.id, mimetype: attachment.mimetype,
          data: attachment.data as string | undefined,
          sizeBytes: attachment.sizeBytes as number | undefined,
        };
      }
      if (!text && !media) return res.json({ status: 'ignored' });
      const key = createHash('sha256').update(JSON.stringify([sessionId, payload.idempotencyKey])).digest('hex');
      const status = await processOnce(key, sender, () => handleMessage(sender, text, media));
      return res.json({ status });
    } catch (error) {
      // Do not acknowledge unfinished/failed work. OpenWA can retry this delivery.
      console.error('[OpenWA] Webhook processing failed:', error instanceof Error ? error.message : error);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}