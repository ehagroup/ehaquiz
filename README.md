# Kuis & Game 5R AI

Aplikasi kuis & game interaktif bertema 5R (Ringkas, Rapi, Resik, Rawat, Rajin)
dengan mode Guru (dashboard) dan Murid (peserta), realtime menggunakan
Firebase Firestore. Proyek ini sudah dibungkus sebagai proyek **Vite + React +
TypeScript + Tailwind CSS** yang siap di-deploy ke **Vercel**.

## Fitur baru di versi ini

- **Acak urutan pilihan jawaban per peserta** — bisa diaktif/nonaktifkan lewat
  "Pengaturan Waktu & Tampilan". Kalau aktif, tiap peserta melihat urutan
  A/B/C/D yang berbeda-beda (diacak otomatis & konsisten per peserta) untuk
  mengurangi kemungkinan saling mencontek antar peserta yang duduk berdekatan.
- **Tampilkan/sembunyikan label A/B/C/D** pada pilihan jawaban — juga diatur
  lewat "Pengaturan Waktu & Tampilan".
- **Pengaturan waktu** — durasi kuis pilihan ganda (menit) kini benar-benar
  bisa diatur dari dashboard, begitu juga durasi tiap tahap Game 5R (dalam
  detik), bukan lagi nilai tetap di dalam kode.
- **Game 5R kini hanya 3 tahap** (Ringkas, Rapi, Rawat) — Tahap "Resik" (Grid
  3x3) sudah dihapus sesuai permintaan; nomor tahap disusun ulang jadi
  Tahap 1–3.
- **Game 5R ikut masuk Bank Soal** — pengaturan durasi tiap tahap Game 5R bisa
  disimpan sebagai preset ke Bank Soal (terpisah dari set soal pilihan ganda)
  dan dimuat lagi kapan saja tanpa mengatur ulang dari nol.
- **Soal grafis (gambar pada soal)** — saat membuat soal pilihan ganda, guru
  bisa melampirkan gambar (upload file, otomatis dikompres di browser, atau
  tempel URL gambar). Gambar tampil di layar peserta di atas teks soal, dan
  di halaman "Lihat Pembahasan".
- **Import soal dari CSV *atau* Excel (.xlsx/.xls)** — plus tombol **Download
  Template** yang menghasilkan file `.xlsx` siap-isi dengan format kolom yang
  benar (termasuk kolom URL gambar opsional).
- **Bank Soal** — set soal pilihan ganda yang pernah dibuat bisa disimpan
  dengan judul, lalu dimuat lagi kapan saja tanpa mengetik ulang.
- **Riwayat Kuis otomatis** — setiap sesi kuis/game yang diakhiri (manual atau
  waktu habis) otomatis direkap (tanggal, PIN, jumlah peserta, rata-rata
  skor, papan peringkat top 10) dan bisa dilihat lagi lewat tab "Riwayat
  Kuis", lengkap dengan export CSV per sesi maupun gabungan semua riwayat.
- **Bank Soal & Riwayat Kuis disimpan di spreadsheet login yang sama** —
  data tersebut otomatis dituliskan mulai dari **kolom C** pada baris email
  guru yang bersangkutan (kolom A = email, kolom B = password). Kalau data
  terlalu panjang untuk satu sel, otomatis disambung ke kolom berikutnya
  (D, E, F, dst). Fitur ini butuh setup tambahan sekali saja — lihat bagian
  **"Setup Google Apps Script"** di bawah.
- **Judul Sesi Kuis** — beri nama tiap sesi (mis. "Kuis 5R Kelas 7A") supaya
  mudah dikenali di Riwayat Kuis maupun tampilan Ruang Tunggu/Live.
- **Pembahasan jawaban untuk Murid** — setelah kuis pilihan ganda selesai,
  peserta bisa membuka "Lihat Pembahasan" untuk melihat jawabannya vs kunci
  jawaban per soal.
- **Peringkat sementara untuk Murid** — tombol "Peringkat" saat mengerjakan
  kuis pilihan ganda menampilkan top 5 sementara secara realtime.

## Pembaruan: sekarang mendukung banyak Guru bermain BERSAMAAN (multi-akun)

Sebelumnya, seluruh aplikasi hanya punya **satu** sesi kuis/game aktif untuk
SEMUA orang — disimpan di satu dokumen Firestore global (`quizSession/state`)
dan satu koleksi peserta global (`students`). Akibatnya:

