import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'firebase/auth';
import { 
  getFirestore, doc, getDoc, setDoc, onSnapshot, collection, getDocs, writeBatch, deleteDoc, getDocFromServer
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import {
  GraduationCap, Gamepad2, Lock, Hourglass, Rocket, Trophy, X, 
  Users, Crown, Play, ArrowLeft, AlertCircle, Grid, Timer, LogOut, CheckCircle2, Layers, Download, Table,
  BookOpen, History, Upload, Save, ChevronDown, ChevronUp, RefreshCw, Trash2, PlusCircle,
  Eye, BarChart3, Image as ImageIcon, FileSpreadsheet, ToggleLeft, ToggleRight, Shuffle,
  Settings2, Landmark, Brain, UserCheck, ClipboardList, Info
} from 'lucide-react';
import {
  isSheetStorageConfigured, loadTeacherData, saveTeacherData, emptyTeacherData
} from './lib/sheetStorage';

// ============================================================================
// UTILITAS: PARSER CSV SEDERHANA (untuk fitur Import Soal dari CSV)
// ----------------------------------------------------------------------------
// Menangani koma di dalam tanda kutip ("...") dengan benar, contoh:
// Pertanyaan berisi, koma?,"Ya, benar",Tidak,,,a
// ============================================================================
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function formatTanggal(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

// ============================================================================
// UTILITAS: ACAK OPSI JAWABAN PER PESERTA (deterministik, tanpa perlu disimpan)
// ----------------------------------------------------------------------------
// Setiap peserta (dibedakan lewat UID) melihat urutan pilihan A/B/C/D yang
// berbeda-beda untuk mengurangi kemungkinan mencontek. Supaya urutan yang
// dilihat peserta tetap SAMA setiap kali komponen re-render atau halaman
// dimuat ulang (termasuk saat membuka "Lihat Pembahasan" setelah kuis
// selesai), pengacakannya dibuat deterministik: di-seed dari kombinasi UID
// peserta + nomor soal, BUKAN acak murni setiap render. Jadi tidak perlu
// menulis data tambahan ke Firestore untuk fitur ini.
// ============================================================================
function seedFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const rand = mulberry32(seedFromString(seedStr));
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Mengembalikan urutan tampil opsi jawaban (mis. ['c','a','d','b']) untuk satu
// soal & satu peserta tertentu. Hanya opsi yang ada isinya yang disertakan.
// Kalau shuffleEnabled = false, urutannya tetap a-b-c-d seperti biasa.
function getDisplayOptionOrder(question, seedKey, shuffleEnabled) {
  const opts = ['a', 'b', 'c', 'd'].filter(o => question && question[o]);
  if (!shuffleEnabled) return opts;
  return seededShuffle(opts, seedKey);
}

// ============================================================================
// UTILITAS: KOMPRESI GAMBAR SOAL DI SISI BROWSER (untuk fitur "Soal Grafis")
// ----------------------------------------------------------------------------
// Gambar yang di-upload guru diubah ukurannya (maks. 900px sisi terpanjang)
// dan dikompres ke JPEG kualitas 0.72 sebelum disimpan sebagai data URI di
// dalam soal. Ini penting karena soal (termasuk gambarnya) ikut tersimpan di
// satu dokumen Firestore (batas 1MB) dan/atau di sel spreadsheet Bank Soal —
// tanpa kompresi, foto langsung dari kamera HP (beberapa MB) bisa membuat
// kuis gagal dibuka atau gagal disimpan.
// ============================================================================
function resizeImageFile(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Gagal memuat gambar.'));
      img.src = String(e.target?.result || '');
    };
    reader.onerror = () => reject(new Error('Gagal membaca file.'));
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// UTILITAS: IMPORT SOAL (dipakai bersama oleh import CSV maupun Excel/XLSX)
// ----------------------------------------------------------------------------
// Format kolom per baris: pertanyaan, pilihan A, pilihan B, pilihan C,
// pilihan D, jawaban (a/b/c/d), URL gambar (opsional, untuk soal grafis).
// Menerima array-of-array (baris x kolom) yang sudah diparsing dari CSV
// ataupun dari sheet Excel, supaya logikanya tidak dobel.
// ============================================================================
function isImportHeaderRow(cols) {
  const first = (cols?.[0] ?? '').toString();
  return /pertanyaan|question/i.test(first);
}

function importRowsToQuestions(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const startIdx = isImportHeaderRow(rows[0]) ? 1 : 0;
  const parsed = [];
  for (let i = startIdx; i < rows.length; i++) {
    const cols = rows[i] || [];
    const q = (cols[0] ?? '').toString().trim();
    const a = (cols[1] ?? '').toString().trim();
    const b = (cols[2] ?? '').toString().trim();
    const c = (cols[3] ?? '').toString().trim();
    const d = (cols[4] ?? '').toString().trim();
    const answerRaw = (cols[5] ?? 'a').toString().trim().toLowerCase();
    const image = (cols[6] ?? '').toString().trim();
    if (!q || !a || !b) continue;
    parsed.push({
      q, a, b, c, d,
      answer: ['a', 'b', 'c', 'd'].includes(answerRaw) ? answerRaw : 'a',
      image,
    });
  }
  return parsed;
}

// ============================================================================
// METADATA GAME "SKD CPNS" (Seleksi Kompetensi Dasar)
// ----------------------------------------------------------------------------
// Meniru struktur asli Tes SKD CPNS yang sesungguhnya, yang terdiri dari 3
// sub-tes: TWK, TIU, dan TKP. Total resmi 110 soal dikerjakan dalam 100 menit
// (30 TWK + 35 TIU + 45 TKP). Karena di aplikasi ini tiap sub-tes dibuka
// sebagai sesi/room terpisah (mengikuti pola "Tahap 1/2/3" pada Game 5R),
// alokasi 100 menit itu dipecah per sub-tes sebagai REKOMENDASI awal (bisa
// diubah bebas oleh Pemateri) — jumlah soal & totalnya tetap mengacu ke
// format resmi CPNS.
// ============================================================================
const SKD_META = {
  twk: {
    key: 'twk',
    quizType: 'skd-twk',
    label: 'TWK',
    nama: 'Tes Wawasan Kebangsaan',
    deskripsi: 'Nasionalisme, integritas, bela negara, pilar negara & Bahasa Indonesia.',
    recommendedCount: 30,
    recommendedMinutes: 25,
    icon: Landmark,
    accent: 'sky',
  },
  tiu: {
    key: 'tiu',
    quizType: 'skd-tiu',
    label: 'TIU',
    nama: 'Tes Intelegensia Umum',
    deskripsi: 'Kemampuan verbal, numerik, dan figural (logika & hitungan).',
    recommendedCount: 35,
    recommendedMinutes: 35,
    icon: Brain,
    accent: 'violet',
  },
  tkp: {
    key: 'tkp',
    quizType: 'skd-tkp',
    label: 'TKP',
    nama: 'Tes Karakteristik Pribadi',
    deskripsi: 'Pelayanan publik, jejaring kerja, sosial budaya & profesionalisme ASN.',
    recommendedCount: 45,
    recommendedMinutes: 40,
    icon: UserCheck,
    accent: 'amber',
  },
};
const SKD_ORDER = ['twk', 'tiu', 'tkp'];
const DEFAULT_SKD_DURATIONS = { twk: 25, tiu: 35, tkp: 40 }; // menit, total 100 menit persis seperti tes CPNS asli

// ============================================================================
// KONFIGURASI FIREBASE
// Catatan: apiKey Firebase untuk aplikasi WEB memang bukan rahasia (aman
// untuk publik) — keamanan data sesungguhnya diatur lewat Firestore Security
// Rules & Firebase Authentication, bukan lewat menyembunyikan apiKey ini.
// Nilai di bawah bisa ditimpa lewat Environment Variables di Vercel (opsional,
// lihat file .env.example). Jika tidak diisi, aplikasi otomatis memakai
// konfigurasi bawaan di bawah ini.
// ============================================================================
const env = import.meta.env;
const envFirebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};
const hasEnvFirebaseConfig = Object.values(envFirebaseConfig).every(Boolean);

const defaultFirebaseConfig = {
  apiKey: "AIzaSyCiw7GBI5P9al1Zq2qJ6kDPuHvfrAUWHVo",
  authDomain: "creativeproject-331c9.firebaseapp.com",
  // PERBAIKAN: projectId sebelumnya "qcreativeproject-331c9" (ada huruf "q"
  // ekstra di depan) sehingga TIDAK COCOK dengan authDomain & storageBucket
  // di bawah ini (yang tidak punya huruf "q"). Project ID Firebase bersifat
  // permanen & harus selalu sama persis dengan domain-domain tersebut, jadi
  // ketidakcocokan ini membuat SEMUA permintaan Firestore (baca soal, simpan
  // jawaban, daftar peserta, dsb.) diarahkan ke project yang tidak ada/salah
  // — inilah sebab utama Peserta tidak bisa bergabung ke kuis.
  projectId: "creativeproject-331c9",
  storageBucket: "creativeproject-331c9.firebasestorage.app",
  messagingSenderId: "475885252602",
  appId: "1:475885252602:web:4c72076ee16a572801fe43"
};

const firebaseConfig = hasEnvFirebaseConfig ? envFirebaseConfig : defaultFirebaseConfig;

const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const appId = env.VITE_APP_ID || 'default-quiz-app';

// ============================================================================
// MULTI-AKUN: SETIAP GURU PUNYA SESI KUIS SENDIRI-SENDIRI
// ----------------------------------------------------------------------------
// Versi sebelumnya menyimpan SATU dokumen sesi kuis global
// ("quizSession/state") dan SATU koleksi peserta global ("students") untuk
// SELURUH aplikasi. Akibatnya kalau lebih dari satu guru membuka dashboard
// pada saat yang sama, mereka akan saling menimpa sesi satu sama lain (bahkan
// membuka ruang baru akan MENGHAPUS peserta milik guru lain).
//
// Sekarang setiap sesi kuis/game yang aktif disimpan sebagai dokumen
// TERPISAH, diberi kunci PIN unik-nya sendiri:
//   artifacts/{appId}/public/data/quizSessions/{pin}                (state sesi)
//   artifacts/{appId}/public/data/quizSessions/{pin}/students/{uid} (peserta sesi itu)
//
// Supaya dashboard tiap guru otomatis tersambung ke SESI MILIKNYA SENDIRI
// (bukan sesi guru lain, dan tetap tersambung walau halaman dimuat ulang),
// setiap akun guru (kunci = email login-nya) punya "penunjuk" sesi aktif:
//   artifacts/{appId}/public/data/teacherSessions/{teacherKey} -> { pin }
//
// Begitu juga tiap Peserta (kunci = UID anonim perangkatnya) punya penunjuk
// sesi yang sedang ia ikuti, supaya kalau halaman dimuat ulang ia otomatis
// tersambung lagi ke kuis yang sama tanpa perlu memasukkan PIN & nama ulang:
//   artifacts/{appId}/public/data/studentActiveSession/{uid} -> { pin }
// ============================================================================
function sanitizeAccountKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[\/\s]+/g, '_') || 'guru';
}

function teacherSessionPointerRef(teacherKey) {
  return doc(db, 'artifacts', appId, 'public', 'data', 'teacherSessions', teacherKey);
}

function studentSessionPointerRef(uid) {
  return doc(db, 'artifacts', appId, 'public', 'data', 'studentActiveSession', uid);
}

function quizSessionRef(pin) {
  return doc(db, 'artifacts', appId, 'public', 'data', 'quizSessions', pin);
}

function quizSessionStudentsRef(pin) {
  return collection(db, 'artifacts', appId, 'public', 'data', 'quizSessions', pin, 'students');
}

function quizSessionStudentRef(pin, uid) {
  return doc(db, 'artifacts', appId, 'public', 'data', 'quizSessions', pin, 'students', uid);
}

// Menghapus dokumen sesi + seluruh sub-koleksi pesertanya (dipakai saat guru
// membuka ruang baru menggantikan sesi lamanya, atau kembali ke menu setup).
async function deleteQuizSession(pin) {
  if (!pin) return;
  const snap = await getDocs(quizSessionStudentsRef(pin));
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(quizSessionRef(pin));
  await batch.commit();
}

// Membuat PIN 5-digit acak yang dipastikan belum dipakai sesi lain yang
// sedang berjalan (supaya PIN antar guru yang bermain bersamaan tidak
// bentrok satu sama lain).
async function generateUniquePin() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = Math.floor(10000 + Math.random() * 90000).toString();
    try {
      const existing = await getDoc(quizSessionRef(candidate));
      if (!existing.exists()) return candidate;
    } catch (error) {
      // Kalau pengecekan gagal (mis. jaringan), tetap coba pakai PIN ini
      // daripada memblokir guru membuka ruang kuis sama sekali.
      return candidate;
    }
  }
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// ============================================================================
// STYLING CSS GLOBAL
// ============================================================================
const globalStyles = `
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; font-family: sans-serif; background-color: #0f172a; }

  @keyframes gradientBG {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  
  .animated-bg {
    background: linear-gradient(-45deg, #0f172a, #312e81, #4c1d95, #1e1b4b);
    background-size: 400% 400%;
    animation: gradientBG 15s ease infinite;
    color: white;
    min-height: 100vh;
    width: 100%;
  }
  
  .glass-card {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  }
  
  .glass-card-light {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(32px);
    -webkit-backdrop-filter: blur(32px);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  
  .glass-input {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: white;
  }
  
  .glass-input:focus {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.5);
    outline: none;
  }
  
  .struck-through {
    text-decoration: line-through;
    text-decoration-color: #ef4444;
    text-decoration-thickness: 4px;
    opacity: 0.3;
    transform: scale(0.85);
    pointer-events: none;
  }

  /* ==========================================================================
     .glass-tile: KHUSUS TOMBOL ANGKA DI PAPAN GAME 5R
     ----------------------------------------------------------------------------
     Tampilannya SAMA PERSIS dengan .glass-card (background, border, blur,
     shadow semua identik). Dibuat sebagai class terpisah HANYA supaya efek
     blur-nya bisa dimatikan khusus di mobile (lihat media query di bawah)
     tanpa menyentuh .glass-card yang dipakai di panel/kartu lain.
     ========================================================================== */
  .glass-tile {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  }

  /* ==========================================================================
     OPTIMASI PERFORMA KHUSUS MODE MOBILE (layar <= 768px)
     ----------------------------------------------------------------------------
     Papan Game 5R bisa menampilkan sampai 90 tombol angka sekaligus di layar.
     Sebelumnya setiap tombol memakai backdrop-filter (blur kaca) sendiri2 —
     di HP, efek blur yang dihitung ulang oleh GPU untuk puluhan elemen
     SEKALIGUS (ditambah background yang terus bergerak di baliknya) adalah
     penyebab utama aplikasi terasa berat & patah-patah saat main. Di bawah
     ini blur pada tiap tombol angka dimatikan KHUSUS di mobile, dan animasi
     gradasi background dihentikan (warnanya tetap sama, hanya tidak
     "mengalir" terus-menerus). Tampilan di layar desktop/tablet besar (>768px)
     TIDAK berubah sama sekali karena aturan ini hanya aktif di bawah 769px.
     ========================================================================== */
  @media (max-width: 768px) {
    .glass-tile {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .animated-bg {
      animation: none;
      background-position: 50% 50%;
    }
  }
`;

