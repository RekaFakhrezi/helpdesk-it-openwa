# Helpdesk IT — OpenWA

Clone terpisah dari `Repo HelpDesk/helpdesk-it`; aplikasi asli tidak perlu diubah atau dihentikan. Integrasi WhatsApp memakai [rmyndharis/OpenWA v0.32.1](https://github.com/rmyndharis/OpenWA/tree/v0.32.1), **bukan** layanan WasenderAPI atau paket lain bernama OpenWA.

## Persiapan lokal Windows

Gunakan Node.js **22.22.2+ atau 24.15+**, npm, Git, dan internet untuk mengunduh dependensi serta Chromium Puppeteer. Upstream menetapkan minimum 22.19, tetapi dependensi pengujian dashboard membutuhkan versi di atas; instalasi pada Node 24.13.1 mengeluarkan peringatan engine. Docker tidak diperlukan untuk SQLite dan penyimpanan lokal.

Struktur folder di bawah `KP`:

```text
KP/
  OpenWA/                 # gateway upstream v0.32.1
  helpdesk-it-openwa/      # clone ini
  Repo HelpDesk/helpdesk-it/  # aplikasi asli, jangan diubah
```

Jika gateway belum ada, dari folder `KP`:

```powershell
git clone --branch v0.32.1 --depth 1 https://github.com/rmyndharis/OpenWA.git OpenWA
cd OpenWA
npm ci
```

`npm ci` gateway juga memasang dependensi dashboard lewat postinstall.

Pada Windows dengan npm 11.8, `npm ci` mencoba membangun `better-sqlite3` meskipun paket menyediakan binary Windows dan menyatakan `gypfile:false`. Instalasi lokal diselesaikan tanpa Visual Studio memakai langkah berikut **dari folder OpenWA**, khusus lockfile v0.32.1:

```powershell
npm ci --ignore-scripts
npm rebuild @whiskeysockets/baileys @parcel/watcher @scarf/scarf msgpackr-extract protobufjs puppeteer ssh2 unrs-resolver --foreground-scripts
npm run postinstall
```

Jalankan setiap langkah hanya jika langkah sebelumnya berhasil. Jangan berhenti setelah `--ignore-scripts`: Chromium, dependensi dashboard, dan patch upstream memerlukan dua langkah terakhir. `cpu-features` dan binding kripto SSH native bersifat opsional; tanpa compiler C++ akselerasinya tidak tersedia, tetapi SSH menyediakan implementasi JavaScript. SQLite memakai `node_modules/better-sqlite3/prebuilds/win32-x64.node`, bukan hasil kompilasi lokal.

Dari folder clone `helpdesk-it-openwa`, pasang dependensi aplikasi bila belum terpasang:

```powershell
npm ci
cd backend
npm ci
```

Konfigurasi lokal berada di file **ignored**, bukan untuk diunggah:

- `OpenWA/.env`: `PORT=2785`, `NODE_ENV=development`, `ENGINE_TYPE=baileys`, `DATABASE_TYPE=sqlite`, `DATABASE_NAME=./data/openwa.sqlite`, `MAIN_DATABASE_NAME=./data/main.sqlite`, `DATABASE_SYNCHRONIZE=false`, `MAIN_DATABASE_SYNCHRONIZE=false`, `SESSION_DATA_PATH=./data/sessions`, `STORAGE_TYPE=local`, `STORAGE_LOCAL_PATH=./data/media`, `REDIS_ENABLED=false`, `QUEUE_ENABLED=false`, `AUTO_START_SESSIONS=true`.
- Tetapkan `RESOLVE_LID_TO_PHONE=true`, `MEDIA_DOWNLOAD_ENABLED=true`, `MEDIA_DOWNLOAD_MAX_BYTES=10485760` (**10 MiB**), dan `WEBHOOK_MEDIA_INLINE_MAX_BYTES=0`. Media tidak dimasukkan ke payload webhook; backend mengambil byte tersimpan lewat API media OpenWA.
- Biarkan `WEBHOOK_SSRF_PROTECT=true`; izinkan hanya `SSRF_ALLOWED_HOSTS=127.0.0.1,localhost` untuk webhook lokal. CORS dashboard: `CORS_ORIGINS=http://localhost:2886,http://127.0.0.1:2886`.
- Buat nilai acak kuat yang berbeda untuk `API_MASTER_KEY`, `API_KEY_PEPPER`, dan `OPENWA_WEBHOOK_SECRET` di `OpenWA/.env` sebelum boot pertama. Konfigurasi lokal yang disiapkan sudah berisi nilai acak; jangan mencetak atau membagikannya. Jangan mengganti pepper pada database yang sudah berisi API key tanpa prosedur rotasi upstream.
- Clone `backend/.env`: pertahankan `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; set `PORT=5001`, `FRONTEND_URL=http://localhost:3001`, `OPENWA_BASE_URL=http://127.0.0.1:2785/api`. Helper di bawah mengisi API key, UUID sesi, dan HMAC asli.
- Clone `.env.local`: pertahankan `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_ANON_KEY`; set `NEXT_PUBLIC_API_BASE_URL=http://localhost:5001/api`. **Jangan** menaruh service-role/API key/HMAC di variabel `NEXT_PUBLIC_*`.

**Peringatan Supabase:** clone ini masih memakai database, storage, dan akun Supabase yang sama dengan aplikasi asli. Pembuatan, perubahan, atau penghapusan tiket nyata akan memengaruhi keduanya. Gunakan proyek Supabase terpisah jika perlu isolasi data; gateway SQLite hanya menyimpan state gateway, bukan menggantikan Supabase helpdesk.

## Menjalankan dan menautkan WhatsApp

1. Terminal API gateway, dari `KP/OpenWA`:

   ```powershell
   npm run build
   npm run start:prod
   ```

   Build cukup sekali setelah pemasangan/perubahan source. `start:prod` menjalankan hasil build tanpa watcher; konfigurasi lokal tetap `NODE_ENV=development`. Mode `npm run dev` pernah memicu restart berulang dan respons 502 di mesin ini.

   Di terminal gateway kedua, dari folder yang sama:

   ```powershell
   npm run dashboard:dev
   ```

   API: `http://127.0.0.1:2785/api`; dashboard pengembangan: `http://localhost:2886`. Tunggu API aktif. Native API upstream dapat mendengarkan semua antarmuka: batasi akses dengan Windows Firewall; jangan mengekspos port ini ke internet.

2. Dari root `KP/helpdesk-it-openwa`, jalankan:

   ```powershell
   npm run openwa:setup
   ```

   Helper membaca `../OpenWA/.env` (fallback key: `../OpenWA/data/.api-key`), membuat/memakai sesi bernama `helpdesk-it`, lalu membuat/memperbarui webhook `http://127.0.0.1:5001/webhook/whatsapp` untuk `message.received`. HMAC cocok dengan `backend/.env`; nilai yang sudah ada dipertahankan. `OPENWA_SESSION_ID` diisi **UUID respons API**, bukan nama sesi. Nilai Supabase tidak diubah. Helper dapat dijalankan ulang dan tidak otomatis mengirim pesan atau membuat tiket.

3. Terminal backend:

   ```powershell
   cd backend
   npm run dev
   ```

   Backend memakai `http://localhost:5001`. Restart backend setiap selesai setup atau mengubah `.env`.

4. Terminal frontend, dari root clone:

   ```powershell
   npm run dev
   ```

   Buka `http://localhost:3001`. Port 3000/5000 tetap tersedia bagi aplikasi asli.

5. Masuk dashboard OpenWA `http://localhost:2886` memakai `API_MASTER_KEY` dari file lokal. Buka sesi `helpdesk-it`, klik **Start**, lalu pindai QR asli melalui WhatsApp di ponsel → **Perangkat tertaut**. Tunggu status **ready**. Setup bukan proses login WhatsApp: tanpa pemindaian pengguna, pengiriman/penerimaan nyata belum siap. Jangan menautkan akun yang sama ke dua gateway aktif tanpa memahami risiko sesi bertabrakan.

Simulator hanya membantu memeriksa alur bot; keberhasilannya bukan bukti pesan WhatsApp terkirim. Uji nyata dilakukan setelah sesi ready, menggunakan akun uji dan sadar bahwa tiket masuk ke Supabase bersama.

## Data persisten dan produksi

- Jangan menghapus `OpenWA/data/`: berisi database SQLite, API key, kredensial sesi, dan media lokal. Cadangkan seluruh direktori bersama `.env` secara aman; hentikan gateway sebelum menyalin SQLite secara manual. Pertahankan folder kerja saat menjalankan gateway agar path relatif tetap benar.
- Jalankan **satu proses backend**. Pertahankan `backend/data/openwa-webhooks/`: marker sukses di disk mencegah pemrosesan ulang event setelah restart dan terus bertambah. Penulisan Supabase dan marker tidak atomik; crash/kegagalan parsial masih dapat mengulang efek bisnis. Ini bukan jaminan exactly-once.
- `FRONTEND_URL=http://localhost:3001` hanya cocok di komputer ini. Tautan konfirmasi yang dibuka dari ponsel memerlukan alamat LAN/public frontend yang dapat dicapai ponsel, beserta konfigurasi API/CORS yang sesuai.
- Konfigurasi di atas khusus pengembangan satu mesin, bukan deployment produksi. Produksi memerlukan HTTPS/reverse proxy, firewall, proses terkelola, backup, `NODE_ENV=production`, serta build aplikasi/dashboard menurut panduan upstream. Jangan memakai Vite/Nest watch server sebagai layanan publik.
- Ganti API key admin integrasi dengan key operator yang dibatasi ke UUID sesi; simpan key admin hanya untuk pengelolaan. Gunakan URL webhook HTTPS yang dapat dicapai gateway dan HMAC kuat; jangan mematikan SSRF guard. Helper ini sengaja hanya menargetkan gateway HTTP lokal, bukan konfigurator produksi.
- OpenWA (Baileys maupun whatsapp-web.js) adalah integrasi **tidak resmi**, tanpa jaminan SLA atau bebas blokir akun; perubahan WhatsApp dapat memutus koneksi. Hindari spam, minta persetujuan penerima, dan gunakan WhatsApp Business Platform resmi jika kebijakan/keandalan layanan menuntutnya. Konfigurasi lokal memakai Baileys karena whatsapp-web.js gagal menghasilkan QR (`auth timeout`), termasuk dengan waktu tunggu 120 detik. Baileys memakai protokol langsung, bukan browser; maintainer memperingatkan profil risiko blokirnya lebih tinggi.

Pemeriksaan helper tanpa jaringan atau perubahan file: `node scripts/setup-openwa.mjs --self-test`.

Pengujian backend: dari folder `backend`, jalankan `npm test` lalu `npm run build`. Tes menguji kontrak HTTP dengan fixture terisolasi, bukan pengiriman WhatsApp nyata. Uji webhook bawaan OpenWA membuktikan jalur HMAC ke backend tanpa membuat tiket; pengiriman pesan dan lampiran nyata baru dapat diuji setelah pengguna menautkan nomor.
#   h e l p d e s k - i t - o p e n w a  
 