- Kalau dua Guru membuka dashboard pada saat yang sama, mereka **saling
  menimpa** sesi satu sama lain.
- Membuka ruang kuis baru **menghapus semua peserta**, termasuk peserta
  milik Guru lain yang sesinya sedang berjalan.
- PIN yang sedang ditampilkan ke satu Guru bisa tertimpa begitu Guru lain
  membuka ruang barunya sendiri.

Sekarang setiap akun Guru (dikenali dari email login) otomatis mendapat
**sesi kuisnya masing-masing**, terpisah total dari Guru lain:

- Tiap sesi kuis/game yang dibuka disimpan sebagai dokumen tersendiri,
  dikunci oleh **PIN unik miliknya sendiri** —
  `artifacts/{appId}/public/data/quizSessions/{PIN}` — lengkap dengan
  sub-koleksi peserta khusus sesi itu di `.../quizSessions/{PIN}/students`.
- Setiap akun Guru punya "penunjuk" ke sesi aktif miliknya di
  `artifacts/{appId}/public/data/teacherSessions/{email}`, supaya dashboard
  otomatis tersambung lagi ke sesinya sendiri walau halaman dimuat ulang —
  bukan ke sesi Guru lain.
- Peserta (Murid) juga mendapat penunjuk serupa di
  `artifacts/{appId}/public/data/studentActiveSession/{uid}`, supaya kalau
  halamannya dimuat ulang, ia otomatis tersambung lagi ke kuis yang sama
  tanpa perlu memasukkan ulang PIN & nama.
- Membuka ruang kuis baru sekarang hanya membersihkan sesi **lama milik
  Guru itu sendiri**; sesi Guru lain yang sedang berjalan bersamaan tidak
  lagi tersentuh sama sekali.
- PIN dibuat unik secara otomatis (dicek dulu ke Firestore sebelum dipakai)
  supaya dua Guru yang membuka ruang di waktu yang berdekatan tidak
  kebagian PIN yang sama.

**Tidak perlu setup tambahan** untuk fitur ini — `firestore.rules` yang
sudah ada (mengizinkan akses ke `artifacts/{appId}/public/data/**`) otomatis
sudah mencakup path-path baru di atas.

> Catatan: karena login Guru bukan Firebase Authentication sungguhan (hanya
> dicek dari Google Sheet, sama seperti sebelumnya), pemisahan sesi ini
> terjadi di **level aplikasi** — setiap Guru hanya diarahkan ke sesi
> miliknya sendiri lewat email login yang ia pakai untuk login — bukan lewat
> Firestore Security Rules. Ini konsisten dengan model keamanan aplikasi ini
> sejak awal (lihat bagian "Catatan keamanan" di bawah).

## Isi proyek

```
├── src/
│   ├── App.tsx            # Seluruh logika & tampilan aplikasi
│   ├── main.tsx           # Entry point React
│   ├── index.css          # Direktif Tailwind CSS
│   └── lib/
│       └── sheetStorage.ts  # Client untuk baca/tulis Bank Soal & Riwayat
│                             # Kuis ke spreadsheet (lewat Apps Script)
├── apps-script/
│   └── Code.gs             # WAJIB di-deploy manual dari Google Sheets (lihat
│                            # panduan "Setup Google Apps Script" di bawah)
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── vercel.json
├── firestore.rules       # Contoh Security Rules untuk Firebase Console
└── .env.example          # Override konfigurasi Firebase + VITE_SHEETS_API_URL
```

## Update terbaru: perbaikan "Murid tidak bisa bergabung/mengakses kuis"

Ditemukan **penyebab utama**: konfigurasi Firebase bawaan punya `projectId`
(`qcreativeproject-331c9`, ada huruf **"q"** ekstra) yang **tidak cocok**
dengan `authDomain`/`storageBucket` (`creativeproject-331c9...`, tanpa huruf
"q"). Akibatnya seluruh permintaan Firestore diarahkan ke project yang salah.
`projectId` sudah diperbaiki menjadi `creativeproject-331c9` agar konsisten.

Selain itu ditambahkan:
- **Tes koneksi Firestore nyata** (`getDocFromServer`, bukan cache lokal) yang
  jalan otomatis begitu halaman dibuka, di perangkat guru maupun murid, supaya
  masalah koneksi/konfigurasi langsung terlihat lewat banner merah — tidak lagi
  bisa "tampak berhasil" padahal sebenarnya gagal di server (ini bisa terjadi
  karena Firestore menampilkan data secara optimis dari cache lokal sebelum
  server benar-benar merespons).
