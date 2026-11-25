import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, TestContext } from 'node:test';
import express, { Express } from 'express';
import { createWebhookRouter, verifySignature } from '../src/routes/webhook.routes';
import { downloadMedia, IncomingMedia, MAX_MEDIA_BYTES, sendMessage, simulatorLogs, withWebhookDelivery } from '../src/services/openwa';

const secret = 'contract-test-webhook-secret';
const sessionId = '00000000-0000-4000-8000-000000000001';

async function listen(t: TestContext, app: Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  const listening = Promise.withResolvers<void>();
  server.once('listening', listening.resolve);
  server.once('error', listening.reject);
  await listening.promise;
  t.after(async () => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function delivery(id: string, changes: Record<string, unknown> = {}) {
  return {
    event: 'message.received', timestamp: '2026-11-25T00:00:00.000Z', sessionId,
    idempotencyKey: `msg_${sessionId}_${id}_webhook`, deliveryId: `dlv_${id}`,
    data: {
      id, from: '6281234567890@c.us', to: '6281111111111@c.us', chatId: '6281234567890@c.us',
      body: 'help', type: 'chat', timestamp: 1795564800, isGroup: false, kind: 'individual', fromMe: false,
      ...changes,
    },
  };
}

async function post(base: string, payload: unknown, signedBody?: string) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(signedBody ?? body).digest('hex')}`;
  return fetch(`${base}/webhook/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': signature,
      'X-OpenWA-Event': 'forged-unused', 'X-OpenWA-Idempotency-Key': 'forged-unused' }, body,
  });
}

test('HMAC signs exact wire bytes, not reserialized JSON', () => {
  const raw = Buffer.from('{ "value": 1 }');
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(Buffer.from('{"value":1}'), signature, secret), false);
  for (const invalid of [undefined, '', 'sha256=1', signature + '0', 'sha256=' + 'g'.repeat(64)]) {
    assert.equal(verifySignature(raw, invalid, secret), false);
  }
  assert.equal(verifySignature(raw, signature, ''), false);
});

