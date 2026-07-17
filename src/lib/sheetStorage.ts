// ============================================================================
// PENYIMPANAN BANK SOAL & RIWAYAT KUIS KE GOOGLE SPREADSHEET
// ----------------------------------------------------------------------------
// Spreadsheet login Pemateri (kolom A = email, kolom B = password) HANYA bisa
// DIBACA secara publik lewat link gviz/tq (lihat App.tsx -> handleLogin).
// Untuk MENULIS data balik ke spreadsheet yang sama (Bank Soal & Riwayat
// Kuis), dibutuhkan sebuah jembatan kecil: Google Apps Script yang di-deploy
// sebagai "Web App" oleh pemilik spreadsheet (lihat apps-script/Code.gs &
// README.md bagian "Setup Google Apps Script"). URL Web App tsb diisi lewat
// Environment Variable VITE_SHEETS_API_URL.
//
// Cara penyimpanan: untuk setiap baris guru (dicari lewat kecocokan email di
// kolom A), seluruh data (Bank Soal + Riwayat Kuis) digabung jadi satu teks
// JSON, lalu ditulis mulai dari KOLOM C. Kalau teksnya terlalu panjang untuk
// muat di satu sel, sisanya otomatis dipotong & disambung ke kolom berikutnya
// (D, E, F, dst) sampai seluruh data tertampung.
// ============================================================================

export interface BankSoalItem {
  id: string;
  judul: string;
  createdAt: number;
  // 'standard' = set soal pilihan ganda (default, dipakai juga untuk data lama
  // yang belum punya field ini). 'game5r' = preset pengaturan durasi Game 5R.
  type?: 'standard' | 'game5r';
  questions: any[];
  // Hanya diisi kalau type === 'game5r': durasi tiap tahap dalam detik,
  // mis. { '5r-1': 60, '5r-2': 50, '5r-3': 40 }.
  stageDurations?: Record<string, number>;
}

export interface RiwayatItem {
  id: string;
  timestamp: number;
  judul: string;
  quizType: string;
  pin: string;
  totalPeserta: number;
  rataRata: number;
  top10: { name: string; score: number }[];
}

export interface TeacherData {
  bankSoal: BankSoalItem[];
  riwayat: RiwayatItem[];
}

const SHEETS_API_URL: string = import.meta.env.VITE_SHEETS_API_URL || '';

// Batas jumlah item yang disimpan supaya ukuran data tidak membengkak tanpa
// batas di spreadsheet (spreadsheet bukan database sungguhan).
const MAX_BANK_SOAL = 60;
const MAX_RIWAYAT = 60;

export function isSheetStorageConfigured(): boolean {
  return Boolean(SHEETS_API_URL);
}

export function emptyTeacherData(): TeacherData {
  return { bankSoal: [], riwayat: [] };
}

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function trimTeacherData(data: TeacherData): TeacherData {
  return {
    bankSoal: (data.bankSoal || []).slice(-MAX_BANK_SOAL),
    riwayat: (data.riwayat || []).slice(-MAX_RIWAYAT),
  };
}

// ============================================================================
// MEMUAT data guru (dipanggil setelah login berhasil)
// ============================================================================
export async function loadTeacherData(email: string): Promise<TeacherData> {
  if (!SHEETS_API_URL) throw new Error('VITE_SHEETS_API_URL belum diatur.');

  const url = `${SHEETS_API_URL}?action=load&email=${encodeURIComponent(normalizeEmail(email))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal menghubungi Apps Script (HTTP ${res.status}).`);

  const json = await res.json();
  if (!json.ok) {
    // Baris guru belum pernah menyimpan apa pun -> anggap kosong, bukan error fatal.
    if (typeof json.error === 'string' && json.error.toLowerCase().includes('tidak ditemukan')) {
      return emptyTeacherData();
    }
    throw new Error(json.error || 'Gagal memuat data dari spreadsheet.');
  }

  if (!json.data) return emptyTeacherData();
  try {
    const parsed = JSON.parse(json.data);
    return {
      bankSoal: Array.isArray(parsed.bankSoal) ? parsed.bankSoal : [],
      riwayat: Array.isArray(parsed.riwayat) ? parsed.riwayat : [],
    };
  } catch {
    return emptyTeacherData();
  }
}

// ============================================================================
// MENYIMPAN data guru (dipanggil tiap kali Bank Soal/Riwayat berubah)
// ----------------------------------------------------------------------------
// Memakai Content-Type "text/plain" (bukan application/json) dengan sengaja:
// ini membuat request POST dianggap "simple request" oleh browser sehingga
// TIDAK memicu preflight OPTIONS — Google Apps Script Web App tidak bisa
// menjawab preflight itu secara default, jadi kalau dipicu, request akan
// gagal karena CORS. Isi body tetap teks JSON valid & tetap dibaca sebagai
// JSON di sisi Apps Script (lewat e.postData.contents).
// ============================================================================
export async function saveTeacherData(email: string, data: TeacherData): Promise<TeacherData> {
  if (!SHEETS_API_URL) throw new Error('VITE_SHEETS_API_URL belum diatur.');

  const trimmed = trimTeacherData(data);
  const payload = {
    action: 'save',
    email: normalizeEmail(email),
    data: JSON.stringify(trimmed),
  };

  const res = await fetch(SHEETS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Gagal menghubungi Apps Script (HTTP ${res.status}).`);

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Gagal menyimpan data ke spreadsheet.');

  return trimmed;
}