- Proses **"BERGABUNG"** di sisi murid sekarang menunggu konfirmasi nyata dari
  server sebelum menampilkan layar "sudah gabung", serta menampilkan pesan
  error langsung di dalam form (bukan hanya lewat `alert()`) jika gagal.

**Jika Anda memakai project Firebase sendiri** (lewat Environment Variables,
lihat `.env.example`), pastikan `projectId` yang Anda isi **sama persis**
dengan bagian depan `authDomain` Anda — cek ulang di Firebase Console →
Project Settings → General.

## Perbaikan yang dilakukan saat bundling

1. **Firebase config TIDAK diubah** — persis seperti yang Anda berikan
   (`projectId: "qcreativeproject-331c9"`, dst).
2. **Variabel global khusus environment "Canvas" dihapus** (`__firebase_config`,
   `__app_id`, `__initial_auth_token`). Variabel ini hanya ada di editor AI
   tertentu dan tidak tersedia di deployment mandiri seperti Vercel — sudah
   diganti dengan konfigurasi Firebase langsung + opsi override lewat
   Environment Variables Vite (lihat `.env.example`).
3. **Penanganan error Firestore/Auth ditambahkan di seluruh aplikasi.** Versi
   asli tidak menampilkan apa pun ke layar kalau proses simpan/baca data ke
   Firestore gagal (misalnya karena Security Rules belum di-publish atau
   Anonymous Authentication belum aktif) — tombol seperti "Buka Tahap 1" atau
   "Buka Ruang Kuis Pilihan Ganda" akan terlihat seperti tidak melakukan
   apa-apa. Sekarang:
   - Muncul **banner merah** di bagian atas layar kalau login/Firestore
     gagal, lengkap dengan penyebab & cara memperbaikinya.
   - Setiap aksi guru (buka ruang, mulai game, akhiri sesi, keluarkan
     peserta, kembali ke setup) menampilkan **alert penjelasan** kalau gagal,
     bukan diam saja.
   - Tombol "Buka Tahap 1–3" & "Buka Ruang Kuis Pilihan Ganda" menampilkan
     status **"Membuka..."** saat sedang diproses.
   - Murid yang gagal bergabung (join PIN) atau gagal menyimpan jawaban juga
     mendapat pesan yang jelas.
4. Semua **fitur, tampilan, dan alur/logic asli lainnya tidak diubah** (mode
   Guru, mode Murid, 3 tahap Game 5R, kuis pilihan ganda, leaderboard,
   podium, export CSV/Excel, dsb).