// ============================================================================
// BANNER PERINGATAN KONEKSI FIREBASE
// ============================================================================
function FirebaseErrorBanner({ error }) {
  if (!error) return null;
  const isAuthError = error.type === 'auth';
  return (
    <div className="fixed top-0 inset-x-0 z-[999] bg-red-600 text-white text-sm font-bold px-4 py-3 shadow-lg">
      <div className="max-w-4xl mx-auto flex items-start gap-3">
        <AlertCircle size={20} className="shrink-0 mt-0.5" />
        <div className="text-left">
          <p>
            {isAuthError
              ? 'Gagal login otomatis ke Firebase (Anonymous Authentication).'
              : 'Gagal terhubung / menyimpan data ke Firestore.'}
          </p>
          <p className="font-normal text-red-100 mt-1">
            {isAuthError
              ? 'Aktifkan di Firebase Console → Authentication → Sign-in method → Anonymous.'
              : 'Pastikan Firestore Database sudah dibuat & Security Rules mengizinkan akses (lihat file firestore.rules), serta Anonymous Authentication sudah aktif.'}
          </p>
          <p className="font-normal text-red-200/80 mt-1 text-xs break-all">Detail: {error.message}</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// KOMPONEN UTAMA (APP)
// ============================================================================
export default function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [firebaseError, setFirebaseError] = useState(null);

  useEffect(() => {
    const styleSheet = document.createElement("style");
    styleSheet.innerText = globalStyles;
    document.head.appendChild(styleSheet);
    
    const params = new URLSearchParams(window.location.search);
    if (params.get('role') === 'student') setRole('student');
  }, []);

  useEffect(() => {
    if (!auth) { setLoading(false); return; }
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Auth Error:", error);
        setFirebaseError({
          type: 'auth',
          message: error?.message || String(error)
        });
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // ==========================================================================
  // TES KONEKSI FIRESTORE "SUNGGUH-SUNGGUH" (BUKAN DARI CACHE LOKAL)
  // --------------------------------------------------------------------------
  // Firestore secara default menampilkan hasil dari cache lokal secara
  // optimis (misalnya lewat onSnapshot) SEBELUM server benar-benar merespons.
  // Ini artinya di perangkat yang PERTAMA KALI membuka & menulis data (biasanya
  // perangkat Pemateri), tampilan bisa terlihat "berhasil" walau permintaan ke
  // server sebenarnya gagal (contoh: project ID salah, Firestore belum dibuat,
  // atau Security Rules menolak). Device lain (Peserta) yang tidak punya cache
  // tsb akan gagal total & tampak seperti "tidak bisa diakses". Untuk
  // menghindari kesalahpahaman itu, kita paksa satu pembacaan LANGSUNG dari
  // server (getDocFromServer) setiap kali user siap, supaya error koneksi
  // yang sesungguhnya selalu terlihat sejak awal, di perangkat siapa pun.
  // ==========================================================================
  useEffect(() => {
    if (!user || !db) return;
    let cancelled = false;

    const verifyRealConnection = async () => {
      try {
        const pingRef = doc(db, 'artifacts', appId, 'public', 'data', '_connectionTest', 'ping');
        await setDoc(pingRef, { lastPingAt: Date.now(), by: user.uid });
        await getDocFromServer(pingRef);
        // Jika berhasil sampai sini, koneksi ke Firestore project benar-benar hidup.
      } catch (error) {
        if (cancelled) return;
        console.error("Tes koneksi Firestore (server) gagal:", error);
        const code = error?.code || '';
        let hint = error?.message || String(error);
        if (code.includes('not-found') || code.includes('unavailable')) {
          hint = 'Firestore project tidak ditemukan/tidak bisa dihubungi. Periksa apakah projectId di konfigurasi Firebase sudah benar dan Firestore Database sudah dibuat di Firebase Console.';
        } else if (code.includes('permission-denied')) {
          hint = 'Akses ditolak oleh Firestore Security Rules. Tempel isi firestore.rules di Firebase Console -> Firestore Database -> Rules, lalu Publish.';
        }
        setFirebaseError({ type: 'firestore', message: hint });
      }
    };
    verifyRealConnection();

    return () => { cancelled = true; };
  }, [user]);

  if (loading || !app) {
    return (
      <div className="flex items-center justify-center min-h-screen animated-bg text-white">
        <div className="text-xl font-bold animate-pulse tracking-widest glass-card px-8 py-4 rounded-full flex items-center gap-3">
          <Hourglass className="animate-spin text-indigo-300" />
          MEMUAT SISTEM KUIS & GAME 5R...
        </div>
      </div>
    );
  }

  if (!role) {
    const currentUrl = window.location.href;
    return (
      <div className="flex flex-col items-center justify-center min-h-screen animated-bg p-6 relative overflow-hidden">
        <FirebaseErrorBanner error={firebaseError} />
        <div className="glass-card p-10 rounded-[2.5rem] w-full max-w-4xl flex flex-col md:flex-row items-center gap-10 relative z-10">
          <div className="flex-1 flex flex-col items-center text-center">
            <div className="glass-card-light p-4 rounded-3xl shadow-2xl mb-4">
              <img src={`https://quickchart.io/qr?text=${encodeURIComponent(currentUrl)}&size=250&margin=1`} alt="QR Code" className="w-56 h-56 rounded-2xl" />
            </div>
            <p className="text-indigo-200 font-medium text-sm flex items-center gap-2 justify-center">
              <Rocket size={16} /> Scan untuk akses cepat
            </p>
          </div>

          <div className="flex-1 text-center md:text-left">
            <h1 className="text-5xl md:text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white to-indigo-200 mb-4 tracking-tight">Kuis & Game 5R AI</h1>
            <p className="text-indigo-100 mb-10 font-medium text-lg">Pilih peran Anda untuk masuk ke arena pembelajaran atau tantangan Game 5R.</p>
            
            <div className="space-y-4">
              <button onClick={() => setRole('teacher')} className="w-full py-4 glass-card hover:bg-white/10 text-white rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-4 transition-all">
                <GraduationCap size={24} className="text-indigo-200" /> Masuk Mode Pemateri
              </button>
              <button onClick={() => setRole('student')} className="w-full py-4 bg-gradient-to-r from-emerald-500/60 to-teal-600/60 hover:from-emerald-500/80 text-white border border-white/30 rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-4 transition-all">
                <Gamepad2 size={24} className="text-emerald-100" /> Masuk Mode Peserta
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen animated-bg font-sans selection:bg-indigo-400 selection:text-white relative">
      <FirebaseErrorBanner error={firebaseError} />
      {role === 'teacher' ? (
        <TeacherAuthWrapper db={db} appId={appId} setRole={setRole} />
      ) : (
        <StudentMode user={user} db={db} appId={appId} setRole={setRole} />
      )}
    </div>
  );
}

// ============================================================================
// AUTH Pemateri VIA SPREADSHEET
// ============================================================================
function TeacherAuthWrapper(props) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // ==========================================================================
  // BANK SOAL & RIWAYAT KUIS (disimpan di database login yang sama,
  // kolom C dst di baris email guru yang bersangkutan)
  // ==========================================================================
  const [teacherEmail, setTeacherEmail] = useState('');
  const [teacherData, setTeacherData] = useState(emptyTeacherData());
  const [teacherDataLoading, setTeacherDataLoading] = useState(false);
  const [teacherDataError, setTeacherDataError] = useState('');
  const sheetStorageReady = isSheetStorageConfigured();

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setAuthError('');

    try {
      const sheetUrl = `https://docs.google.com/spreadsheets/d/1Vumwe7Byj8Ckq3_bFihq267n84kICAN2hsaF6IV7Oy4/gviz/tq?tqx=out:json&gid=0`;
      const response = await fetch(sheetUrl);

      if (!response.ok) throw new Error("Gagal terhubung ke Database.");
      const text = await response.text();
      const jsonString = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const data = JSON.parse(jsonString);
      
      let found = false;
      const inputEmail = email.trim().toLowerCase();
      const rows = data.table.rows;

      for (let i = 0; i < rows.length; i++) {
        const rowData = rows[i].c;
        if (!rowData || rowData.length < 2) continue;
        const colA = rowData[0]?.v;
        const colB = rowData[1]?.v;

        if (colA && colB) {
          if (String(colA).trim().toLowerCase() === inputEmail && String(colB).trim() === password) {
            found = true; break;
          }
        }
      }

      if (found) {
        setTeacherEmail(inputEmail);
        setIsAuthenticated(true);
      } else {
        setAuthError("Email atau Password salah!");
      }
    } catch (err) {
      setAuthError("Koneksi gagal. Pastikan Google Sheet bersifat Publik.");
    }
    setIsLoggingIn(false);
  };

  // Begitu berhasil login, muat Bank Soal & Riwayat Kuis milik guru ini dari
  // spreadsheet (kalau fitur ini sudah dikonfigurasi lewat VITE_SHEETS_API_URL).
  useEffect(() => {
    if (!isAuthenticated || !teacherEmail || !sheetStorageReady) return;
    let cancelled = false;
    setTeacherDataLoading(true);
    setTeacherDataError('');
    loadTeacherData(teacherEmail)
      .then((data) => { if (!cancelled) setTeacherData(data); })
      .catch((err) => {
        if (!cancelled) setTeacherDataError(err?.message || String(err));
      })
      .finally(() => { if (!cancelled) setTeacherDataLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated, teacherEmail, sheetStorageReady]);

  // Simpan perubahan (Bank Soal / Riwayat Kuis) balik ke spreadsheet.
  // Optimistic update: state lokal langsung berubah, lalu menyusul disimpan
  // ke server; kalau gagal, error ditampilkan tapi state lokal tidak ditarik
  // mundur supaya guru tidak kehilangan apa yang baru saja dibuat di layar.
  const persistTeacherData = useCallback(async (nextData) => {
    setTeacherData(nextData);
    if (!sheetStorageReady) return nextData;
    try {
      const saved = await saveTeacherData(teacherEmail, nextData);
      setTeacherDataError('');
      return saved;
    } catch (err) {
      const msg = err?.message || String(err);
      setTeacherDataError(msg);
      throw err;
    }
  }, [teacherEmail, sheetStorageReady]);

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 relative">
        <button onClick={() => props.setRole(null)} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali
        </button>
        <div className="glass-card p-10 rounded-[2.5rem] w-full max-w-md text-center shadow-2xl">
          <Lock size={40} className="mx-auto mb-6 text-white drop-shadow-md" />
          <h2 className="text-3xl font-black text-white mb-2">Otorisasi Pemateri</h2>
          <p className="text-indigo-200 mb-8 font-medium">Autentikasi via Google Sheets</p>
          
          <form onSubmit={handleLogin} className="space-y-5">
            <input type="email" placeholder="Email Pemateri" required value={email} onChange={e => setEmail(e.target.value)} className="w-full p-4 glass-input rounded-2xl" />
            <input type="password" placeholder="Password" required value={password} onChange={e => setPassword(e.target.value)} className="w-full p-4 glass-input rounded-2xl" />
            {authError && <p className="text-red-200 bg-red-900/40 p-4 rounded-2xl text-sm font-bold flex items-center justify-center gap-2"><AlertCircle size={18} /> {authError}</p>}
            <button type="submit" disabled={isLoggingIn} className="w-full py-4 bg-indigo-500 hover:bg-indigo-600 text-white rounded-2xl font-bold flex justify-center items-center gap-2 shadow-xl">
              {isLoggingIn ? "Memverifikasi..." : "Akses Dashboard"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <TeacherMode
      {...props}
      teacherEmail={teacherEmail}
      teacherData={teacherData}
      teacherDataLoading={teacherDataLoading}
      teacherDataError={teacherDataError}
      sheetStorageReady={sheetStorageReady}
      persistTeacherData={persistTeacherData}
    />
  );
}

// ============================================================================
// DASHBOARD Pemateri
// ============================================================================
function TeacherMode({
  db, appId, setRole,
  teacherEmail, teacherData, teacherDataLoading, teacherDataError,
  sheetStorageReady, persistTeacherData
}) {
  // ==========================================================================
  // SESI KUIS MILIK GURU INI SENDIRI (bukan lagi satu sesi global untuk semua
  // guru). `teacherKey` dipakai sebagai ID dokumen "penunjuk" sesi aktif akun
  // ini; `pin` adalah kunci sesi kuis yang sedang ditunjuk (kalau ada), dan
  // dari situ `quizState` + `students` disambungkan ke dokumen/koleksi milik
  // sesi (PIN) tersebut saja — jadi tidak akan tercampur dengan sesi guru lain
  // yang mungkin sedang berjalan bersamaan.
  // ==========================================================================
  const teacherKey = useMemo(() => sanitizeAccountKey(teacherEmail), [teacherEmail]);
  const [pin, setPin] = useState(null);
  const [quizState, setQuizState] = useState(null);
  const [students, setStudents] = useState([]);
  const [sessionError, setSessionError] = useState(null);

  useEffect(() => {
    if (!db || !teacherKey) return;
    const unsub = onSnapshot(teacherSessionPointerRef(teacherKey), (snap) => {
      setPin(snap.exists() ? (snap.data().pin || null) : null);
    }, (error) => {
      console.error("Gagal memuat penunjuk sesi guru:", error);
      setSessionError(error?.message || String(error));
    });
    return () => unsub();
  }, [db, teacherKey]);

  useEffect(() => {
    if (!db || !pin) { setQuizState(null); setStudents([]); return; }
    const unsubState = onSnapshot(quizSessionRef(pin), (snap) => {
      setQuizState(snap.exists() ? snap.data() : null);
    }, (error) => {
      console.error("Firestore quizSession error:", error);
      setSessionError(error?.message || String(error));
    });
    const unsubStudents = onSnapshot(quizSessionStudentsRef(pin), (querySnap) => {
      const studentData = querySnap.docs.map(d => ({ id: d.id, ...d.data() }));
      studentData.sort((a, b) => (b.score || 0) - (a.score || 0));
      setStudents(studentData);
    }, (error) => {
      console.error("Firestore students error:", error);
      setSessionError(error?.message || String(error));
    });
    return () => { unsubState(); unsubStudents(); };
  }, [db, pin]);

  // FUNGSI DOWNLOAD EXCEL / CSV — memakai daftar peserta sesi guru ini sendiri.
  const downloadExcel = () => {
    if (students.length === 0) return alert("Belum ada data peserta untuk diunduh.");
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
    csvContent += "Peringkat,Nama Peserta,Total Poin\n";
    students.forEach((s, idx) => {
      csvContent += `${idx + 1},"${s.name || 'Tanpa Nama'}",${s.score || 0}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Rekap_Nilai_Kuis_5R_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const [newQuestion, setNewQuestion] = useState({ q: '', a: '', b: '', c: '', d: '', answer: 'a', image: '' });
  const [imageUrlDraft, setImageUrlDraft] = useState('');
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [questionsList, setQuestionsList] = useState([]);
  const [quizDuration, setQuizDuration] = useState(15);
  const [isOpeningRoom, setIsOpeningRoom] = useState(false);
  const [quizTitle, setQuizTitle] = useState('');
  const [activeTab, setActiveTab] = useState('setup'); // 'setup' | 'bank' | 'riwayat'
  const [isSavingBank, setIsSavingBank] = useState(false);
  const [isSavingGame5RPreset, setIsSavingGame5RPreset] = useState(false);
  const importInputRef = useRef(null);

  // ==========================================================================
  // PENGATURAN BARU: acak opsi jawaban, tampilkan/sembunyikan label A/B/C/D,
  // dan durasi waktu (kuis pilihan ganda + tiap tahap Game 5R).
  // ==========================================================================
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [showOptionLabels, setShowOptionLabels] = useState(true);
  const [stageDurations, setStageDurations] = useState({ '5r-1': 60, '5r-2': 50, '5r-3': 40 });

  // ==========================================================================
  // GAME "SKD CPNS": bank soal per sub-tes (TWK/TIU/TKP) & durasi per sub-tes
  // (menit). Strukturnya sengaja dipisah dari `questionsList` (soal pilihan
  // ganda biasa) supaya guru bisa menyusun 3 kumpulan soal berbeda sekaligus
  // tanpa saling menimpa satu sama lain.
  // ==========================================================================
  const [skdQuestions, setSkdQuestions] = useState({ twk: [], tiu: [], tkp: [] });
  const [skdDurations, setSkdDurations] = useState({ ...DEFAULT_SKD_DURATIONS });
  const [skdSubtestSelector, setSkdSubtestSelector] = useState('twk');
  const [isSavingSkdBank, setIsSavingSkdBank] = useState({ twk: false, tiu: false, tkp: false });

  useEffect(() => {
    if (quizState?.status === 'active' && quizState.endTime) {
      const timer = setInterval(() => {
        if (Date.now() >= quizState.endTime) endQuizSession(false);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [quizState]);

  const addQuestion = () => {
    if (!newQuestion.q || !newQuestion.a || !newQuestion.b) return alert("Lengkapi kolom soal!");
    setQuestionsList([...questionsList, newQuestion]);
    setNewQuestion({ q: '', a: '', b: '', c: '', d: '', answer: 'a', image: '' });
    setImageUrlDraft('');
  };

  const removeQuestion = (index) => {
    const updated = [...questionsList]; updated.splice(index, 1); setQuestionsList(updated);
  };

  // ==========================================================================
  // SOAL GRAFIS: upload gambar (dikompres otomatis) atau tempel URL gambar
  // ==========================================================================
  const handleQuestionImageFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert("File yang dipilih bukan gambar. Pilih file .jpg, .png, atau .webp.");
      if (e.target) e.target.value = '';
      return;
    }
    setIsProcessingImage(true);
    try {
      const dataUrl = await resizeImageFile(file);
      setNewQuestion(prev => ({ ...prev, image: dataUrl }));
      setImageUrlDraft('');
    } catch (error) {
      console.error("Gagal memproses gambar soal:", error);
      alert("Gagal memproses gambar. Coba file lain atau gunakan URL gambar.");
    } finally {
      setIsProcessingImage(false);
      if (e.target) e.target.value = '';
    }
  };

  const applyImageUrlDraft = () => {
    const url = imageUrlDraft.trim();
    if (!url) return;
    setNewQuestion(prev => ({ ...prev, image: url }));
    setImageUrlDraft('');
  };

  const removeQuestionImage = () => {
    setNewQuestion(prev => ({ ...prev, image: '' }));
    setImageUrlDraft('');
  };

  const explainFirebaseError = (error) => {
    const code = error?.code || '';
    if (code.includes('permission-denied')) {
      return "Akses ditolak oleh Firestore Security Rules.\n\nPerbaikan: buka Firebase Console -> Firestore Database -> Rules, lalu terapkan isi file firestore.rules yang disertakan dalam paket proyek ini, klik Publish.";
    }
    if (code.includes('unauthenticated')) {
      return "Belum berhasil login (Anonymous Authentication).\n\nPerbaikan: buka Firebase Console -> Authentication -> Sign-in method -> aktifkan Anonymous, lalu muat ulang halaman ini.";
    }
    if (code.includes('unavailable') || code.includes('network')) {
      return "Tidak bisa menghubungi server Firestore. Periksa koneksi internet Anda lalu coba lagi.";
    }
    return `Terjadi kendala saat menghubungi Firestore.\n\nDetail teknis: ${error?.message || error}`;
  };

  const openWaitingRoom = async (selectedType = 'standard') => {
    const isGame5R = selectedType.startsWith('5r');
    const isSkd = selectedType.startsWith('skd-');
    const skdKey = isSkd ? selectedType.replace('skd-', '') : null;
    const questionsForSession = selectedType === 'standard'
      ? questionsList
      : isSkd
        ? (skdQuestions[skdKey] || [])
        : [];

    if (selectedType === 'standard' && questionsForSession.length === 0) {
      return alert("Buat minimal 1 soal untuk mode pilihan ganda!");
    }
    if (isSkd && questionsForSession.length === 0) {
      return alert(`Buat atau muat minimal 1 soal ${SKD_META[skdKey]?.label || 'SKD'} dahulu dari Bank Soal!`);
    }

    setIsOpeningRoom(true);
    try {
      // Bersihkan sesi lama MILIK GURU INI SENDIRI saja (kalau ada), supaya
      // membuka ruang baru tidak menyisakan data sesi sebelumnya menumpuk di
      // Firestore — dan yang terpenting, TIDAK menyentuh sesi guru lain yang
      // mungkin sedang berjalan bersamaan.
      if (pin) {
        try { await deleteQuizSession(pin); } catch (cleanupError) {
          console.error("Gagal membersihkan sesi lama:", cleanupError);
        }
      }

      const generatedPin = await generateUniquePin();

      // Untuk Game 5R, "duration" (menit) di sini hanya jaring pengaman di
      // sisi server (Firestore) supaya sesi otomatis ditutup kalau perangkat
      // Pemateri terputus — timer utama yang benar2 dilihat & dipakai peserta
      // adalah hitung mundur per detik di papan permainan (durationSeconds di
      // bawah, sesuai durasi yang diatur langsung di kartu Game 5R). Diberi
      // buffer +1 menit supaya tidak terpotong duluan oleh jaring pengaman ini.
      let durationMins = quizDuration;
      let durationSecondsForStage = null;
      if (isGame5R) {
        durationSecondsForStage = stageDurations[selectedType] || 60;
        durationMins = Math.max(1, Math.ceil(durationSecondsForStage / 60) + 1);
      } else if (isSkd) {
        // SKD tidak pakai hitung mundur per detik seperti Game 5R — memakai
        // durasi per menit (sama seperti Kuis Pilihan Ganda biasa), sesuai
        // alokasi waktu yang diatur langsung di kartu SKD tersebut.
        durationMins = skdDurations[skdKey] || SKD_META[skdKey]?.recommendedMinutes || 30;
      }

      await setDoc(quizSessionRef(generatedPin), {
        status: 'waiting',
        quizType: selectedType,
        title: quizTitle.trim(),
        pin: generatedPin,
        teacherEmail,
        questions: isGame5R ? [] : questionsForSession,
        duration: durationMins,
        durationSeconds: durationSecondsForStage,
        shuffleOptions,
        showOptionLabels,
        startTime: null,
        endTime: null
      });
      // Tunjuk akun guru ini ke sesi (PIN) yang baru dibuat, supaya dashboard
      // otomatis tersambung ke sesi ini lagi walau halaman dimuat ulang.
      await setDoc(teacherSessionPointerRef(teacherKey), { pin: generatedPin, updatedAt: Date.now() });
    } catch (error) {
      console.error("Gagal membuka ruang kuis:", error);
      alert("Ruang kuis gagal dibuka.\n\n" + explainFirebaseError(error));
    } finally {
      setIsOpeningRoom(false);
    }
  };

  const startQuiz = async () => {
    if (!pin) return;
    try {
      const now = Date.now();
      const durationMins = quizState.duration || 15;
      const end = now + (durationMins * 60000);
      await setDoc(quizSessionRef(pin), {
        ...quizState, status: 'active', startTime: now, endTime: end
      });
    } catch (error) {
      console.error("Gagal memulai permainan:", error);
      alert("Gagal memulai permainan.\n\n" + explainFirebaseError(error));
    }
  };

  const endQuizSession = async (isManual = true) => {
    if (isManual && !window.confirm("Akhiri sesi sekarang?")) return;
    if (!pin || !quizState || quizState.status === 'finished') return;
    try {
      const finishedState = { ...quizState, status: 'finished', endTime: Date.now() };
      await setDoc(quizSessionRef(pin), finishedState);
      await saveHistoryRecord(finishedState);
    } catch (error) {
      console.error("Gagal mengakhiri sesi:", error);
      alert("Gagal mengakhiri sesi.\n\n" + explainFirebaseError(error));
    }
  };

  // ==========================================================================
  // RIWAYAT KUIS: setiap sesi yang berakhir (manual maupun waktu habis)
  // otomatis direkap & disimpan ke spreadsheet (kolom C dst di baris email
  // guru ini), supaya bisa dilihat lagi kapan saja lewat tab "Riwayat Kuis".
  // ==========================================================================
  const saveHistoryRecord = async (finishedState) => {
    if (!sheetStorageReady || !teacherEmail) return;
    try {
      const sorted = [...students].sort((a, b) => (b.score || 0) - (a.score || 0));
      const total = sorted.length;
      const avg = total > 0 ? Math.round(sorted.reduce((sum, s) => sum + (s.score || 0), 0) / total) : 0;
      const record = {
        id: `h_${Date.now()}`,
        timestamp: Date.now(),
        judul: (finishedState.title || '').trim() || getQuizTypeName(finishedState.quizType),
        quizType: finishedState.quizType,
        pin: finishedState.pin || '',
        totalPeserta: total,
        rataRata: avg,
        top10: sorted.slice(0, 10).map(s => ({ name: s.name || 'Tanpa Nama', score: s.score || 0 })),
      };
      const next = { ...teacherData, riwayat: [...(teacherData.riwayat || []), record] };
      await persistTeacherData(next);
    } catch (error) {
      // Sengaja tidak pakai alert() supaya tidak mengganggu guru saat
      // mengakhiri sesi; kegagalan sinkron riwayat tetap dicatat di console
      // dan akan terlihat lewat banner "Sinkronisasi gagal" di dashboard.
      console.error("Gagal menyimpan riwayat kuis ke database:", error);
    }
  };

  const kickStudent = async (studentId) => {
    if (!pin) return;
    try {
      await deleteDoc(quizSessionStudentRef(pin, studentId));
    } catch (error) {
      console.error("Gagal mengeluarkan peserta:", error);
      alert("Gagal mengeluarkan peserta.\n\n" + explainFirebaseError(error));
    }
  };

  const resetSetup = async () => {
    try {
      if (pin) {
        try { await deleteQuizSession(pin); } catch (cleanupError) {
          console.error("Gagal menghapus sesi lama:", cleanupError);
        }
      }
      await deleteDoc(teacherSessionPointerRef(teacherKey));
      setQuizTitle('');
    } catch (error) {
      console.error("Gagal kembali ke menu setup:", error);
      alert("Gagal kembali ke menu setup.\n\n" + explainFirebaseError(error));
    }
  };

  // ==========================================================================
  // BANK SOAL: simpan/menuat/hapus kumpulan soal pilihan ganda yang dibuat
  // guru, disimpan ke spreadsheet supaya bisa dipakai lagi lain waktu tanpa
  // mengetik ulang.
  // ==========================================================================
  const saveToBank = async () => {
    if (questionsList.length === 0) return alert("Buat minimal 1 soal dahulu sebelum menyimpan ke Bank Soal.");
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif. Atur Environment Variable VITE_SHEETS_API_URL terlebih dahulu (lihat README.md).");
    setIsSavingBank(true);
    try {
      const record = {
        id: `b_${Date.now()}`,
        type: 'standard',
        judul: quizTitle.trim() || `Bank Soal ${new Date().toLocaleString('id-ID')}`,
        createdAt: Date.now(),
        questions: questionsList,
      };
      const next = { ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] };
      await persistTeacherData(next);
      alert(`Berhasil disimpan ke Bank Soal sebagai "${record.judul}"!`);
    } catch (error) {
      alert("Gagal menyimpan ke Bank Soal.\n\nDetail: " + (error?.message || error));
    } finally {
      setIsSavingBank(false);
    }
  };

  // ==========================================================================
  // GAME 5R JUGA MASUK BANK SOAL: simpan preset pengaturan durasi tiap tahap
  // (bukan "soal" dalam arti pertanyaan, tapi konfigurasi permainan) supaya
  // bisa dipakai lagi lain waktu tanpa mengatur ulang durasi satu-satu.
  // ==========================================================================
  const saveGame5RPresetToBank = async () => {
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif. Atur Environment Variable VITE_SHEETS_API_URL terlebih dahulu (lihat README.md).");
    setIsSavingGame5RPreset(true);
    try {
      const record = {
        id: `g5r_${Date.now()}`,
        type: 'game5r',
        judul: quizTitle.trim() || `Preset Game 5R ${new Date().toLocaleString('id-ID')}`,
        createdAt: Date.now(),
        questions: [],
        stageDurations: { ...stageDurations },
      };
      const next = { ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] };
      await persistTeacherData(next);
      alert(`Berhasil disimpan ke Bank Soal sebagai "${record.judul}"!`);
    } catch (error) {
      alert("Gagal menyimpan preset Game 5R ke Bank Soal.\n\nDetail: " + (error?.message || error));
    } finally {
      setIsSavingGame5RPreset(false);
    }
  };

  // ==========================================================================
  // GAME "SKD CPNS" JUGA MASUK BANK SOAL: setiap sub-tes (TWK/TIU/TKP)
  // disimpan sebagai entri terpisah, lengkap dengan soal & durasinya, supaya
  // bisa dipakai lagi tanpa menyusun ulang dari nol.
  // ==========================================================================
  const saveSkdToBank = async (subtestKey) => {
    const meta = SKD_META[subtestKey];
    const list = skdQuestions[subtestKey] || [];
    if (list.length === 0) return alert(`Buat minimal 1 soal ${meta.label} dahulu sebelum menyimpan ke Bank Soal.`);
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif. Atur Environment Variable VITE_SHEETS_API_URL terlebih dahulu (lihat README.md).");
    setIsSavingSkdBank(prev => ({ ...prev, [subtestKey]: true }));
    try {
      const record = {
        id: `skd_${subtestKey}_${Date.now()}`,
        type: `skd-${subtestKey}`,
        judul: quizTitle.trim() || `Bank Soal SKD ${meta.label} ${new Date().toLocaleString('id-ID')}`,
        createdAt: Date.now(),
        questions: list,
        duration: skdDurations[subtestKey] || meta.recommendedMinutes,
      };
      const next = { ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] };
      await persistTeacherData(next);
      alert(`Berhasil disimpan ke Bank Soal sebagai "${record.judul}"!`);
    } catch (error) {
      alert(`Gagal menyimpan soal ${meta.label} ke Bank Soal.\n\nDetail: ` + (error?.message || error));
    } finally {
      setIsSavingSkdBank(prev => ({ ...prev, [subtestKey]: false }));
    }
  };

  const loadFromBank = (record) => {
    // Semua jenis game tetap berada di tab "Bank Soal" setelah dimuat, karena
    // di sinilah sekarang tempat memilih & membuka semua jenis game (5R, SKD,
    // maupun Kuis Pilihan Ganda) — lihat kartu "Pilih & Buka Game" di atas.
    if (record.type === 'game5r') {
      setStageDurations({
        '5r-1': Number(record.stageDurations?.['5r-1']) || 60,
        '5r-2': Number(record.stageDurations?.['5r-2']) || 50,
        '5r-3': Number(record.stageDurations?.['5r-3']) || 40,
      });
      setQuizTitle(record.judul || '');
      setActiveTab('bank');
      return;
    }
    if (typeof record.type === 'string' && record.type.startsWith('skd-')) {
      const key = record.type.replace('skd-', '');
      if (SKD_META[key]) {
        setSkdQuestions(prev => ({ ...prev, [key]: record.questions || [] }));
        setSkdDurations(prev => ({ ...prev, [key]: Number(record.duration) || SKD_META[key].recommendedMinutes }));
        setSkdSubtestSelector(key);
        setQuizTitle(record.judul || '');
        setActiveTab('bank');
        return;
      }
    }
    setQuestionsList(record.questions || []);
    setQuizTitle(record.judul || '');
    setActiveTab('bank');
  };

  const deleteFromBank = async (id) => {
    if (!window.confirm("Hapus item ini dari Bank Soal?")) return;
    try {
      const next = { ...teacherData, bankSoal: (teacherData.bankSoal || []).filter(b => b.id !== id) };
      await persistTeacherData(next);
    } catch (error) {
      alert("Gagal menghapus dari Bank Soal.\n\nDetail: " + (error?.message || error));
    }
  };

  const deleteHistory = async (id) => {
    if (!window.confirm("Hapus riwayat kuis ini?")) return;
    try {
      const next = { ...teacherData, riwayat: (teacherData.riwayat || []).filter(h => h.id !== id) };
      await persistTeacherData(next);
    } catch (error) {
      alert("Gagal menghapus riwayat.\n\nDetail: " + (error?.message || error));
    }
  };

  // ==========================================================================
  // IMPORT SOAL DARI FILE CSV **atau** EXCEL (.xlsx / .xls)
  // ----------------------------------------------------------------------------
  // Format kolom per baris: pertanyaan, pilihan A, pilihan B, pilihan C,
  // pilihan D, jawaban (a/b/c/d), URL gambar (opsional). Jenis file dideteksi
  // otomatis dari ekstensinya; hasil parsing keduanya disatukan lewat
  // importRowsToQuestions() supaya perilakunya identik.
  // ==========================================================================
  const finishQuestionImport = (rows) => {
    const parsed = importRowsToQuestions(rows);
    if (parsed.length === 0) {
      alert("Tidak ada soal valid ditemukan.\n\nPastikan formatnya sesuai template (klik tombol \"Download Template\"): pertanyaan, pilihan A, pilihan B, pilihan C, pilihan D, jawaban (a/b/c/d), URL gambar (opsional).");
      return;
    }
    setQuestionsList(prev => [...prev, ...parsed]);
    alert(`${parsed.length} soal berhasil diimpor!`);
  };

  const handleQuestionImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          finishQuestionImport(rows);
        } catch (error) {
          console.error("Gagal membaca file Excel:", error);
          alert("Gagal membaca file Excel. Pastikan file berformat .xlsx atau .xls yang valid, atau gunakan template yang disediakan.");
        }
      };
      reader.onerror = () => alert("Gagal membaca file.");
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.csv') || file.type === 'text/csv') {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = String(evt.target?.result || '');
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length === 0) return alert("File CSV kosong.");
        const rows = lines.map(parseCsvLine);
        finishQuestionImport(rows);
      };
      reader.onerror = () => alert("Gagal membaca file.");
      reader.readAsText(file);
    } else {
      alert("Format file tidak didukung. Gunakan file .csv, .xlsx, atau .xls.");
    }

    if (importInputRef.current) importInputRef.current.value = '';
  };

  // ==========================================================================
  // TEMPLATE IMPORT SOAL (.xlsx) — supaya guru tinggal isi format yang sudah
  // benar tanpa perlu menyusun kolom dari nol.
  // ==========================================================================
  const downloadImportTemplate = () => {
    const header = ['Pertanyaan', 'Pilihan A', 'Pilihan B', 'Pilihan C', 'Pilihan D', 'Jawaban (a/b/c/d)', 'URL Gambar (opsional)'];
    const contoh = [
      ['Ibu kota Indonesia adalah...', 'Jakarta', 'Bandung', 'Surabaya', 'Medan', 'a', ''],
      ['Simbol 5R untuk "membuang barang tidak perlu" disebut...', 'Ringkas', 'Rapi', 'Resik', 'Rawat', 'a', 'https://contoh.com/gambar-soal.jpg'],
    ];
    const ws = XLSX.utils.aoa_to_sheet([header, ...contoh]);
    ws['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template Soal');
    XLSX.writeFile(wb, 'Template_Import_Soal_Kuis_5R.xlsx');
  };

  const getQuizTypeName = (type) => {
    if (type === '5r-1') return 'Game 5R Tahap 1 - Ringkas (90 Angka)';
    if (type === '5r-2') return 'Game 5R Tahap 2 - Rapi (49 Angka)';
    if (type === '5r-3') return 'Game 5R Tahap 3 - Rawat (Tabel Urut 7x7)';
    if (type === 'skd-twk') return 'SKD CPNS - Tes Wawasan Kebangsaan (TWK)';
    if (type === 'skd-tiu') return 'SKD CPNS - Tes Intelegensia Umum (TIU)';
    if (type === 'skd-tkp') return 'SKD CPNS - Tes Karakteristik Pribadi (TKP)';
    return 'Kuis Pilihan Ganda';
  };

  const status = quizState?.status || 'setup';

  if (status === 'finished') {
    return <WinnersDashboard students={students} resetSetup={resetSetup} downloadExcel={downloadExcel} />;
  }

  if (status === 'waiting') {
    return (
      <div className="p-8 min-h-screen flex flex-col items-center justify-center text-center relative">
        <button onClick={resetSetup} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali ke Menu Setup
        </button>
        <h2 className="text-4xl font-black mb-2 text-white">Ruang Tunggu</h2>
        <p className="text-emerald-400 font-bold text-xl">{quizState.title || getQuizTypeName(quizState.quizType)}</p>
        {quizState.title && <p className="text-indigo-300 font-medium mb-8 text-sm">{getQuizTypeName(quizState.quizType)}</p>}
        {!quizState.title && <div className="mb-8" />}
        
        <div className="glass-card p-12 rounded-[3rem] border border-white/20 max-w-xl w-full mb-8">
          <div className="text-8xl font-black text-white tracking-widest mb-6">{quizState.pin}</div>
          <div className="text-xl font-bold text-emerald-300 flex items-center justify-center gap-2">
            <Users size={24} /> {students.length} Peserta Bergabung
          </div>
          <div className="flex flex-wrap gap-2 justify-center mt-6 max-h-40 overflow-y-auto">
            {students.map(s => (
              <span key={s.id} className="bg-white/10 px-4 py-2 rounded-full text-sm font-bold text-white flex items-center gap-2">
                {s.name} <button onClick={() => kickStudent(s.id)} className="text-red-400 hover:text-red-200"><X size={14}/></button>
              </span>
            ))}
          </div>
        </div>

        <button onClick={startQuiz} disabled={students.length === 0} className="px-12 py-5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 text-white rounded-2xl font-black text-2xl shadow-2xl disabled:opacity-50 flex items-center gap-3">
          <Play size={28} /> MULAI PERMAINAN
        </button>
      </div>
    );
  }

  if (status === 'active') {
    return (
      <div className="p-8 max-w-6xl mx-auto relative">
        <div className="flex justify-between items-center mb-8 glass-card p-6 rounded-3xl">
          <div>
            <h2 className="text-2xl md:text-3xl font-black text-white flex items-center gap-3">
              <Play className="text-emerald-400 animate-pulse" /> {quizState.title || getQuizTypeName(quizState.quizType)}
            </h2>
            {quizState.title && <p className="text-indigo-300 text-sm font-medium mt-1">{getQuizTypeName(quizState.quizType)}</p>}
          </div>
          <button onClick={() => endQuizSession(true)} className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold flex items-center gap-2">
            <LogOut size={18} /> Akhiri Sesi
          </button>
        </div>

        <div className="glass-card rounded-3xl p-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-white flex items-center gap-2"><Trophy className="text-yellow-400"/> Live Leaderboard</h3>
            <button onClick={downloadExcel} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center gap-2 text-sm">
              <Download size={16} /> Export Excel
            </button>
          </div>
          <div className="space-y-4 max-h-[65vh] overflow-y-auto">
            {students.map((s, idx) => (
              <div key={s.id} className="flex justify-between items-center p-4 bg-white/5 rounded-2xl border border-white/10">
                <div className="flex items-center gap-4">
                  <span className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center font-black">{idx + 1}</span>
                  <div>
                    <h4 className="font-bold text-lg text-white">{s.name}</h4>
                    <p className="text-xs text-indigo-300">
                      {quizState.quizType.startsWith('5r') ? `Angka Ditemukan: ${s.progress || 0}/49` : `Menjawab: ${s.progress || 0}/${quizState.questions.length} soal`}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-black text-emerald-400">{s.score || 0} Pts</div>
                  {s.completed && <span className="text-xs bg-emerald-500/20 text-emerald-300 px-3 py-1 rounded-full font-bold">Selesai</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 relative">
      <div className="flex justify-between items-center flex-wrap gap-4">
        <button onClick={() => setRole(null)} className="glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali ke Pilihan Peran
        </button>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={downloadExcel} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center gap-2 text-sm shadow-lg">
            <Download size={16} /> Download Excel Rekap Nilai
          </button>
          <SyncStatusBadge sheetStorageReady={sheetStorageReady} loading={teacherDataLoading} error={teacherDataError} />
        </div>
      </div>

      {/* NAVIGASI TAB */}
      <div className="glass-card p-2 rounded-2xl flex flex-wrap gap-2">
        <TabButton active={activeTab === 'setup'} onClick={() => setActiveTab('setup')} icon={<Settings2 size={16} />} label="Setup Kuis" />
        <TabButton active={activeTab === 'bank'} onClick={() => setActiveTab('bank')} icon={<Gamepad2 size={16} />} label={`Bank Soal (${(teacherData.bankSoal || []).length})`} />
        <TabButton active={activeTab === 'riwayat'} onClick={() => setActiveTab('riwayat')} icon={<History size={16} />} label={`Riwayat Kuis (${(teacherData.riwayat || []).length})`} />
      </div>

      {activeTab === 'setup' && (
        <div className="space-y-8">
          {/* JUDUL KUIS */}
          <div className="glass-card p-6 rounded-3xl border border-white/20">
            <label className="text-sm font-bold text-indigo-200 mb-2 flex items-center gap-2">
              Judul Sesi Kuis (opsional, akan tersimpan di Riwayat Kuis)
            </label>
            <input
              type="text"
              placeholder='Contoh: "Kuis 5R Kelas 7A - Semester Genap"'
              className="w-full p-4 glass-input rounded-2xl"
              value={quizTitle}
              onChange={e => setQuizTitle(e.target.value)}
            />
          </div>

          {/* PENGATURAN WAKTU & TAMPILAN (khusus Kuis Pilihan Ganda). Durasi
              Game 5R & SKD CPNS TIDAK ditampilkan di sini — masing-masing
              baru muncul langsung di kartunya sendiri saat akan dibuka, lihat
              tab "Bank Soal" -> "Pilih & Buka Game". */}
          <div className="glass-card p-6 md:p-8 rounded-3xl border border-white/20">
            <div className="flex items-center gap-3 mb-6">
              <Settings2 className="text-indigo-300" size={24} />
              <div>
                <h2 className="text-2xl font-extrabold text-white">Pengaturan Waktu &amp; Tampilan</h2>
                <p className="text-indigo-200 text-sm">Atur durasi kuis pilihan ganda dan cara opsi jawaban ditampilkan ke peserta.</p>
              </div>
            </div>

            <div className="max-w-md">
              <h4 className="text-xs font-black text-indigo-300 uppercase tracking-widest mb-3">Kuis Pilihan Ganda</h4>
              <label className="text-xs text-indigo-200 mb-1 block font-bold">Durasi Kuis (menit)</label>
              <input
                type="number" min={1} max={180}
                value={quizDuration}
                onChange={e => setQuizDuration(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-full p-3 glass-input rounded-xl mb-4"
              />
              <div className="space-y-2">
                <ToggleRow
                  icon={<Shuffle size={15} />}
                  label="Acak urutan pilihan jawaban untuk tiap peserta"
                  checked={shuffleOptions}
                  onChange={setShuffleOptions}
                />
                <ToggleRow
                  icon={<Eye size={15} />}
                  label="Tampilkan label A / B / C / D pada pilihan jawaban"
                  checked={showOptionLabels}
                  onChange={setShowOptionLabels}
                />
              </div>
            </div>

            <p className="text-xs text-indigo-300/70 mt-6 flex items-start gap-2 leading-relaxed">
              <Info size={14} className="shrink-0 mt-0.5" />
              Durasi Game 5R (per tahap) dan SKD CPNS (per sub-tes TWK/TIU/TKP) diatur langsung di kartunya masing-masing saat akan dibuka — buka tab <b>"Bank Soal"</b> lalu lihat bagian <b>"Pilih &amp; Buka Game"</b>.
            </p>
          </div>

          {/* KUIS MANUAL PILIHAN GANDA. Catatan: kartu untuk MEMBUKA game
              (Game 5R, SKD CPNS, maupun Kuis Pilihan Ganda ini) semuanya
              sekarang berada di tab "Bank Soal" -> "Pilih & Buka Game", di
              sini hanya tempat menyusun/menyimpan soalnya. */}
          <div className="grid md:grid-cols-2 gap-8">
            <div className="glass-card p-6 rounded-3xl">
              <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                <h3 className="text-xl font-bold text-white">Buat Soal Pilihan Ganda Manual</h3>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={downloadImportTemplate} className="px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 text-indigo-100 text-xs font-bold rounded-xl flex items-center gap-1.5">
                    <FileSpreadsheet size={14} /> Download Template
                  </button>
                  <label className="px-3 py-1.5 bg-indigo-500/30 hover:bg-indigo-500/50 border border-indigo-400/40 text-indigo-100 text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer">
                    <Upload size={14} /> Import Soal
                    <input ref={importInputRef} type="file" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={handleQuestionImport} className="hidden" />
                  </label>
                </div>
              </div>
              <textarea placeholder="Pertanyaan..." className="w-full p-4 glass-input rounded-xl mb-4" value={newQuestion.q} onChange={e => setNewQuestion({...newQuestion, q: e.target.value})} />

              {/* SOAL GRAFIS: upload atau tempel URL gambar */}
              <div className="mb-4">
                <label className="text-xs font-bold text-indigo-200 mb-2 flex items-center gap-1.5">
                  <ImageIcon size={14} /> Gambar Soal (opsional, untuk soal grafis)
                </label>
                {newQuestion.image ? (
                  <div className="relative inline-block">
                    <img src={newQuestion.image} alt="Pratinjau gambar soal" className="max-h-40 rounded-xl border border-white/20 object-contain bg-black/20" />
                    <button type="button" onClick={removeQuestionImage} className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full p-1 shadow-lg">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <label className="flex-1 px-3 py-2.5 glass-input rounded-xl text-xs cursor-pointer flex items-center justify-center gap-2 text-indigo-100 hover:bg-white/10">
                      <Upload size={14} /> {isProcessingImage ? 'Memproses...' : 'Upload Gambar'}
                      <input type="file" accept="image/*" className="hidden" onChange={handleQuestionImageFile} disabled={isProcessingImage} />
                    </label>
                    <input
                      type="text" placeholder="atau tempel URL gambar"
                      className="flex-1 p-2.5 glass-input rounded-xl text-xs"
                      value={imageUrlDraft}
                      onChange={e => setImageUrlDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyImageUrlDraft(); } }}
                      onBlur={applyImageUrlDraft}
                    />
                  </div>
                )}
                <p className="text-[10px] text-indigo-300/60 mt-1.5 leading-relaxed">
                  Gambar yang di-upload otomatis dikompres. Untuk gambar berukuran besar, sebaiknya gunakan URL supaya tidak membebani penyimpanan Bank Soal.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-4">
                {['a', 'b', 'c', 'd'].map(opt => (
                  <input key={opt} type="text" placeholder={`Pilihan ${opt.toUpperCase()}`} className="p-3 glass-input rounded-xl" value={newQuestion[opt]} onChange={e => setNewQuestion({...newQuestion, [opt]: e.target.value})} />
                ))}
              </div>
              <div className="flex justify-between items-center flex-wrap gap-2">
                <select className="p-2 bg-indigo-900 rounded-xl text-white font-bold" value={newQuestion.answer} onChange={e => setNewQuestion({...newQuestion, answer: e.target.value})}>
                  <option value="a">Kunci: A</option><option value="b">Kunci: B</option><option value="c">Kunci: C</option><option value="d">Kunci: D</option>
                </select>
                <button onClick={addQuestion} className="px-6 py-2 bg-indigo-500 text-white font-bold rounded-xl">Tambah Soal</button>
              </div>
              <p className="text-[11px] text-indigo-300/70 mt-3 leading-relaxed">
                Format import (CSV / Excel): <code>pertanyaan, pilihan A, pilihan B, pilihan C, pilihan D, jawaban(a/b/c/d), URL gambar (opsional)</code> — satu soal per baris. Klik "Download Template" untuk contoh siap-isi dalam format Excel (.xlsx).
              </p>
            </div>

            <div className="glass-card p-6 rounded-3xl flex flex-col justify-between">
              <div>
                <h3 className="text-xl font-bold mb-4 text-white">Daftar Soal Biasa ({questionsList.length})</h3>
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {questionsList.map((q, idx) => (
                    <div key={idx} className="p-3 bg-white/5 rounded-xl text-sm font-medium flex justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        {q.image && <ImageIcon size={13} className="text-emerald-300 shrink-0" />}
                        {idx + 1}. {q.q}
                      </span>
                      <button onClick={() => removeQuestion(idx)} className="text-red-400 shrink-0"><X size={16}/></button>
                    </div>
                  ))}
                  {questionsList.length === 0 && <p className="text-indigo-300/60 text-sm text-center py-6">Belum ada soal. Tambah manual atau import soal.</p>}
                </div>
              </div>
              <div className="mt-6 space-y-3">
                <button onClick={saveToBank} disabled={questionsList.length === 0 || isSavingBank} className="w-full py-3 glass-card hover:bg-white/20 disabled:opacity-40 text-white font-bold rounded-2xl flex items-center justify-center gap-2 text-sm">
                  <Save size={16} /> {isSavingBank ? 'Menyimpan...' : 'Simpan ke Bank Soal'}
                </button>
                <button type="button" onClick={() => setActiveTab('bank')} className="w-full py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-2xl flex items-center justify-center gap-2 text-sm">
                  <BookOpen size={16} /> Lanjut ke Bank Soal untuk Membuka Game
                </button>
              </div>
            </div>
          </div>

          {/* BUAT SOAL SKD (TWK / TIU / TKP) — jumlah soal & waktu meniru
              format asli Tes SKD CPNS (110 soal / 100 menit: 30 TWK + 35 TIU
              + 45 TKP). Sama seperti Kuis Pilihan Ganda, soal di sini hanya
              DISUSUN & DISIMPAN di sini; untuk membukanya sebagai game, buka
              tab "Bank Soal". */}
          <div className="glass-card p-6 md:p-8 rounded-3xl border border-white/20">
            <div className="flex items-center gap-3 mb-2">
              <ClipboardList className="text-indigo-300" size={24} />
              <div>
                <h2 className="text-2xl font-extrabold text-white">Buat Soal SKD CPNS</h2>
                <p className="text-indigo-200 text-sm">Susun soal untuk 3 sub-tes SKD: TWK, TIU, dan TKP — masing-masing tersimpan terpisah di Bank Soal.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-4 mb-6">
              {SKD_ORDER.map(key => {
                const meta = SKD_META[key];
                const active = skdSubtestSelector === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSkdSubtestSelector(key)}
                    className={`px-4 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition border ${
                      active ? 'bg-indigo-500 border-indigo-400 text-white shadow-lg' : 'bg-white/5 border-white/10 text-indigo-200 hover:bg-white/10'
                    }`}
                  >
                    <meta.icon size={15} /> {meta.label} <span className="text-[10px] font-normal opacity-70">({(skdQuestions[key] || []).length} soal)</span>
                  </button>
                );
              })}
            </div>

            <SkdQuestionBuilder
              subtestKey={skdSubtestSelector}
              questions={skdQuestions[skdSubtestSelector] || []}
              onAdd={(q) => setSkdQuestions(prev => ({ ...prev, [skdSubtestSelector]: [...(prev[skdSubtestSelector] || []), q] }))}
              onRemove={(idx) => setSkdQuestions(prev => ({ ...prev, [skdSubtestSelector]: (prev[skdSubtestSelector] || []).filter((_, i) => i !== idx) }))}
              onImportRows={(rows) => {
                const parsed = importRowsToQuestions(rows);
                if (parsed.length === 0) {
                  alert("Tidak ada soal valid ditemukan.\n\nPastikan formatnya sesuai template (klik tombol \"Download Template\"): pertanyaan, pilihan A, pilihan B, pilihan C, pilihan D, jawaban (a/b/c/d), URL gambar (opsional).");
                  return;
                }
                setSkdQuestions(prev => ({ ...prev, [skdSubtestSelector]: [...(prev[skdSubtestSelector] || []), ...parsed] }));
                alert(`${parsed.length} soal ${SKD_META[skdSubtestSelector].label} berhasil diimpor.`);
              }}
              onSaveToBank={() => saveSkdToBank(skdSubtestSelector)}
              isSaving={!!isSavingSkdBank[skdSubtestSelector]}
            />
          </div>
        </div>
      )}

      {activeTab === 'bank' && (
        <BankSoalPanel
          bankSoal={teacherData.bankSoal || []}
          loading={teacherDataLoading}
          sheetStorageReady={sheetStorageReady}
          onLoad={loadFromBank}
          onDelete={deleteFromBank}
          onOpenGame={openWaitingRoom}
          isOpeningRoom={isOpeningRoom}
          questionsList={questionsList}
          stageDurations={stageDurations}
          setStageDurations={setStageDurations}
          onSaveGame5RPreset={saveGame5RPresetToBank}
          isSavingGame5RPreset={isSavingGame5RPreset}
          skdQuestions={skdQuestions}
          skdDurations={skdDurations}
          setSkdDurations={setSkdDurations}
        />
      )}

      {activeTab === 'riwayat' && (
        <RiwayatPanel
          riwayat={teacherData.riwayat || []}
          loading={teacherDataLoading}
          sheetStorageReady={sheetStorageReady}
          onDelete={deleteHistory}
        />
      )}
    </div>
  );
}

// ============================================================================
// CONTOH SOAL TEMPLATE SKD (untuk tombol "Download Template" per sub-tes).
// Contoh orisinal buatan sendiri yang meniru gaya soal TWK/TIU/TKP resmi,
// BUKAN kutipan dari bank soal CPNS resmi mana pun — hanya sebagai contoh
// format yang siap-isi bagi Pemateri.
// ============================================================================
const SKD_TEMPLATE_EXAMPLES = {
  twk: [
    ['Sila keempat Pancasila menekankan pengambilan keputusan melalui musyawarah untuk mencapai...', 'Mufakat', 'Keuntungan pribadi golongan', 'Suara terbanyak tanpa diskusi', 'Keputusan pemimpin semata', 'a', ''],
    ['Semboyan "Bhinneka Tunggal Ika" yang menjadi dasar semangat persatuan bangsa Indonesia berasal dari kitab...', 'Sutasoma', 'Negarakertagama', 'Pararaton', 'Arjunawiwaha', 'a', ''],
  ],
  tiu: [
    ['Jika 3 pekerja dapat menyelesaikan sebuah proyek dalam 12 hari, berapa hari yang dibutuhkan 6 pekerja untuk menyelesaikan proyek yang sama (asumsi kecepatan kerja sama)?', '6 hari', '4 hari', '8 hari', '12 hari', 'a', ''],
    ['PADI : BERAS = ... : TEPUNG', 'Gandum', 'Jagung', 'Nasi', 'Sawah', 'a', ''],
  ],
  tkp: [
    ['Atasan Anda memberikan tugas mendadak yang harus selesai hari ini, padahal Anda sudah memiliki agenda lain. Sikap paling tepat adalah...', 'Mengatur ulang prioritas dan tetap menyelesaikan tugas atasan tepat waktu', 'Menolak karena sudah ada agenda lain', 'Mengerjakan sekenanya agar cepat selesai', 'Meminta rekan kerja mengerjakan seluruhnya', 'a', ''],
    ['Saat menemukan rekan kerja melakukan kesalahan dalam laporan, tindakan paling profesional adalah...', 'Memberitahu secara langsung dan membantu memperbaikinya', 'Membiarkan saja karena bukan tanggung jawab Anda', 'Melaporkan ke atasan tanpa memberi tahu rekan tersebut', 'Menyebarkan ke rekan lain sebagai bahan pembicaraan', 'a', ''],
  ],
};

// ============================================================================
// BUILDER SOAL SKD — dipakai bergantian untuk TWK / TIU / TKP (ditentukan
// lewat prop `subtestKey`). Struktur formulirnya sengaja disamakan persis
// dengan builder "Soal Pilihan Ganda Manual" (pertanyaan, gambar opsional,
// opsi A-D, kunci jawaban, import CSV/Excel) supaya Pemateri tidak perlu
// mempelajari alur baru — bedanya hanya kumpulan soal & templatenya
// mengikuti sub-tes yang sedang dipilih.
// ============================================================================
function SkdQuestionBuilder({ subtestKey, questions, onAdd, onRemove, onImportRows, onSaveToBank, isSaving }) {
  const meta = SKD_META[subtestKey];
  const [draft, setDraft] = useState({ q: '', a: '', b: '', c: '', d: '', answer: 'a', image: '' });
  const [imageUrlDraft, setImageUrlDraft] = useState('');
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const importInputRef = useRef(null);

  // Reset draft form setiap kali Pemateri berpindah sub-tes (TWK/TIU/TKP)
  // supaya soal yang sedang diketik tidak "bocor" tertukar ke sub-tes lain.
  useEffect(() => {
    setDraft({ q: '', a: '', b: '', c: '', d: '', answer: 'a', image: '' });
    setImageUrlDraft('');
  }, [subtestKey]);

  const handleAdd = () => {
    if (!draft.q || !draft.a || !draft.b) return alert("Lengkapi kolom soal!");
    onAdd(draft);
    setDraft({ q: '', a: '', b: '', c: '', d: '', answer: 'a', image: '' });
    setImageUrlDraft('');
  };

  const handleImageFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert("File yang dipilih bukan gambar. Pilih file .jpg, .png, atau .webp.");
      if (e.target) e.target.value = '';
      return;
    }
    setIsProcessingImage(true);
    try {
      const dataUrl = await resizeImageFile(file);
      setDraft(prev => ({ ...prev, image: dataUrl }));
      setImageUrlDraft('');
    } catch (error) {
      console.error("Gagal memproses gambar soal SKD:", error);
      alert("Gagal memproses gambar. Coba file lain atau gunakan URL gambar.");
    } finally {
      setIsProcessingImage(false);
      if (e.target) e.target.value = '';
    }
  };

  const applyImageUrlDraft = () => {
    const url = imageUrlDraft.trim();
    if (!url) return;
    setDraft(prev => ({ ...prev, image: url }));
    setImageUrlDraft('');
  };

  const removeImage = () => {
    setDraft(prev => ({ ...prev, image: '' }));
    setImageUrlDraft('');
  };

  const downloadTemplate = () => {
    const header = ['Pertanyaan', 'Pilihan A', 'Pilihan B', 'Pilihan C', 'Pilihan D', 'Jawaban (a/b/c/d)', 'URL Gambar (opsional)'];
    const contoh = SKD_TEMPLATE_EXAMPLES[subtestKey] || [];
    const ws = XLSX.utils.aoa_to_sheet([header, ...contoh]);
    ws['!cols'] = [{ wch: 50 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Template ${meta.label}`);
    XLSX.writeFile(wb, `Template_Import_Soal_SKD_${meta.label}.xlsx`);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          onImportRows(rows);
        } catch (error) {
          console.error("Gagal membaca file Excel:", error);
          alert("Gagal membaca file Excel. Pastikan file berformat .xlsx atau .xls yang valid, atau gunakan template yang disediakan.");
        }
      };
      reader.onerror = () => alert("Gagal membaca file.");
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.csv') || file.type === 'text/csv') {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = String(evt.target?.result || '');
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length === 0) return alert("File CSV kosong.");
        const rows = lines.map(parseCsvLine);
        onImportRows(rows);
      };
      reader.onerror = () => alert("Gagal membaca file.");
      reader.readAsText(file);
    } else {
      alert("Format file tidak didukung. Gunakan file .csv, .xlsx, atau .xls.");
    }

    if (importInputRef.current) importInputRef.current.value = '';
  };

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <p className="text-xs font-black text-indigo-300 uppercase tracking-widest">{meta.nama} ({meta.label})</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={downloadTemplate} className="px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 text-indigo-100 text-xs font-bold rounded-xl flex items-center gap-1.5">
              <FileSpreadsheet size={14} /> Download Template
            </button>
            <label className="px-3 py-1.5 bg-indigo-500/30 hover:bg-indigo-500/50 border border-indigo-400/40 text-indigo-100 text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer">
              <Upload size={14} /> Import Soal
              <input ref={importInputRef} type="file" accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={handleImport} className="hidden" />
            </label>
          </div>
        </div>
        <p className="text-[11px] text-indigo-300/70 mb-3 leading-relaxed">
          {meta.deskripsi} Rekomendasi jumlah soal (format asli SKD CPNS): <b>{meta.recommendedCount} soal</b>. Saat ini tersusun <b>{questions.length} soal</b>.
        </p>

        <textarea placeholder={`Pertanyaan ${meta.label}...`} className="w-full p-4 glass-input rounded-xl mb-4" value={draft.q} onChange={e => setDraft({ ...draft, q: e.target.value })} />

        <div className="mb-4">
          <label className="text-xs font-bold text-indigo-200 mb-2 flex items-center gap-1.5">
            <ImageIcon size={14} /> Gambar Soal (opsional)
          </label>
          {draft.image ? (
            <div className="relative inline-block">
              <img src={draft.image} alt="Pratinjau gambar soal" className="max-h-40 rounded-xl border border-white/20 object-contain bg-black/20" />
              <button type="button" onClick={removeImage} className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full p-1 shadow-lg">
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              <label className="flex-1 px-3 py-2.5 glass-input rounded-xl text-xs cursor-pointer flex items-center justify-center gap-2 text-indigo-100 hover:bg-white/10">
                <Upload size={14} /> {isProcessingImage ? 'Memproses...' : 'Upload Gambar'}
                <input type="file" accept="image/*" className="hidden" onChange={handleImageFile} disabled={isProcessingImage} />
              </label>
              <input
                type="text" placeholder="atau tempel URL gambar"
                className="flex-1 p-2.5 glass-input rounded-xl text-xs"
                value={imageUrlDraft}
                onChange={e => setImageUrlDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyImageUrlDraft(); } }}
                onBlur={applyImageUrlDraft}
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          {['a', 'b', 'c', 'd'].map(opt => (
            <input key={opt} type="text" placeholder={`Pilihan ${opt.toUpperCase()}`} className="p-3 glass-input rounded-xl" value={draft[opt]} onChange={e => setDraft({ ...draft, [opt]: e.target.value })} />
          ))}
        </div>
        <div className="flex justify-between items-center flex-wrap gap-2">
          <select className="p-2 bg-indigo-900 rounded-xl text-white font-bold" value={draft.answer} onChange={e => setDraft({ ...draft, answer: e.target.value })}>
            <option value="a">Kunci: A</option><option value="b">Kunci: B</option><option value="c">Kunci: C</option><option value="d">Kunci: D</option>
          </select>
          <button onClick={handleAdd} className="px-6 py-2 bg-indigo-500 text-white font-bold rounded-xl">Tambah Soal</button>
        </div>
        <p className="text-[11px] text-indigo-300/70 mt-3 leading-relaxed">
          Format import (CSV / Excel): <code>pertanyaan, pilihan A, pilihan B, pilihan C, pilihan D, jawaban(a/b/c/d), URL gambar (opsional)</code> — satu soal per baris.
        </p>
      </div>

      <div className="glass-card p-6 rounded-3xl flex flex-col justify-between">
        <div>
          <h3 className="text-xl font-bold mb-4 text-white">Daftar Soal {meta.label} ({questions.length})</h3>
          <div className="max-h-48 overflow-y-auto space-y-2">
            {questions.map((q, idx) => (
              <div key={idx} className="p-3 bg-white/5 rounded-xl text-sm font-medium flex justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  {q.image && <ImageIcon size={13} className="text-emerald-300 shrink-0" />}
                  {idx + 1}. {q.q}
                </span>
                <button onClick={() => onRemove(idx)} className="text-red-400 shrink-0"><X size={16}/></button>
              </div>
            ))}
            {questions.length === 0 && <p className="text-indigo-300/60 text-sm text-center py-6">Belum ada soal {meta.label}. Tambah manual atau import soal.</p>}
          </div>
        </div>
        <div className="mt-6 space-y-3">
          <button onClick={onSaveToBank} disabled={questions.length === 0 || isSaving} className="w-full py-3 glass-card hover:bg-white/20 disabled:opacity-40 text-white font-bold rounded-2xl flex items-center justify-center gap-2 text-sm">
            <Save size={16} /> {isSaving ? 'Menyimpan...' : `Simpan Soal ${meta.label} ke Bank Soal`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// KOMPONEN KECIL: BARIS TOGGLE ON/OFF (untuk Pengaturan Waktu & Tampilan)
// ============================================================================
function ToggleRow({ icon, label, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-full flex items-center justify-between gap-3 p-3 rounded-xl border transition text-left ${
        checked ? 'bg-indigo-500/20 border-indigo-400/40' : 'bg-white/5 border-white/10'
      }`}
    >
      <span className="text-xs font-bold text-indigo-100 flex items-center gap-2">{icon}{label}</span>
      {checked ? (
        <ToggleRight size={26} className="text-emerald-400 shrink-0" />
      ) : (
        <ToggleLeft size={26} className="text-indigo-300/50 shrink-0" />
      )}
    </button>
  );
}

// ============================================================================
// KOMPONEN KECIL: TOMBOL TAB & BADGE STATUS SINKRONISASI
// ============================================================================
function TabButton({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition ${
        active ? 'bg-indigo-500 text-white shadow-lg' : 'text-indigo-200 hover:bg-white/10'
      }`}
    >
      {icon} {label}
    </button>
  );
}

function SyncStatusBadge({ sheetStorageReady, loading, error }) {
  if (!sheetStorageReady) {
    return (
      <span className="text-xs font-bold px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-200 flex items-center gap-2">
        <AlertCircle size={14} /> Bank Soal & Riwayat belum aktif (VITE_SHEETS_API_URL belum diatur)
      </span>
    );
  }
  if (loading) {
    return (
      <span className="text-xs font-bold px-3 py-2 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-200 flex items-center gap-2">
        <RefreshCw size={14} className="animate-spin" /> Menyinkronkan dengan database...
      </span>
    );
  }
  if (error) {
    return (
      <span title={error} className="text-xs font-bold px-3 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 flex items-center gap-2 max-w-xs truncate">
        <AlertCircle size={14} className="shrink-0" /> Sinkronisasi gagal: {error}
      </span>
    );
  }
  return (
    <span className="text-xs font-bold px-3 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 flex items-center gap-2">
      <CheckCircle2 size={14} /> Tersinkron ke database
    </span>
  );
}

// ============================================================================
// KONFIGURASI TAMPILAN KARTU GAME 5R & AKSEN WARNA SKD (dipakai oleh
// GameLauncherPanel di bawah)
// ============================================================================
const STAGE_5R_CARDS = [
  { type: '5r-1', label: 'TAHAP 1', title: 'RINGKAS', desc: 'Ada 90 angka acak. Cari urut 1–49.', badge: 'bg-amber-500 text-black', card: 'bg-amber-500/10 border-amber-500/30', btn: 'bg-amber-500 hover:bg-amber-400 text-black', icon: Layers },
  { type: '5r-2', label: 'TAHAP 2', title: 'RAPI', desc: 'Tersisa tepat 49 angka acak target.', badge: 'bg-purple-500 text-white', card: 'bg-purple-500/10 border-purple-500/30', btn: 'bg-purple-600 hover:bg-purple-500 text-white', icon: Grid },
  { type: '5r-3', label: 'TAHAP 3', title: 'RAWAT', desc: '49 angka berurutan (Tabel 7x7), font acak.', badge: 'bg-rose-500 text-white', card: 'bg-rose-500/10 border-rose-500/30', btn: 'bg-rose-600 hover:bg-rose-500 text-white', icon: Table },
];
const SKD_ACCENTS = {
  sky: { badge: 'bg-sky-500 text-white', card: 'bg-sky-500/10 border-sky-500/30', btn: 'bg-sky-600 hover:bg-sky-500 text-white' },
  violet: { badge: 'bg-violet-500 text-white', card: 'bg-violet-500/10 border-violet-500/30', btn: 'bg-violet-600 hover:bg-violet-500 text-white' },
  amber: { badge: 'bg-amber-500 text-black', card: 'bg-amber-500/10 border-amber-500/30', btn: 'bg-amber-500 hover:bg-amber-400 text-black' },
};

// ============================================================================
// TAB: BANK SOAL — sekaligus jadi pusat "Pilih & Buka Game". Semua jenis
// game (Game 5R, SKD CPNS, Kuis Pilihan Ganda) dipilih & dibuka dari sini;
// durasi Game 5R (per detik) dan SKD (per menit) HANYA muncul di kartunya
// masing-masing di bagian ini, tepat saat game tersebut akan dibuka.
// ============================================================================
function BankSoalPanel({
  bankSoal, loading, sheetStorageReady, onLoad, onDelete,
  onOpenGame, isOpeningRoom,
  questionsList,
  stageDurations, setStageDurations, onSaveGame5RPreset, isSavingGame5RPreset,
  skdQuestions, skdDurations, setSkdDurations,
}) {
  const sorted = [...bankSoal].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return (
    <div className="space-y-6">
      {/* PILIH & BUKA GAME */}
      <div className="glass-card p-6 md:p-8 rounded-3xl border border-white/20">
        <div className="flex items-center gap-3 mb-2">
          <Gamepad2 className="text-indigo-300" size={24} />
          <div>
            <h2 className="text-2xl font-extrabold text-white">Pilih &amp; Buka Game</h2>
            <p className="text-indigo-200 text-sm">Game 5R, SKD CPNS, dan Kuis Pilihan Ganda — semuanya dipilih & dibuka dari sini. Durasi tiap game diatur langsung di kartunya.</p>
          </div>
        </div>

        {/* GAME 5R */}
        <h4 className="text-xs font-black text-indigo-300 uppercase tracking-widest mt-6 mb-3">Game 5R</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {STAGE_5R_CARDS.map(stage => {
            const Icon = stage.icon;
            return (
              <div key={stage.type} className={`p-5 border rounded-2xl flex flex-col justify-between ${stage.card}`}>
                <div className="mb-4">
                  <span className={`font-black text-xs px-2.5 py-1 rounded-md ${stage.badge}`}>{stage.label}</span>
                  <h3 className="text-xl font-black text-white mt-2">{stage.title}</h3>
                  <p className="text-xs text-white/70 mt-1 leading-relaxed">{stage.desc}</p>
                  <div className="flex items-center justify-between gap-2 mt-3">
                    <label className="text-[11px] font-bold text-white/80 flex items-center gap-1"><Timer size={12} /> Durasi (detik)</label>
                    <input
                      type="number" min={5} max={600}
                      value={stageDurations[stage.type]}
                      onChange={e => setStageDurations(prev => ({ ...prev, [stage.type]: Math.max(5, parseInt(e.target.value, 10) || 5) }))}
                      className="w-20 p-1.5 glass-input rounded-lg text-center text-sm"
                    />
                  </div>
                </div>
                <button onClick={() => onOpenGame(stage.type)} disabled={isOpeningRoom} className={`w-full py-3 disabled:opacity-50 font-black rounded-xl text-sm flex items-center justify-center gap-2 shadow ${stage.btn}`}>
                  <Icon size={16} /> {isOpeningRoom ? 'Membuka...' : `Buka ${stage.label}`}
                </button>
              </div>
            );
          })}
        </div>
        <button
          onClick={onSaveGame5RPreset}
          disabled={isSavingGame5RPreset}
          className="mt-3 px-4 py-2 glass-card hover:bg-white/20 disabled:opacity-40 text-white font-bold rounded-xl flex items-center gap-2 text-xs"
        >
          <Save size={14} /> {isSavingGame5RPreset ? 'Menyimpan...' : 'Simpan Pengaturan Durasi Game 5R ke Bank Soal'}
        </button>

        {/* SKD CPNS */}
        <h4 className="text-xs font-black text-indigo-300 uppercase tracking-widest mt-8 mb-3">SKD CPNS (Seleksi Kompetensi Dasar)</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {SKD_ORDER.map(key => {
            const meta = SKD_META[key];
            const Icon = meta.icon;
            const accent = SKD_ACCENTS[meta.accent];
            const count = (skdQuestions?.[key] || []).length;
            return (
              <div key={key} className={`p-5 border rounded-2xl flex flex-col justify-between ${accent.card}`}>
                <div className="mb-4">
                  <span className={`font-black text-xs px-2.5 py-1 rounded-md ${accent.badge}`}>{meta.label}</span>
                  <h3 className="text-lg font-black text-white mt-2">{meta.nama}</h3>
                  <p className="text-xs text-white/70 mt-1 leading-relaxed">{meta.deskripsi}</p>
                  <p className="text-xs text-white/90 font-bold mt-2">{count} soal tersusun <span className="font-normal text-white/60">(rekomendasi {meta.recommendedCount})</span></p>
                  <div className="flex items-center justify-between gap-2 mt-3">
                    <label className="text-[11px] font-bold text-white/80 flex items-center gap-1"><Timer size={12} /> Durasi (menit)</label>
                    <input
                      type="number" min={1} max={180}
                      value={skdDurations[key]}
                      onChange={e => setSkdDurations(prev => ({ ...prev, [key]: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                      className="w-20 p-1.5 glass-input rounded-lg text-center text-sm"
                    />
                  </div>
                </div>
                <button onClick={() => onOpenGame(meta.quizType)} disabled={isOpeningRoom || count === 0} className={`w-full py-3 disabled:opacity-50 font-black rounded-xl text-sm flex items-center justify-center gap-2 shadow ${accent.btn}`}>
                  <Icon size={16} /> {isOpeningRoom ? 'Membuka...' : `Buka ${meta.label}`}
                </button>
                {count === 0 && <p className="text-[10px] text-white/50 mt-2 text-center">Susun soal {meta.label} dulu di tab "Setup Kuis".</p>}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-indigo-300/70 mt-3 leading-relaxed flex items-start gap-1.5">
          <Info size={13} className="shrink-0 mt-0.5" /> Format resmi Tes SKD CPNS: 30 soal TWK + 35 soal TIU + 45 soal TKP = 110 soal dalam 100 menit. Jumlah soal & durasi di atas bisa disesuaikan bebas.
        </p>

        {/* KUIS PILIHAN GANDA */}
        <h4 className="text-xs font-black text-indigo-300 uppercase tracking-widest mt-8 mb-3">Kuis Pilihan Ganda</h4>
        <div className="p-5 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-black text-white">Kuis Pilihan Ganda Standar</h3>
            <p className="text-xs text-emerald-100/80 mt-1">{questionsList.length} soal siap dimainkan. Durasi &amp; tampilan diatur di tab "Setup Kuis" &rarr; "Pengaturan Waktu &amp; Tampilan".</p>
          </div>
          <button onClick={() => onOpenGame('standard')} disabled={isOpeningRoom || questionsList.length === 0} className="px-6 py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-black rounded-xl text-sm flex items-center justify-center gap-2 shadow shrink-0">
            <Play size={16} /> {isOpeningRoom ? 'Membuka...' : 'Buka Kuis Pilihan Ganda'}
          </button>
        </div>
      </div>

      {/* BANK SOAL TERSIMPAN */}
      <div className="glass-card p-6 md:p-8 rounded-3xl border border-white/20">
        <div className="flex items-center gap-3 mb-2">
          <BookOpen className="text-indigo-300" size={24} />
          <h2 className="text-2xl font-extrabold text-white">Bank Soal Tersimpan</h2>
        </div>
        <p className="text-indigo-200 text-sm mb-6">
          Kumpulan soal (Pilihan Ganda maupun SKD) dan preset durasi Game 5R yang pernah disimpan, siap dimuat kembali kapan saja tanpa menyusun ulang dari nol.
        </p>

        {!sheetStorageReady && (
          <p className="text-amber-200 bg-amber-900/30 border border-amber-500/30 p-4 rounded-2xl text-sm mb-6">
            Fitur ini butuh Environment Variable <code>VITE_SHEETS_API_URL</code> (lihat README.md bagian "Setup Google Apps Script").
          </p>
        )}
        {loading && <p className="text-indigo-300 text-sm mb-4 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Memuat Bank Soal...</p>}

        {!loading && sorted.length === 0 && (
          <p className="text-indigo-300/60 text-sm text-center py-10">Belum ada Bank Soal tersimpan. Susun soal Pilihan Ganda / SKD di tab "Setup Kuis", atau simpan pengaturan durasi Game 5R di kartu di atas.</p>
        )}

        <div className="space-y-3">
          {sorted.map(set => {
            const isGame5R = set.type === 'game5r';
            const isSkd = typeof set.type === 'string' && set.type.startsWith('skd-');
            const skdKey = isSkd ? set.type.replace('skd-', '') : null;
            const skdMetaForSet = isSkd ? SKD_META[skdKey] : null;
            const badgeLabel = isGame5R ? 'Game 5R' : isSkd ? `SKD · ${skdMetaForSet?.label || skdKey}` : 'Pilihan Ganda';
            const badgeClass = isGame5R ? 'bg-rose-500/30 text-rose-200' : isSkd ? 'bg-sky-500/30 text-sky-200' : 'bg-indigo-500/30 text-indigo-200';
            const loadLabel = isGame5R ? 'Muat Pengaturan' : isSkd ? `Muat Soal ${skdMetaForSet?.label || ''}` : 'Muat ke Kuis';
            return (
              <div key={set.id} className="p-4 bg-white/5 rounded-2xl border border-white/10 flex flex-wrap justify-between items-center gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md ${badgeClass}`}>
                      {badgeLabel}
                    </span>
                    <h4 className="font-bold text-white">{set.judul}</h4>
                  </div>
                  {isGame5R ? (
                    <p className="text-xs text-indigo-300">
                      Tahap 1: {set.stageDurations?.['5r-1'] ?? 60}s &middot; Tahap 2: {set.stageDurations?.['5r-2'] ?? 50}s &middot; Tahap 3: {set.stageDurations?.['5r-3'] ?? 40}s &middot; disimpan {formatTanggal(set.createdAt)}
                    </p>
                  ) : isSkd ? (
                    <p className="text-xs text-indigo-300">
                      {(set.questions || []).length} soal &middot; durasi {set.duration ?? skdMetaForSet?.recommendedMinutes} menit &middot; disimpan {formatTanggal(set.createdAt)}
                    </p>
                  ) : (
                    <p className="text-xs text-indigo-300">{(set.questions || []).length} soal &middot; disimpan {formatTanggal(set.createdAt)}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => onLoad(set)} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-xl text-sm flex items-center gap-1.5">
                    <PlusCircle size={14} /> {loadLabel}
                  </button>
                  <button onClick={() => onDelete(set.id)} className="px-3 py-2 bg-red-500/20 hover:bg-red-500/40 text-red-200 font-bold rounded-xl text-sm">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TAB: RIWAYAT KUIS
// ============================================================================
function RiwayatPanel({ riwayat, loading, sheetStorageReady, onDelete }) {
  const [expandedId, setExpandedId] = useState(null);
  const sorted = [...riwayat].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const downloadHistoryCsv = (record) => {
    let csv = "data:text/csv;charset=utf-8,\uFEFF";
    csv += `Riwayat Kuis: ${record.judul}\nTanggal:,${formatTanggal(record.timestamp)}\nPIN:,${record.pin}\nTotal Peserta:,${record.totalPeserta}\nRata-rata Skor:,${record.rataRata}\n\n`;
    csv += "Peringkat,Nama Peserta,Skor\n";
    (record.top10 || []).forEach((s, idx) => { csv += `${idx + 1},"${s.name}",${s.score}\n`; });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csv));
    link.setAttribute("download", `Riwayat_${record.judul.replace(/[^a-z0-9]+/gi, '_')}_${new Date(record.timestamp).toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const downloadAllHistoryCsv = () => {
    if (sorted.length === 0) return alert("Belum ada riwayat untuk diunduh.");
    let csv = "data:text/csv;charset=utf-8,\uFEFF";
    csv += "Tanggal,Judul Kuis,Jenis,PIN,Total Peserta,Rata-rata Skor,Juara 1,Skor Juara 1\n";
    sorted.forEach(r => {
      const juara = r.top10?.[0];
      csv += `"${formatTanggal(r.timestamp)}","${r.judul}","${r.quizType}",${r.pin},${r.totalPeserta},${r.rataRata},"${juara?.name || '-'}",${juara?.score || 0}\n`;
    });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csv));
    link.setAttribute("download", `Riwayat_Semua_Kuis_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  return (
    <div className="glass-card p-6 md:p-8 rounded-3xl border border-white/20">
      <div className="flex justify-between items-start flex-wrap gap-4 mb-2">
        <div className="flex items-center gap-3">
          <History className="text-indigo-300" size={24} />
          <h2 className="text-2xl font-extrabold text-white">Riwayat Kuis</h2>
        </div>
        <button onClick={downloadAllHistoryCsv} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center gap-2 text-sm">
          <Download size={16} /> Export Semua Riwayat
        </button>
      </div>
      <p className="text-indigo-200 text-sm mb-6">
        Setiap sesi yang diakhiri otomatis tersimpan di sini, lengkap dengan papan peringkat top 10.
      </p>

      {!sheetStorageReady && (
        <p className="text-amber-200 bg-amber-900/30 border border-amber-500/30 p-4 rounded-2xl text-sm mb-6">
          Fitur ini butuh Environment Variable <code>VITE_SHEETS_API_URL</code> (lihat README.md bagian "Setup Google Apps Script").
        </p>
      )}
      {loading && <p className="text-indigo-300 text-sm mb-4 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Memuat Riwayat Kuis...</p>}

      {!loading && sorted.length === 0 && (
        <p className="text-indigo-300/60 text-sm text-center py-10">Belum ada riwayat. Riwayat akan muncul otomatis setelah sebuah sesi kuis/game diakhiri.</p>
      )}

      <div className="space-y-3">
        {sorted.map(record => {
          const isOpen = expandedId === record.id;
          return (
            <div key={record.id} className="bg-white/5 rounded-2xl border border-white/10 overflow-hidden">
              <button onClick={() => setExpandedId(isOpen ? null : record.id)} className="w-full p-4 flex flex-wrap justify-between items-center gap-3 text-left hover:bg-white/5">
                <div>
                  <h4 className="font-bold text-white">{record.judul}</h4>
                  <p className="text-xs text-indigo-300">{formatTanggal(record.timestamp)} &middot; PIN {record.pin}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xs text-indigo-300 flex items-center gap-1 justify-end"><Users size={12} /> {record.totalPeserta} peserta</p>
                    <p className="text-sm font-black text-emerald-400 flex items-center gap-1 justify-end"><BarChart3 size={12} /> Rata-rata {record.rataRata} Pts</p>
                  </div>
                  {isOpen ? <ChevronUp size={18} className="text-indigo-300" /> : <ChevronDown size={18} className="text-indigo-300" />}
                </div>
              </button>
              {isOpen && (
                <div className="p-4 border-t border-white/10 space-y-3">
                  <div className="space-y-1.5">
                    {(record.top10 || []).map((s, idx) => (
                      <div key={idx} className={`flex justify-between items-center px-3 py-2 rounded-xl text-sm font-bold ${idx === 0 ? 'bg-yellow-500/15 text-yellow-300' : 'bg-white/5 text-white'}`}>
                        <span>#{idx + 1} {s.name}</span>
                        <span>{s.score} Pts</span>
                      </div>
                    ))}
                    {(record.top10 || []).length === 0 && <p className="text-indigo-300/60 text-sm">Tidak ada peserta di sesi ini.</p>}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button onClick={() => downloadHistoryCsv(record)} className="px-4 py-2 bg-emerald-600/80 hover:bg-emerald-600 text-white font-bold rounded-xl text-xs flex items-center gap-1.5">
                      <Download size={13} /> Export CSV
                    </button>
                    <button onClick={() => onDelete(record.id)} className="px-4 py-2 bg-red-500/20 hover:bg-red-500/40 text-red-200 font-bold rounded-xl text-xs flex items-center gap-1.5">
                      <Trash2 size={13} /> Hapus
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// PODIUM PEMENANG (10 TERBAIK + DOWNLOAD EXCEL)
// ============================================================================
function WinnersDashboard({ students, resetSetup, downloadExcel }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative">
      <button onClick={resetSetup} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
        <ArrowLeft size={18} /> Kembali ke Dashboard
      </button>

      <Crown size={80} className="text-yellow-400 mb-4 animate-bounce" />
      <h1 className="text-5xl font-black text-white mb-4">PERMAINAN SELESAI!</h1>
      <p className="text-indigo-200 mb-6 font-bold text-lg">Papan Peringkat 10 Terbaik</p>
      
      <div className="glass-card p-6 rounded-3xl max-w-xl w-full mb-8 space-y-3 max-h-[50vh] overflow-y-auto">
        {students.slice(0, 10).map((s, idx) => (
          <div key={s.id} className={`flex justify-between items-center p-3.5 rounded-2xl font-bold text-lg ${idx === 0 ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/40' : idx === 1 ? 'bg-slate-300/20 text-slate-200' : idx === 2 ? 'bg-amber-700/20 text-amber-400' : 'bg-white/5 text-white'}`}>
            <span className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-sm">#{idx + 1}</span>
              {s.name}
            </span>
            <span className="text-yellow-400 font-black">{s.score || 0} Pts</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 justify-center">
        <button onClick={downloadExcel} className="px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-2xl flex items-center gap-2 shadow-xl">
          <Download size={20} /> Download Rekap Excel
        </button>
        <button onClick={resetSetup} className="px-8 py-4 glass-card hover:bg-white/20 text-white font-bold rounded-2xl flex items-center gap-2 shadow-xl">
          <ArrowLeft /> Menu Sesi Baru
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// MODE Peserta
// ============================================================================
function StudentMode({ user, db, appId, setRole }) {
  const [name, setName] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [sessionPin, setSessionPin] = useState(null);
  const [isJoined, setIsJoined] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isResuming, setIsResuming] = useState(true);
  const [joinError, setJoinError] = useState('');
  const [showPeek, setShowPeek] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [quizState, setQuizState] = useState(null);
  const [students, setStudents] = useState([]);
  const [sessionReady, setSessionReady] = useState(false);

  // ==========================================================================
  // SAMBUNG OTOMATIS KE SESI SEBELUMNYA kalau halaman dimuat ulang. Karena
  // sekarang bisa ada BANYAK sesi kuis (satu per guru) berjalan bersamaan,
  // yang dipakai untuk tahu "kuis mana milik peserta ini" bukan lagi satu
  // status global, melainkan penunjuk kecil khusus akun anonim perangkat ini
  // (`studentActiveSession/{uid}`) yang dibuat saat pertama kali BERGABUNG.
  // ==========================================================================
  useEffect(() => {
    if (!user || !db) { setIsResuming(false); return; }
    let cancelled = false;
    const resume = async () => {
      try {
        const ptrSnap = await getDoc(studentSessionPointerRef(user.uid));
        const candidatePin = ptrSnap.exists() ? ptrSnap.data().pin : null;
        if (candidatePin) {
          const sessSnap = await getDoc(quizSessionRef(candidatePin));
          if (!cancelled && sessSnap.exists()) {
            setSessionPin(candidatePin);
            setIsJoined(true);
          } else if (!cancelled) {
            deleteDoc(studentSessionPointerRef(user.uid)).catch(() => {});
          }
        }
      } catch (error) {
        console.error("Gagal memeriksa sesi sebelumnya:", error);
      } finally {
        if (!cancelled) setIsResuming(false);
      }
    };
    resume();
    return () => { cancelled = true; };
  }, [user, db]);

  const handleJoin = async (e) => {
    e.preventDefault();
    setJoinError('');
    if (!user) return setJoinError("Koneksi akun belum siap. Pastikan Anonymous Authentication aktif di Firebase, lalu muat ulang halaman.");
    const trimmedPin = pinInput.trim();
    if (!trimmedPin) return setJoinError("Masukkan PIN kuis terlebih dahulu.");

    setIsJoining(true);
    try {
      const sessionSnap = await getDoc(quizSessionRef(trimmedPin));
      if (!sessionSnap.exists()) {
        setJoinError("PIN Salah atau ruang kuis belum dibuka oleh Pemateri. Pastikan PIN sesuai dengan yang ditampilkan di layar Pemateri.");
        setIsJoining(false);
        return;
      }
      const myRef = quizSessionStudentRef(trimmedPin, user.uid);
      await setDoc(myRef, {
        name: name.trim(), score: 0, progress: 0, completed: false, answers: []
      });
      // Pastikan tulisan benar-benar sampai & tersimpan di server (bukan
      // cuma tersimpan di cache lokal perangkat ini) sebelum menganggap
      // "berhasil bergabung" — supaya kalau sebenarnya gagal (mis. Security
      // Rules menolak), Peserta langsung tahu, bukan malah macet diam-diam.
      await getDocFromServer(myRef);
      // Catat sesi mana yang sedang diikuti perangkat ini, supaya kalau
      // halaman dimuat ulang, peserta otomatis tersambung lagi tanpa perlu
      // memasukkan PIN & nama ulang.
      await setDoc(studentSessionPointerRef(user.uid), { pin: trimmedPin, joinedAt: Date.now() });
      setSessionPin(trimmedPin);
      setIsJoined(true);
    } catch (error) {
      console.error("Gagal bergabung ke ruang kuis:", error);
      const code = error?.code || '';
      let msg = "Gagal bergabung ke ruang kuis. Coba lagi.\n\nDetail teknis: " + (error?.message || error);
      if (code.includes('permission-denied')) {
        msg = "Gagal bergabung: akses ditolak oleh Firestore Security Rules. Minta Pemateri/admin memeriksa pengaturan Firebase (lihat firestore.rules).";
      } else if (code.includes('not-found') || code.includes('unavailable')) {
        msg = "Gagal bergabung: server Firestore tidak bisa dihubungi. Periksa koneksi internet kamu, lalu coba lagi.";
      }
      setJoinError(msg);
      setIsJoined(false);
    } finally {
      setIsJoining(false);
    }
  };

  // Begitu bergabung (atau tersambung ulang otomatis), sambungkan ke state
  // sesi & daftar peserta MILIK SESI (PIN) ITU SAJA — sesi guru lain yang
  // sedang berjalan bersamaan tidak akan terlihat/tercampur di sini.
  useEffect(() => {
    if (!db || !isJoined || !sessionPin) return;
    setSessionReady(false);
    const unsubState = onSnapshot(quizSessionRef(sessionPin), (snap) => {
      setQuizState(snap.exists() ? snap.data() : null);
      setSessionReady(true);
    }, (error) => {
      console.error("Firestore quizSession error:", error);
      setSessionReady(true);
    });
    const unsubStudents = onSnapshot(quizSessionStudentsRef(sessionPin), (querySnap) => {
      const studentData = querySnap.docs.map(d => ({ id: d.id, ...d.data() }));
      studentData.sort((a, b) => (b.score || 0) - (a.score || 0));
      setStudents(studentData);
    }, (error) => {
      console.error("Firestore students error:", error);
    });
    return () => { unsubState(); unsubStudents(); };
  }, [db, isJoined, sessionPin]);

  // "Keluar"/"Kembali": lepaskan penunjuk sesi supaya lain kali dibuka,
  // Peserta memulai dari form PIN yang bersih (bukan otomatis tersambung
  // lagi ke sesi yang baru saja ia tinggalkan).
  const handleExit = () => {
    if (user?.uid) deleteDoc(studentSessionPointerRef(user.uid)).catch(() => {});
    setIsJoined(false);
    setSessionPin(null);
    setQuizState(null);
    setStudents([]);
    setRole(null);
  };

  if (isResuming) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative">
        <Hourglass size={64} className="text-indigo-300 animate-spin mb-4" />
        <h2 className="text-2xl font-bold text-white">Menyambungkan...</h2>
      </div>
    );
  }

  if (!isJoined) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 relative">
        <button onClick={() => setRole(null)} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali
        </button>
        <div className="glass-card p-8 rounded-3xl max-w-sm w-full text-center">
          <Gamepad2 size={48} className="mx-auto text-emerald-400 mb-4" />
          <h2 className="text-2xl font-black text-white mb-6">Masuk Arena</h2>
          <form onSubmit={handleJoin} className="space-y-4">
            <input type="text" placeholder="PIN GAME" maxLength={5} required className="w-full p-4 glass-input rounded-2xl text-center text-2xl font-black tracking-widest uppercase" value={pinInput} onChange={e => setPinInput(e.target.value)} />
            <input type="text" placeholder="Nama Kamu" required className="w-full p-4 glass-input rounded-2xl text-center font-bold" value={name} onChange={e => setName(e.target.value)} />
            {joinError && (
              <p className="text-red-200 bg-red-900/40 p-4 rounded-2xl text-sm font-bold flex items-center gap-2 text-left">
                <AlertCircle size={18} className="shrink-0" /> {joinError}
              </p>
            )}
            <button type="submit" disabled={isJoining} className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-black rounded-2xl">
              {isJoining ? "Menghubungkan..." : "BERGABUNG"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!sessionReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative">
        <Hourglass size={64} className="text-indigo-300 animate-spin mb-4" />
        <h2 className="text-2xl font-bold text-white">Menyambungkan ke ruang kuis...</h2>
      </div>
    );
  }

  if (!quizState) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative">
        <button onClick={handleExit} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali
        </button>
        <AlertCircle size={64} className="text-amber-400 mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2">Sesi Ini Sudah Tidak Aktif</h2>
        <p className="text-indigo-200">Pemateri mungkin sudah mengakhiri atau mengganti sesi kuis ini. Silakan minta PIN baru dari Pemateri.</p>
      </div>
    );
  }

  const myData = students.find(s => s.id === user.uid) || { score: 0, progress: 0, completed: false, answers: [] };

  if (quizState.status === 'waiting') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative">
        <button onClick={handleExit} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Keluar
        </button>
        <Grid size={64} className="text-amber-400 animate-bounce mb-4" />
        <h2 className="text-3xl font-black text-white mb-2">Kamu Sudah Siap, {myData.name}!</h2>
        <p className="text-indigo-200">Perhatikan instruksi Pemateri. Permainan akan segera dimulai...</p>
      </div>
    );
  }

  if (quizState.status === 'finished' || myData.completed) {
    const canReview = (quizState.quizType === 'standard' || quizState.quizType.startsWith('skd-')) && Array.isArray(quizState.questions) && quizState.questions.length > 0 && Array.isArray(myData.answers);
    return (
      <div className="min-h-screen flex flex-col items-center p-6 text-center relative">
        <button onClick={handleExit} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Kembali ke Menu Awal
        </button>
        <div className="flex-1 flex flex-col items-center justify-center w-full">
          <CheckCircle2 size={80} className="text-emerald-400 mb-4" />
          <h2 className="text-4xl font-black text-white mb-2">Luar Biasa, {myData.name}!</h2>
          <p className="text-indigo-200 mb-6">Sesi permainan ini telah selesai atau waktu kamu habis.</p>
          <div className="glass-card px-10 py-6 rounded-3xl mb-6">
            <span className="text-sm text-indigo-300 block font-bold uppercase">Total Skor Kamu</span>
            <span className="text-6xl font-black text-yellow-400">{myData.score} Pts</span>
          </div>
          {canReview && (
            <button onClick={() => setShowReview(v => !v)} className="px-6 py-3 glass-card hover:bg-white/20 text-white font-bold rounded-2xl flex items-center gap-2 mb-6">
              <Eye size={18} /> {showReview ? 'Sembunyikan Pembahasan' : 'Lihat Pembahasan Jawaban'}
            </button>
          )}
          {canReview && showReview && (
            <ReviewSection
              questions={quizState.questions}
              answers={myData.answers}
              uid={user?.uid}
              shuffleOptions={quizState.shuffleOptions !== false}
              showOptionLabels={quizState.showOptionLabels !== false}
            />
          )}
        </div>
      </div>
    );
  }

  if (quizState.quizType.startsWith('5r')) {
    return (
      <Game5RBoard
        user={user} db={db} appId={appId} pin={sessionPin} myData={myData} quizType={quizState.quizType}
        durationSeconds={quizState.durationSeconds} setRole={handleExit}
      />
    );
  }

  const activeQ = quizState.questions[myData.progress];
  if (!activeQ) return null;

  const shuffleOptions = quizState.shuffleOptions !== false;
  const showOptionLabels = quizState.showOptionLabels !== false;
  const optionOrder = getDisplayOptionOrder(activeQ, `${user?.uid}-${myData.progress}`, shuffleOptions);

  const handleStandardAnswer = async (opt) => {
    const isCorrect = activeQ.answer === opt;
    const newProgress = myData.progress + 1;
    const newAnswers = [...(myData.answers || [])];
    newAnswers[myData.progress] = opt;
    try {
      await setDoc(quizSessionStudentRef(sessionPin, user.uid), {
        ...myData,
        score: (myData.score || 0) + (isCorrect ? 100 : 0),
        progress: newProgress,
        answers: newAnswers,
        completed: newProgress >= quizState.questions.length
      });
    } catch (error) {
      console.error("Gagal menyimpan jawaban:", error);
      alert("Jawaban gagal tersimpan karena masalah koneksi ke Firestore. Coba klik jawaban sekali lagi.");
    }
  };

  const topPeek = [...students].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 max-w-xl mx-auto relative">
      <button onClick={handleExit} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
        <ArrowLeft size={18} /> Keluar
      </button>
      <button onClick={() => setShowPeek(v => !v)} className="absolute top-6 right-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20 text-sm font-bold">
        <Trophy size={16} className="text-yellow-400" /> Peringkat
      </button>

      {showPeek && (
        <div className="absolute top-20 right-6 glass-card p-4 rounded-2xl w-64 z-20 border border-white/20 shadow-2xl">
          <h4 className="text-xs font-black uppercase text-indigo-300 mb-2 flex items-center gap-1"><Trophy size={12} className="text-yellow-400" /> Peringkat Sementara</h4>
          <div className="space-y-1.5">
            {topPeek.map((s, idx) => (
              <div key={s.id} className={`flex justify-between text-sm font-bold px-2 py-1 rounded-lg ${s.id === user?.uid ? 'bg-indigo-500/30 text-white' : 'text-indigo-100'}`}>
                <span>#{idx + 1} {s.name}</span>
                <span>{s.score || 0}</span>
              </div>
            ))}
            {topPeek.length === 0 && <p className="text-xs text-indigo-300/70">Belum ada data.</p>}
          </div>
        </div>
      )}

      <div className="glass-card p-8 rounded-3xl w-full text-center mb-6">
        <p className="text-xs font-black uppercase tracking-widest text-indigo-300 mb-2">Soal {myData.progress + 1} dari {quizState.questions.length}</p>
        {activeQ.image && (
          <img src={activeQ.image} alt="Gambar soal" className="max-h-64 w-auto mx-auto mb-5 rounded-2xl border border-white/20 object-contain bg-black/20" />
        )}
        <h3 className="text-2xl font-bold text-white mb-6">{activeQ.q}</h3>
        <div className="grid grid-cols-1 gap-4">
          {optionOrder.map((opt, idx) => (
            <button key={opt} onClick={() => handleStandardAnswer(opt)} className="p-4 glass-card hover:bg-white/20 text-white font-bold rounded-2xl text-left uppercase">
              {showOptionLabels && <span className="mr-2">{String.fromCharCode(65 + idx)}.</span>}
              {activeQ[opt]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PEMBAHASAN JAWABAN (ditampilkan ke Peserta setelah kuis pilihan ganda selesai)
// ============================================================================
function ReviewSection({ questions, answers, uid, shuffleOptions, showOptionLabels }) {
  return (
    <div className="glass-card p-6 rounded-3xl w-full max-w-2xl text-left space-y-4">
      {questions.map((q, idx) => {
        const myAnswer = answers[idx];
        const isCorrect = myAnswer === q.answer;
        // Urutan opsi disamakan dengan yang dilihat peserta saat mengerjakan
        // (deterministik dari UID + nomor soal), supaya "Pembahasan" tidak
        // membingungkan kalau fitur acak opsi jawaban sedang aktif.
        const optionOrder = getDisplayOptionOrder(q, `${uid}-${idx}`, shuffleOptions);
        return (
          <div key={idx} className={`p-4 rounded-2xl border ${isCorrect ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
            <p className="text-white font-bold mb-3">{idx + 1}. {q.q}</p>
            {q.image && (
              <img src={q.image} alt="Gambar soal" className="max-h-48 w-auto mb-3 rounded-xl border border-white/20 object-contain bg-black/20" />
            )}
            <div className="grid grid-cols-1 gap-2 text-sm">
              {optionOrder.map((opt, optIdx) => {
                const isMine = myAnswer === opt;
                const isKey = q.answer === opt;
                return (
                  <div
                    key={opt}
                    className={`px-3 py-2 rounded-xl font-medium flex items-center justify-between ${
                      isKey ? 'bg-emerald-500/25 text-emerald-200' : isMine ? 'bg-red-500/25 text-red-200' : 'text-indigo-100/70'
                    }`}
                  >
                    <span>{showOptionLabels && `${String.fromCharCode(65 + optIdx)}. `}{q[opt]}</span>
                    {isKey && <CheckCircle2 size={16} />}
                    {isMine && !isKey && <X size={16} />}
                  </div>
                );
              })}
            </div>
            {!myAnswer && <p className="text-xs text-indigo-300 mt-2">Kamu tidak sempat menjawab soal ini.</p>}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// BOARD GAME 5R (TAHAP 1, 2 & 3)
// ============================================================================
const DEFAULT_STAGE_DURATIONS = { '5r-1': 60, '5r-2': 50, '5r-3': 40 };

function Game5RBoard({ user, db, appId, pin, myData, quizType, durationSeconds, setRole }) {
  const isStage1 = quizType === '5r-1';
  const isStage2 = quizType === '5r-2';
  const isStage3 = quizType === '5r-3'; // dahulu Tahap 4 "RAWAT" (tabel urut 7x7); Tahap 3 lama "RESIK" (Grid 3x3) sudah dihapus.

  const totalNums = isStage1 ? 90 : 49;
  // Durasi diatur oleh Pemateri lewat "Pengaturan Waktu & Tampilan" di dashboard
  // (disimpan di quizState.durationSeconds). Kalau tidak ada (mis. sesi lama),
  // pakai nilai bawaan per tahap sebagai cadangan.
  const initialTime = durationSeconds || DEFAULT_STAGE_DURATIONS[quizType] || 60;

  const [gridNumbers, setGridNumbers] = useState([]);
  const [targetNumber, setTargetNumber] = useState(1);
  const [timeLeft, setTimeLeft] = useState(initialTime);

  // ==========================================================================
  // OPTIMASI PERFORMA (MOBILE): simpan nilai yang sering berubah tiap detik
  // (myData, targetNumber, timeLeft) ke dalam ref. Tujuannya supaya fungsi
  // handleNumberClick di bawah bisa dibuat STABIL (referensinya tidak berubah
  // tiap render), sehingga papan angka (yang berisi puluhan tombol) tidak
  // ikut render ulang hanya gara-gara timer berjalan tiap detik atau skor
  // peserta lain berubah di Firestore. Logika & hasil akhirnya identik
  // dengan sebelumnya — murni optimasi, bukan perubahan perilaku.
  // ==========================================================================
  const myDataRef = useRef(myData);
  useEffect(() => { myDataRef.current = myData; }, [myData]);

  const targetNumberRef = useRef(targetNumber);
  useEffect(() => { targetNumberRef.current = targetNumber; }, [targetNumber]);

  const timeLeftRef = useRef(timeLeft);
  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  useEffect(() => {
    const items = [];
    for (let i = 1; i <= totalNums; i++) {
      items.push({
        val: i,
        fontSize: ['14px', '18px', '22px', '26px', '30px'][Math.floor(Math.random() * 5)],
        rotate: `${Math.floor(Math.random() * 50) - 25}deg`,
        padding: `${Math.floor(Math.random() * 10) + 4}px`,
        color: ['#f8fafc', '#fde047', '#86efac', '#7dd3fc', '#f472b6'][Math.floor(Math.random() * 5)],
        isStruck: false
      });
    }

    if (isStage3) {
      // Tahap 3 (Rawat): Angka diurutkan berurutan dari 1 sampai 49 (Tabel)
      items.sort((a, b) => a.val - b.val);
    } else {
      // Tahap 1 & 2: Posisi acak total
      items.sort(() => Math.random() - 0.5);
    }

    setGridNumbers(items);
    setTargetNumber(1);
    setTimeLeft(initialTime);
  }, [quizType, initialTime]);

  useEffect(() => {
    if (timeLeft > 0 && !myData.completed) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    } else if (timeLeft === 0 && !myData.completed) {
      setDoc(quizSessionStudentRef(pin, user.uid), {
        ...myData, completed: true
      }).catch((error) => console.error("Gagal menandai selesai (waktu habis):", error));
    }
  }, [timeLeft, myData.completed]);

  const handleNumberClick = useCallback(async (val) => {
    if (val !== targetNumberRef.current || myDataRef.current.completed || timeLeftRef.current <= 0) return;

    setGridNumbers(prev => prev.map(item => item.val === val ? { ...item, isStruck: true } : item));
    const nextTarget = targetNumberRef.current + 1;
    targetNumberRef.current = nextTarget;
    setTargetNumber(nextTarget);

    const currentData = myDataRef.current;
    const newProgress = (currentData.progress || 0) + 1;
    const newScore = (currentData.score || 0) + 1; // 1 poin untuk 1 angka benar
    const isStageDone = nextTarget > 49;

    try {
      await setDoc(quizSessionStudentRef(pin, user.uid), {
        ...currentData,
        score: newScore,
        progress: newProgress,
        completed: isStageDone
      });
    } catch (error) {
      // Sengaja tidak pakai alert() di sini agar tidak mengganggu ritme
      // permainan yang serba cepat; error tetap dicatat untuk debugging.
      console.error("Gagal menyimpan progres game:", error);
    }
  }, [db, appId, pin, user.uid]);

  // isTimeUp dipakai (bukan angka timeLeft langsung) supaya papan angka di
  // bawah hanya render ulang saat status ini benar2 berubah (paling banyak
  // sekali per sesi), bukan setiap detik mengikuti hitung mundur.
  const isTimeUp = timeLeft <= 0;

  return (
    <div className="min-h-screen p-4 md:p-6 flex flex-col items-center max-w-6xl mx-auto relative">
      <button onClick={() => setRole(null)} className="self-start mb-2 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20 text-sm">
        <ArrowLeft size={16} /> Keluar Arena
      </button>

      <div className="w-full glass-card p-4 rounded-2xl mb-4 flex flex-wrap justify-between items-center gap-4 bg-gradient-to-r from-indigo-900/60 to-purple-900/60 border border-indigo-500/30">
        <div>
          <span className="text-xs font-black uppercase tracking-widest text-amber-300">
            {isStage1 && 'Tahap 1: RINGKAS (90 Angka Acak)'}
            {isStage2 && 'Tahap 2: RAPI (49 Angka Acak)'}
            {isStage3 && 'Tahap 3: RAWAT (49 Angka Urut Tabel 7x7)'}
          </span>
          <h2 className="text-2xl font-black text-white">
            Cari & Klik Angka: <span className="text-emerald-400 text-3xl underline decoration-wavy">{targetNumber <= 49 ? targetNumber : 'SELESAI!'}</span>
          </h2>
        </div>

        <div className="flex items-center gap-4">
          <div className={`px-4 py-2 rounded-xl font-black text-lg flex items-center gap-2 ${timeLeft <= 10 ? 'bg-red-500 animate-pulse text-white' : 'bg-white/10 text-white'}`}>
            <Timer size={20} /> 00:{timeLeft < 10 ? `0${timeLeft}` : timeLeft}
          </div>
          <div className="glass-card px-4 py-2 rounded-xl text-yellow-300 font-black">
            Skor: {myData.score || 0} Pts
          </div>
        </div>
      </div>

      {isStage3 ? (
        /* RENDER TAHAP 3 (RAWAT): TABEL URUT 7x7 DENGAN UKURAN ACAK */
        <NumberGridTable gridNumbers={gridNumbers} onNumberClick={handleNumberClick} isTimeUp={isTimeUp} />
      ) : (
        /* RENDER TAHAP 1 & 2: POSISI DAN UKURAN ACAK STANDAR */
        <NumberGridFree gridNumbers={gridNumbers} onNumberClick={handleNumberClick} isTimeUp={isTimeUp} />
      )}
    </div>
  );
}

// ============================================================================
// PAPAN ANGKA (DIPISAH & DI-MEMO KHUSUS UNTUK PERFORMA MOBILE)
// ----------------------------------------------------------------------------
// Dua komponen di bawah (+ NumberTile) berisi JSX yang PERSIS SAMA dengan dua
// blok render Tahap 1/2 dan Tahap 3 sebelumnya — tidak ada teks, kelas, atau
// gaya yang diubah. Bedanya, sekarang dibungkus React.memo supaya papan
// (sampai 90 tombol) TIDAK ikut render ulang setiap detik saat timer berjalan
// atau setiap skor peserta lain berubah di Firestore — hanya render ulang
// saat gridNumbers atau isTimeUp benar-benar berubah. (Varian "boxed" untuk
// Tahap 3 lama "Resik"/Grid 3x3 sudah dihapus bersama fiturnya.)
// ============================================================================
const NumberGridTable = React.memo(function NumberGridTable({ gridNumbers, onNumberClick, isTimeUp }) {
  return (
    <div className="w-full flex-1 glass-card p-4 rounded-3xl grid grid-cols-7 gap-2 min-h-[500px] border border-white/20">
      {gridNumbers.map((item) => (
        <NumberTile key={item.val} item={item} onClick={onNumberClick} isTimeUp={isTimeUp} variant="table" />
      ))}
    </div>
  );
});

const NumberGridFree = React.memo(function NumberGridFree({ gridNumbers, onNumberClick, isTimeUp }) {
  return (
    <div className="w-full flex-1 glass-card p-6 rounded-3xl flex flex-wrap content-center justify-center gap-2 md:gap-4 min-h-[500px] shadow-2xl relative overflow-hidden border border-white/20">
      {gridNumbers.map((item) => (
        <NumberTile key={item.val} item={item} onClick={onNumberClick} isTimeUp={isTimeUp} variant="free" />
      ))}
    </div>
  );
});

const NumberTile = React.memo(function NumberTile({ item, onClick, isTimeUp, variant }) {
  const isTable = variant === 'table';
  const hoverScaleClass = isTable ? 'hover:scale-110' : 'hover:scale-125';
  const shadowClass = variant === 'free' ? 'shadow-md' : 'shadow';
  const style = isTable
    ? { fontSize: item.fontSize, color: item.color }
    : { fontSize: item.fontSize, transform: `rotate(${item.rotate})`, padding: item.padding, color: item.color };

  return (
    <button
      onClick={() => onClick(item.val)}
      disabled={item.isStruck || isTimeUp}
      style={style}
      className={`font-black rounded-xl transition select-none flex items-center justify-center ${hoverScaleClass} active:scale-95 ${isTable ? 'p-2' : ''} ${
        item.isStruck ? 'struck-through bg-red-950/20 border border-red-500/30' : `glass-tile hover:bg-white/20 border border-white/15 ${shadowClass} cursor-pointer`
      }`}
    >
      {item.val}
    </button>
  );
});
