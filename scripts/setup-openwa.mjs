import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const backendEnvPath = new URL('../backend/.env', import.meta.url);
const gatewayRoot = new URL('../../OpenWA/', import.meta.url);
const webhookUrl = 'http://127.0.0.1:5001/webhook/whatsapp';
const sessionName = 'helpdesk-it';

function updateEnv(source, values) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n"\\]/.test(value)) {
      throw new Error('Nilai konfigurasi tidak dapat disimpan sebagai dotenv.');
    }
    const line = `${key}="${value}"`;
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'gm');
    if (pattern.test(source)) {
      source = source.replace(pattern, () => line);
    } else {
      source += (source && !source.endsWith('\n') ? newline : '') + line + newline;
    }
  }
  return source;
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function setup() {
  const backendEnv = parseEnv(await readFile(backendEnvPath, 'utf8'));
  const gatewayEnv = parseEnv(await readOptional(new URL('.env', gatewayRoot)));
  const apiKey = gatewayEnv.API_MASTER_KEY || (await readOptional(new URL('data/.api-key', gatewayRoot))).trim();
  if (!apiKey) throw new Error('API key tidak ditemukan di OpenWA/.env atau OpenWA/data/.api-key.');
  const secret = backendEnv.OPENWA_WEBHOOK_SECRET || gatewayEnv.OPENWA_WEBHOOK_SECRET || randomBytes(32).toString('hex');
  if (secret.length < 16 || secret.length > 255) throw new Error('OPENWA_WEBHOOK_SECRET harus 16–255 karakter.');
  const baseUrl = (backendEnv.OPENWA_BASE_URL || 'http://127.0.0.1:2785/api').replace(/\/$/, '');
  const origin = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password) {
    throw new Error('Helper ini khusus gateway lokal HTTP; konfigurasi produksi dilakukan terpisah.');
  }

  async function request(path, method = 'GET', body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Never log response bodies: validation errors can echo submitted secrets.
      throw new Error(`OpenWA ${method} ${path}: HTTP ${response.status}. Periksa API key, konfigurasi SSRF, dan log gateway.`);
    }
    return response.json();
  }

  const sessions = await request(`/sessions?name=${encodeURIComponent(sessionName)}`);
  if (!Array.isArray(sessions) || sessions.length > 1) throw new Error('Daftar sesi OpenWA tidak valid.');
  const session = sessions[0] || await request('/sessions', 'POST', { name: sessionName });
  if (session.name !== sessionName || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.id)) {
    throw new Error('Sesi helpdesk-it harus memiliki UUID asli dari OpenWA.');
  }
  const route = `/sessions/${session.id}/webhooks`;
  const webhooks = await request(route);
  if (!Array.isArray(webhooks)) throw new Error('Daftar webhook OpenWA tidak valid.');
  const matches = webhooks.filter(webhook => webhook.url === webhookUrl);
  if (matches.length > 1) throw new Error('Ada webhook duplikat ke backend; hapus duplikat melalui dashboard terlebih dahulu.');
  const config = { url: webhookUrl, events: ['message.received'], secret, headers: {}, filters: null, retryCount: 3 };
  if (matches[0]) {
    await request(`${route}/${encodeURIComponent(matches[0].id)}`, 'PUT', { ...config, active: true });
  } else {
    await request(route, 'POST', config);
  }

  const current = await readFile(backendEnvPath, 'utf8');
  await writeFile(backendEnvPath, updateEnv(current, {
    OPENWA_BASE_URL: baseUrl,
    OPENWA_API_KEY: apiKey,
    OPENWA_SESSION_ID: session.id,
    OPENWA_WEBHOOK_SECRET: secret,
  }), { encoding: 'utf8', mode: 0o600 });
  console.log(`Sesi ${sessionName}: ${session.id} (${session.status}). Webhook message.received terkonfigurasi.`);
  console.log('backend/.env diperbarui tanpa mengubah Supabase. Restart backend setelah setup.');
  console.log('Buka http://localhost:2886, masuk memakai API_MASTER_KEY dari OpenWA/.env, lalu Start sesi helpdesk-it dan pindai QR di WhatsApp > Perangkat tertaut.');
  console.log('Setup tidak memindai QR, mengirim pesan, atau membuat tiket. Tunggu status sesi ready sebelum uji WhatsApp.');
}

if (process.argv.includes('--self-test')) {
  const source = '# keep\r\nSUPABASE_URL="https://example.invalid"\r\nSUPABASE_SERVICE_ROLE_KEY="keep=this#value"\r\nexport OPENWA_API_KEY=old\r\n';
  const values = { OPENWA_API_KEY: 'new$key', OPENWA_SESSION_ID: 'a-b' };
  const updated = updateEnv(source, values);
  assert.equal(parseEnv(updated).SUPABASE_SERVICE_ROLE_KEY, parseEnv(source).SUPABASE_SERVICE_ROLE_KEY);
  assert.ok(updated.startsWith(source.slice(0, source.indexOf('export OPENWA_API_KEY'))));
  assert.equal(parseEnv(updated).OPENWA_API_KEY, values.OPENWA_API_KEY);
  assert.equal(parseEnv(updated).OPENWA_SESSION_ID, values.OPENWA_SESSION_ID);
  assert.equal(updateEnv(updated, values), updated);
  assert.throws(() => updateEnv('', { OPENWA_API_KEY: 'bad\nvalue' }));
  console.log('Self-test dotenv preservation passed (no network or file writes).');
} else {
  setup().catch(error => {
    console.error(`Setup OpenWA gagal: ${error.message}`);
    process.exitCode = 1;
  });
}