## 1. Jalankan secara lokal (opsional, untuk uji coba)

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`.

## 2. Setup Firebase (WAJIB agar fitur realtime & ruang kuis berfungsi)

Aplikasi ini memakai project Firebase `qcreativeproject-331c9` yang sudah
tertanam di kode. Agar semua fitur (login, PIN ruang kuis, skor realtime,
leaderboard) berjalan, pastikan di **Firebase Console** project tersebut:

1. **Authentication → Sign-in method → Anonymous** → aktifkan.
2. **Firestore Database** sudah dibuat (mode production/production-like).
3. **Firestore → Rules** → tempel isi file [`firestore.rules`](./firestore.rules)
   dari proyek ini, lalu klik **Publish**. Tanpa rules yang sesuai, semua
   pembacaan/penulisan data (skor, soal, peserta) akan ditolak oleh Firestore.

> Ingin pakai project Firebase Anda sendiri? Isi variabel di file
> `.env.example` (salin jadi `.env` untuk lokal, atau isi langsung di
> **Vercel → Project Settings → Environment Variables** untuk production),
> lalu ulangi langkah 1–3 di atas untuk project Anda.

### Tentang login Guru (Google Sheets)

Mode Guru login memakai data dari Google Spreadsheet publik (kolom A = email,
kolom B = password) melalui link `gviz/tq`. Pastikan spreadsheet tersebut
di-share dengan akses **"Anyone with the link – Viewer"**, kalau tidak proses
login guru akan gagal terhubung.

## 3. Setup Google Apps Script (WAJIB untuk Bank Soal & Riwayat Kuis)

Link `gviz/tq` yang dipakai untuk login guru sifatnya **hanya bisa dibaca**
(read-only). Supaya aplikasi juga bisa **menuliskan** data Bank Soal &
Riwayat Kuis balik ke spreadsheet yang sama, dibutuhkan sebuah "jembatan"
kecil bernama Google Apps Script, yang di-deploy sebagai **Web App** langsung
dari dalam spreadsheet login tersebut. Ini setup sekali saja oleh pemilik
spreadsheet.

1. Buka **spreadsheet login Pemateri** (yang sama, berisi kolom email &
   password) di Google Sheets.
2. Menu **Extensions → Apps Script**.
3. Hapus semua kode contoh (`function myFunction() {...}`) yang ada di editor,
   lalu tempel **seluruh isi file [`apps-script/Code.gs`](./apps-script/Code.gs)**
   dari paket proyek ini.
4. Klik **Deploy → New deployment**.
5. Klik ikon gear ⚙️ di sebelah "Select type" → pilih **Web app**.
6. Isi:
   - **Description**: bebas, misalnya "Kuis 5R Bridge"
   - **Execute as**: **Me** (akun Google Anda)
   - **Who has access**: **Anyone**
7. Klik **Deploy**. Google akan meminta izin akses (Authorize access) —
   izinkan menggunakan akun Google pemilik spreadsheet.
8. Salin **Web app URL** yang muncul (berakhiran `.../exec`).
9. Tempel URL tersebut sebagai Environment Variable **`VITE_SHEETS_API_URL`**:
   - **Lokal**: buat file `.env` (copy dari `.env.example`), isi variabelnya.
   - **Vercel**: Project Settings → Environment Variables → tambahkan
     `VITE_SHEETS_API_URL`, lalu **Redeploy**.
10. Selesai — tab **Bank Soal** & **Riwayat Kuis** di dashboard Guru akan
    otomatis aktif setelah halaman dimuat ulang.

> **Kalau kode `Code.gs` diedit/diperbarui lagi di kemudian hari**, harus
> dibuat **"New deployment"** baru lagi (atau lewat **Manage deployments →
> Edit → pilih versi baru**) supaya perubahannya benar-benar aktif — URL
> web app-nya boleh tetap sama kalau memakai opsi edit versi.

**Cara kerja penyimpanan** (otomatis, tidak perlu diatur manual): Bank Soal +
Riwayat Kuis milik satu guru digabung jadi satu teks, lalu dituliskan mulai
dari **kolom C** pada baris email guru tersebut di spreadsheet yang sama.
Kalau datanya terlalu panjang untuk muat di satu sel, sisanya otomatis
disambung ke kolom berikutnya (D, E, F, dst). **Jangan mengedit manual**
sel-sel di kolom C dan seterusnya, karena akan ditimpa ulang setiap kali
aplikasi menyimpan perubahan.

Kalau `VITE_SHEETS_API_URL` **tidak diisi**, aplikasi tetap berjalan normal
seperti biasa — hanya saja tab Bank Soal & Riwayat Kuis akan menampilkan
peringatan bahwa fitur tersebut belum aktif.

## Troubleshooting: "Ruang kuis tidak bisa dibuka"

Setelah update ini, kalau ruang kuis masih gagal dibuka, sekarang **akan selalu
muncul pesan** (banner merah di atas layar, dan/atau alert saat klik tombol)
yang menjelaskan penyebabnya. Dua penyebab paling umum:

| Pesan / gejala | Penyebab | Solusi |
|---|---|---|
| Banner: "Gagal login otomatis ke Firebase (Anonymous Authentication)" | Anonymous sign-in belum diaktifkan | Firebase Console → **Authentication → Sign-in method → Anonymous → Enable** |
| Alert: "Akses ditolak oleh Firestore Security Rules" | Rules masih default (menolak semua akses) | Firebase Console → **Firestore Database → Rules** → tempel isi `firestore.rules` → **Publish** |
| Banner/alert menyebut "not-found" atau Firestore tidak merespons | Firestore Database belum pernah dibuat di project ini | Firebase Console → **Firestore Database → Create database** (pilih lokasi & mode production) |

Setelah memperbaiki salah satu di atas, **muat ulang (refresh) halaman** —
tidak perlu deploy ulang.

## 4. Deploy ke Vercel

### Opsi A — Lewat Vercel CLI (tercepat)

```bash
npm i -g vercel   # jika belum ada
vercel login
vercel            # ikuti instruksi, pilih "Other"/"Vite" saat ditanya framework
vercel --prod     # deploy ke production
```

### Opsi B — Lewat Dashboard Vercel (upload folder ini / import Git)

1. Extract file zip ini.
2. Push folder ke GitHub/GitLab/Bitbucket (atau upload langsung via
   `vercel` CLI seperti Opsi A jika tidak ingin pakai Git).
3. Di [vercel.com](https://vercel.com) → **Add New Project** → import repo
   tersebut (atau drag-and-drop folder jika menggunakan Vercel CLI).
4. Vercel otomatis mendeteksi **Framework: Vite**, dengan:
   - Build Command: `npm run build`
   - Output Directory: `dist`
   (Sudah diatur juga di `vercel.json` sebagai jaminan tambahan.)
5. Jika Anda mengisi `.env` custom di langkah 2, tambahkan variabel yang sama
   di **Project Settings → Environment Variables** sebelum/atau setelah
   deploy pertama (lalu klik **Redeploy**).
6. Klik **Deploy**. Setelah selesai, Anda akan mendapat URL seperti
   `https://nama-project-anda.vercel.app`.