test('OpenWA v0.32.1 HTTP contract fixtures (not live WhatsApp)', async t => {
  const previous = { OPENWA_BASE_URL: process.env.OPENWA_BASE_URL, OPENWA_API_KEY: process.env.OPENWA_API_KEY,
    OPENWA_SESSION_ID: process.env.OPENWA_SESSION_ID, OPENWA_WEBHOOK_SECRET: process.env.OPENWA_WEBHOOK_SECRET };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    simulatorLogs.length = 0;
  });
  process.env.OPENWA_API_KEY = 'fixture-api-key';
  process.env.OPENWA_SESSION_ID = sessionId;
  process.env.OPENWA_WEBHOOK_SECRET = secret;

  await t.test('send-text splits Unicode, authenticates, retains stable delivery keys and rejects HTTP failure', async t => {
    const app = express();
    app.use(express.json());
    const requests: { text: string; key: string }[] = [];
    let fail = false;
    app.post(`/api/sessions/${sessionId}/messages/send-text`, (req, res) => {
      assert.equal(req.get('X-API-Key'), 'fixture-api-key');
      assert.equal(req.body.chatId, '6281234567890@c.us');
      requests.push({ text: req.body.text, key: req.get('Idempotency-Key') || '' });
      if (fail) return res.status(503).json({ message: 'session not ready' });
      return res.status(201).json({ messageId: `accepted-${requests.length}`, timestamp: 1795564800 });
    });
    process.env.OPENWA_BASE_URL = `${await listen(t, app)}/api`;
    const text = 'a'.repeat(4095) + '\uD83D\uDE03' + 'z'.repeat(4096);
    await withWebhookDelivery('stable-event', () => sendMessage('6281234567890', text));
    const first = requests.slice();
    assert.equal(first.map(item => item.text).join(''), text);
    assert.ok(first.every(item => item.text.length <= 4096 && item.key.length === 64));
    assert.equal(first[0].text.length, 4095);
    await withWebhookDelivery('stable-event', () => sendMessage('6281234567890', text));
    assert.deepEqual(requests.slice(first.length), first);
    assert.equal(new Set(first.map(item => item.key)).size, first.length);
    const logged = simulatorLogs.length;
    fail = true;
    await assert.rejects(sendMessage('6281234567890', 'failure'));
    assert.equal(simulatorLogs.length, logged);
    await assert.rejects(sendMessage('12345@lid', 'not a phone'));
  });

  await t.test('inline and stored media are capped; webhook URLs and API redirects are not fetched', async t => {
    const app = express();
    let requests = 0;
    const bytes = Buffer.from('%PDF-1.7 fixture');
    app.get(`/api/sessions/${sessionId}/messages/:chat/:id/media`, (req, res) => {
      requests++;
      assert.equal(req.get('X-API-Key'), 'fixture-api-key');
      assert.equal(req.params.chat, '6281234567890@c.us');
      if (req.params.id === 'large') return res.set('Content-Length', String(MAX_MEDIA_BYTES + 1)).end();
      if (req.params.id === 'redirect') return res.redirect('/untrusted');
      return res.type('application/octet-stream').send(bytes);
    });
    app.get('/untrusted', () => assert.fail('Redirect must not be followed'));
    process.env.OPENWA_BASE_URL = `${await listen(t, app)}/api`;
    const media: IncomingMedia = { chatId: '6281234567890@c.us', messageId: 'document/id', mimetype: 'application/pdf' };
    const inline = await downloadMedia({ ...media, data: bytes.toString('base64') });
    assert.deepEqual(inline.buffer, bytes);
    assert.equal(requests, 0);
    const downloaded = await downloadMedia(media);
    assert.deepEqual(downloaded.buffer, bytes);
    assert.equal(downloaded.contentType, 'application/pdf');
    assert.equal(requests, 1);
    for (const data of ['https://127.0.0.1/private', 'data:application/pdf;base64,AAAA', 'A===', 'AA', '!!!!']) {
      await assert.rejects(downloadMedia({ ...media, data }));
    }
    await assert.rejects(downloadMedia({ ...media, sizeBytes: MAX_MEDIA_BYTES + 1 }));
    await assert.rejects(downloadMedia({ ...media, data: 'A'.repeat(Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4) }));
    assert.equal(requests, 1);
    await assert.rejects(downloadMedia({ ...media, messageId: 'large' }));
    await assert.rejects(downloadMedia({ ...media, messageId: 'redirect' }));
  });

  await t.test('signed incoming messages filter identities, serialize, persist duplicates and expose failures', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'helpdesk-openwa-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const received: { sender: string; text: string; media?: IncomingMedia }[] = [];
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let shouldFail = false;
    const handler = async (sender: string, text: string, media?: IncomingMedia) => {
      received.push({ sender, text, media });
      order.push(`start:${text}`);
      if (text === 'hold') {
        started.resolve();
        await held.promise;
      }
      if (shouldFail) throw new Error('fixture processing failure');
      order.push(`end:${text}`);
    };
    const app = express();
    app.use('/webhook', express.raw({ type: 'application/json', limit: '15mb', inflate: false }), createWebhookRouter(handler, directory));
    const base = await listen(t, app);
    assert.equal((await post(base, delivery('bad-signature'), 'different body')).status, 401);
    assert.equal((await post(base, '{bad json')).status, 400);
    for (const change of [{ fromMe: true }, { isGroup: true }, { kind: 'group' }, { isStatusBroadcast: true },
      { from: 'status@broadcast' }, { chatId: '123@g.us' }, { from: '123456789012345@lid', chatId: '123456789012345@lid' }]) {
      const response = await post(base, delivery('ignored', change));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ignored');
    }
    assert.equal((await post(base, { ...delivery('wrong-session'), sessionId: 'another-session' })).status, 200);
    assert.equal((await post(base, { ...delivery('wrong-event'), event: 'message.sent' })).status, 200);
    assert.equal(received.length, 0);
    assert.equal((await post(base, { ...delivery('missing-key'), idempotencyKey: '' })).status, 400);
    const attachment = { mimetype: 'application/pdf', omitted: true, sizeBytes: 15 };
    assert.equal((await post(base, delivery('lid', { from: '123456789012345@lid', chatId: '123456789012345@lid',
      senderPhone: '6281234567890', media: attachment }))).status, 200);
    assert.deepEqual(received[0], { sender: '6281234567890', text: 'help', media: {
      chatId: '123456789012345@lid', messageId: 'lid', mimetype: 'application/pdf', data: undefined, sizeBytes: 15,
    } });
    assert.equal((await post(base, delivery('legacy-jid', { from: '6281234567890@s.whatsapp.net' }))).status, 200);
    const first = post(base, delivery('ordered-1', { body: 'hold' }));
    await started.promise;
    const duplicate = post(base, delivery('ordered-1', { body: 'hold' }));
    const second = post(base, delivery('ordered-2', { body: 'next' }));
    assert.equal(order.includes('start:next'), false);
    held.resolve();
    const results = await Promise.all([first, duplicate, second]);
    assert.ok(results.every(response => response.status === 200));
    assert.equal((await results[1].json()).status, 'duplicate');
    assert.equal(received.filter(item => item.text === 'hold').length, 1);
    assert.ok(order.indexOf('end:hold') < order.indexOf('start:next'));

    // New router, same disk directory: simulates process restart without touching business storage.
    const restarted = express();
    restarted.use('/webhook', express.raw({ type: 'application/json' }), createWebhookRouter(handler, directory));
    const restartedBase = await listen(t, restarted);
    assert.equal((await (await post(restartedBase, delivery('ordered-2', { body: 'next' }))).json()).status, 'duplicate');
    assert.equal(received.filter(item => item.text === 'next').length, 1);
    shouldFail = true;
    assert.equal((await post(base, delivery('retry-failure', { body: 'retry' }))).status, 500);
    shouldFail = false;
    assert.equal((await post(base, delivery('retry-failure', { body: 'retry' }))).status, 200);
    assert.equal(received.filter(item => item.text === 'retry').length, 2);
  });
});