## 5. Cara pakai setelah live

- **Guru**: buka URL utama → "Masuk Mode Guru" → login pakai email/password
  yang ada di Google Sheet → pilih tab **Setup Kuis**, **Bank Soal**, atau
  **Riwayat Kuis** → pilih jenis game/kuis (atau muat dari Bank Soal) →
  bagikan PIN atau QR code ke murid.
  - Beri **Judul Sesi Kuis** (opsional) supaya mudah dikenali di Riwayat.
  - Atur **Pengaturan Waktu & Tampilan**: durasi kuis pilihan ganda, durasi
    tiap tahap Game 5R, acak/tidak urutan pilihan jawaban per peserta, dan
    tampilkan/sembunyikan label A/B/C/D.
  - Buat soal manual (bisa lampirkan **gambar soal** untuk soal grafis), atau
    klik **Import Soal** untuk mengimpor banyak soal sekaligus dari file
    `.csv` maupun `.xlsx`/`.xls` (format: pertanyaan, pilihan A, pilihan B,
    pilihan C, pilihan D, jawaban, URL gambar opsional). Klik **Download
    Template** untuk mendapatkan file Excel siap-isi dengan format yang benar.
  - Klik **Simpan ke Bank Soal** untuk menyimpan set soal pilihan ganda, atau
    **Simpan Pengaturan Ini ke Bank Soal** untuk menyimpan preset durasi
    Game 5R — keduanya bisa dimuat lagi lain waktu dari tab **Bank Soal**
    tanpa mengatur ulang dari nol.
  - Setiap sesi yang diakhiri otomatis tercatat di tab **Riwayat Kuis**,
    lengkap dengan papan peringkat top 10 dan tombol export CSV.
- **Murid**: buka URL utama (atau scan QR code yang tampil di halaman guru) →
  "Masuk Mode Murid" → masukkan PIN & nama.
  - Selama mengerjakan kuis pilihan ganda, ada tombol **Peringkat** untuk
    mengintip peringkat sementara.
  - Setelah kuis pilihan ganda selesai, ada tombol **Lihat Pembahasan** untuk
    melihat jawaban vs kunci jawaban tiap soal.
- Guru bisa **Download Excel Rekap Nilai** (format CSV) kapan saja dari
  dashboard maupun dari layar podium pemenang.

## Catatan keamanan

- Anonymous Authentication + Firestore rules `if request.auth != null`
  berarti **siapa pun yang membuka aplikasi** bisa membaca/menulis data sesi
  (skor, nama peserta, dsb) di path manapun di bawah `artifacts/{appId}/public/data/`
  — termasuk sesi kuis milik Guru lain kalau tahu/menebak PIN atau path
  dokumennya. Ini wajar untuk kebutuhan kuis kelas sederhana, tapi jangan
  gunakan untuk data sensitif.
- Password login guru dicek sebagai teks biasa dari Google Sheet publik —
  cukup untuk kelas, tapi jangan pakai password yang juga dipakai di akun
  penting lain.
- Web App Apps Script (`apps-script/Code.gs`) hanya mengecek **email** untuk
  menentukan baris tujuan (tidak mengecek password) — ini konsisten dengan
  sifat spreadsheet yang memang sudah publik-terbaca. Jangan bagikan URL
  `.../exec` tersebut secara terbuka di luar kebutuhan aplikasi ini, karena
  siapa pun yang tahu URL-nya + email seorang guru bisa menimpa data Bank
  Soal/Riwayat Kuis guru tersebut.
