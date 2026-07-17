import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  getFirestore, doc, getDoc, setDoc, onSnapshot, collection, getDocs, writeBatch, deleteDoc, getDocFromServer
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import {
  GraduationCap, Gamepad2, Lock, Hourglass, Rocket, AlertCircle, ArrowLeft,
  Landmark, Brain, UserCheck, Trash2, Save, Download, Play, X
} from 'lucide-react';
import { isSheetStorageConfigured, loadTeacherData, saveTeacherData, emptyTeacherData } from './lib/sheetStorage';

// ============================================================================
// DATA BAWAAN: SOAL TWK, TIU, TKP
// ============================================================================
const INITIAL_SKD_QUESTIONS = {
  twk: [
    { q: "Alasan kembalinya pada UUD 1945 adalah bahwa UUD 1945 dianggap sebagai ...[cite: 1]", a: "Konstitusi pertama yang berlaku", b: "Warisan nenek moyang", c: "Konstitusi yang dianggap mampu menjaga kesatuan dan persatuan bangsa", d: "Konstitusi yang paling baik saat ini", e: "Konstitusi yang cocok untuk bangsa indonesia", answer: "c", image: "" },
    { q: "Sistem pemerintahan menurut UUD 1945 menegaskan bahwa ..[cite: 1]", a: "Kekuasaan kepala negara tak terbatas", b: "Kekuasaan kepala negara perlu dibatasi", c: "Kekuasaan kepala negara sangat terbatas", d: "Kekuasaan kepala negara seumur hidup", e: "Kekuasaan kepala negara tidak tak terbatas.", answer: "e", image: "" }
  ],
  tiu: [
    { q: "GETIR = ...[cite: 1]", a: "Manis", b: "Sakit", c: "Pedas", d: "Nyeri", e: "Pahit", answer: "e", image: "" },
    { q: "NEKAT >< ...[cite: 1]", a: "Niat", b: "Motif", c: "Maksud", d: "Berani", e: "Takut", answer: "e", image: "" }
  ],
  tkp: [
    { q: "Ketika saya mengalami kegagalan, saya cenderung ...[cite: 1]", a: "Merasa bodoh dan putus asa", b: "Merasa sedih dan marah", c: "Mencari sumber kegagalan saya", d: "Biasa saja seperti tidak terjadi apa-apa", e: "Melupakan kegagalan dan menatapkedepan", answer: "c", image: "" },
    { q: "Kadangkala saya merasa lapar ketika jam kerja, maka yang saya lakukan adalah ...[cite: 1]", a: "Menyelesaikan pekerjaan terlebih dahulu kemudian makan", b: "Meminta izin atasan untuk makan", c: "Meminta teman menggantikan kerja sebentar", d: "Ke pantry segera membuat makanan", e: "Pergi ke warung terdekat untuk membeli makan", answer: "a", image: "" }
  ]
};

// ============================================================================
// UTILITAS: ACAK OPSI & GAMBAR
// ============================================================================
function seedFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
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

function getDisplayOptionOrder(question, seedKey, shuffleEnabled) {
  // Ditambahkan dukungan hingga opsi E
  const opts = ['a', 'b', 'c', 'd', 'e'].filter(o => question && question[o]);
  if (!shuffleEnabled) return opts;
  return seededShuffle(opts, seedKey);
}

function resizeImageFile(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; } 
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
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
// METADATA GAME "SKD CPNS"
// ============================================================================
const SKD_META = {
  twk: { key: 'twk', quizType: 'skd-twk', label: 'TWK', nama: 'Tes Wawasan Kebangsaan', recommendedMinutes: 25, icon: Landmark },
  tiu: { key: 'tiu', quizType: 'skd-tiu', label: 'TIU', nama: 'Tes Intelegensia Umum', recommendedMinutes: 35, icon: Brain },
  tkp: { key: 'tkp', quizType: 'skd-tkp', label: 'TKP', nama: 'Tes Karakteristik Pribadi', recommendedMinutes: 40, icon: UserCheck },
};

// ============================================================================
// KONFIGURASI FIREBASE
// ============================================================================
const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "AIzaSyCiw7GBI5P9al1Zq2qJ6kDPuHvfrAUWHVo",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "creativeproject-331c9.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "creativeproject-331c9",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "creativeproject-331c9.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "475885252602",
  appId: env.VITE_FIREBASE_APP_ID || "1:475885252602:web:4c72076ee16a572801fe43"
};

const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const appId = env.VITE_APP_ID || 'default-quiz-app';

function sanitizeAccountKey(raw) { return String(raw || '').trim().toLowerCase().replace(/[\/\s]+/g, '_') || 'guru'; }
function teacherSessionPointerRef(teacherKey) { return doc(db, 'artifacts', appId, 'public', 'data', 'teacherSessions', teacherKey); }
function quizSessionRef(pin) { return doc(db, 'artifacts', appId, 'public', 'data', 'quizSessions', pin); }
function quizSessionStudentsRef(pin) { return collection(db, 'artifacts', appId, 'public', 'data', 'quizSessions', pin, 'students'); }

async function deleteQuizSession(pin) {
  if (!pin) return;
  const snap = await getDocs(quizSessionStudentsRef(pin));
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(quizSessionRef(pin));
  await batch.commit();
}

async function generateUniquePin() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = Math.floor(10000 + Math.random() * 90000).toString();
    try {
      const existing = await getDoc(quizSessionRef(candidate));
      if (!existing.exists()) return candidate;
    } catch (error) { return candidate; }
  }
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// ============================================================================
// STYLING CSS GLOBAL (Sesuai aslinya)
// ============================================================================
const globalStyles = `
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; font-family: sans-serif; background-color: #0f172a; }
  @keyframes gradientBG { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  .animated-bg { background: linear-gradient(-45deg, #0f172a, #312e81, #4c1d95, #1e1b4b); background-size: 400% 400%; animation: gradientBG 15s ease infinite; color: white; min-height: 100vh; width: 100%; }
  .glass-card { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(24px); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3); }
  .glass-input { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.15); color: white; }
  .glass-input:focus { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.5); outline: none; }
`;

export default function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const styleSheet = document.createElement("style");
    styleSheet.innerText = globalStyles;
    document.head.appendChild(styleSheet);
  }, []);

  useEffect(() => {
    if (!auth) { setLoading(false); return; }
    signInAnonymously(auth).catch(console.error);
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  if (loading) return <div className="flex items-center justify-center min-h-screen animated-bg"><Hourglass className="animate-spin" /></div>;

  if (!role) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen animated-bg p-6">
        <div className="glass-card p-10 rounded-[2.5rem] w-full max-w-4xl flex flex-col md:flex-row items-center gap-10">
          <div className="flex-1 text-center md:text-left">
            <h1 className="text-5xl md:text-6xl font-extrabold mb-4">Kuis & Game 5R AI</h1>
            <p className="text-indigo-100 mb-10 text-lg">Pilih peran Anda untuk masuk ke arena.</p>
            <div className="space-y-4">
              <button onClick={() => setRole('teacher')} className="w-full py-4 glass-card hover:bg-white/10 rounded-2xl font-bold flex justify-center gap-4"><GraduationCap /> Masuk Mode Pemateri</button>
              <button onClick={() => setRole('student')} className="w-full py-4 bg-emerald-600/80 rounded-2xl font-bold flex justify-center gap-4"><Gamepad2 /> Masuk Mode Peserta</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen animated-bg font-sans">
      {role === 'teacher' ? <TeacherAuthWrapper db={db} appId={appId} setRole={setRole} /> : <StudentMode user={user} db={db} setRole={setRole} />}
    </div>
  );
}

function TeacherAuthWrapper(props) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  const handleLogin = async (e) => {
    e.preventDefault();
    // Bypass untuk contoh (gunakan validasi Sheets Anda di versi production)
    if(email && password) setIsAuthenticated(true);
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6">
        <button onClick={() => props.setRole(null)} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl flex items-center gap-2"><ArrowLeft size={18}/> Kembali</button>
        <form onSubmit={handleLogin} className="glass-card p-10 rounded-[2.5rem] w-full max-w-md space-y-5 text-center">
          <Lock size={40} className="mx-auto mb-6 text-white" />
          <h2 className="text-2xl font-bold">Otorisasi Pemateri</h2>
          <input type="email" placeholder="Email" required value={email} onChange={e => setEmail(e.target.value)} className="w-full p-4 glass-input rounded-2xl" />
          <input type="password" placeholder="Password" required value={password} onChange={e => setPassword(e.target.value)} className="w-full p-4 glass-input rounded-2xl" />
          <button type="submit" className="w-full py-4 bg-indigo-500 rounded-2xl font-bold">Akses Dashboard</button>
        </form>
      </div>
    );
  }

  return <TeacherMode {...props} teacherEmail={email} />;
}

// ============================================================================
// DASHBOARD PEMATERI (Tampilan diringkas)
// ============================================================================
function TeacherMode({ db, appId, setRole, teacherEmail }) {
  const teacherKey = useMemo(() => sanitizeAccountKey(teacherEmail), [teacherEmail]);
  const [pin, setPin] = useState(null);
  const [quizState, setQuizState] = useState(null);
  const [students, setStudents] = useState([]);
  
  const [activeTab, setActiveTab] = useState('setup');
  const [quizTitle, setQuizTitle] = useState('');
  const [questionsList, setQuestionsList] = useState([]);
  const [skdQuestions, setSkdQuestions] = useState(INITIAL_SKD_QUESTIONS);
  const [newQuestion, setNewQuestion] = useState({ q: '', a: '', b: '', c: '', d: '', e: '', answer: 'a', image: '' });

  useEffect(() => {
    if (!db || !teacherKey) return;
    const unsub = onSnapshot(teacherSessionPointerRef(teacherKey), (snap) => setPin(snap.exists() ? snap.data().pin : null));
    return () => unsub();
  }, [db, teacherKey]);

  useEffect(() => {
    if (!db || !pin) return;
    const unsubState = onSnapshot(quizSessionRef(pin), (snap) => setQuizState(snap.exists() ? snap.data() : null));
    const unsubStudents = onSnapshot(quizSessionStudentsRef(pin), (q) => {
      setStudents(q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.score || 0) - (a.score || 0)));
    });
    return () => { unsubState(); unsubStudents(); };
  }, [db, pin]);

  const addQuestion = () => {
    if (!newQuestion.q || !newQuestion.a) return alert("Lengkapi pertanyaan!");
    setQuestionsList([...questionsList, newQuestion]);
    setNewQuestion({ q: '', a: '', b: '', c: '', d: '', e: '', answer: 'a', image: '' });
  };

  const openRoom = async (type) => {
    const isSkd = type.startsWith('skd-');
    const skdKey = isSkd ? type.replace('skd-', '') : null;
    const qList = isSkd ? skdQuestions[skdKey] : questionsList;
    if (qList.length === 0) return alert("Buat minimal 1 soal dahulu!");

    if (pin) await deleteQuizSession(pin);
    const newPin = await generateUniquePin();
    
    await setDoc(quizSessionRef(newPin), {
      status: 'waiting', quizType: type, title: quizTitle || 'Sesi Baru',
      pin: newPin, questions: qList, duration: 30
    });
    await setDoc(teacherSessionPointerRef(teacherKey), { pin: newPin });
  };

  const endSession = async () => {
    if(!window.confirm("Akhiri kuis?")) return;
    await setDoc(quizSessionRef(pin), { ...quizState, status: 'finished', endTime: Date.now() });
  };

  // Tampilan Dashboard Aktif (Jika PIN ada)
  if (pin && quizState) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-6">
        <div className="glass-card p-6 rounded-3xl text-center">
          <h2 className="text-xl text-indigo-200">PIN Sesi Berjalan</h2>
          <h1 className="text-6xl font-black tracking-widest text-white my-4">{pin}</h1>
          <p className="mb-4">Status: <strong className="uppercase">{quizState.status}</strong></p>
          <div className="flex gap-4 justify-center">
            {quizState.status === 'waiting' && <button onClick={() => setDoc(quizSessionRef(pin), { ...quizState, status: 'active' })} className="px-6 py-3 bg-emerald-500 rounded-xl font-bold flex items-center gap-2"><Play /> Mulai Kuis</button>}
            <button onClick={endSession} className="px-6 py-3 bg-red-500 rounded-xl font-bold flex items-center gap-2"><X /> Akhiri</button>
          </div>
        </div>
        <div className="glass-card p-6 rounded-3xl">
          <h3 className="text-xl font-bold mb-4">Peserta ({students.length})</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {students.map(s => <div key={s.id} className="p-3 bg-white/10 rounded-lg">{s.name} - {s.score || 0} Poin</div>)}
          </div>
        </div>
      </div>
    );
  }

  // Tampilan Setup & Bank Soal (Dibuat ringkas)
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex gap-4 mb-8 border-b border-white/20 pb-4">
        {['setup', 'bank', 'riwayat'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`px-6 py-2 rounded-xl font-bold uppercase ${activeTab === tab ? 'bg-indigo-500 text-white' : 'text-indigo-200 hover:bg-white/10'}`}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'setup' && (
        <div className="space-y-6">
          <input type="text" placeholder="Judul Kuis (Opsional)" value={quizTitle} onChange={e => setQuizTitle(e.target.value)} className="w-full p-4 glass-input rounded-2xl text-xl font-bold" />
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="glass-card p-6 rounded-2xl flex flex-col gap-4 items-center text-center">
              <Landmark size={40} className="text-sky-300"/>
              <h3 className="font-bold">Tes Wawasan Kebangsaan</h3>
              <p className="text-sm opacity-80">{skdQuestions.twk.length} Soal Tersedia</p>
              <button onClick={() => openRoom('skd-twk')} className="w-full py-2 bg-sky-500 rounded-lg font-bold">Buka Ruang TWK</button>
            </div>
            <div className="glass-card p-6 rounded-2xl flex flex-col gap-4 items-center text-center">
              <Brain size={40} className="text-violet-300"/>
              <h3 className="font-bold">Tes Intelegensia Umum</h3>
              <p className="text-sm opacity-80">{skdQuestions.tiu.length} Soal Tersedia</p>
              <button onClick={() => openRoom('skd-tiu')} className="w-full py-2 bg-violet-500 rounded-lg font-bold">Buka Ruang TIU</button>
            </div>
            <div className="glass-card p-6 rounded-2xl flex flex-col gap-4 items-center text-center">
              <UserCheck size={40} className="text-amber-300"/>
              <h3 className="font-bold">Tes Karakteristik Pribadi</h3>
              <p className="text-sm opacity-80">{skdQuestions.tkp.length} Soal Tersedia</p>
              <button onClick={() => openRoom('skd-tkp')} className="w-full py-2 bg-amber-500 rounded-lg font-bold">Buka Ruang TKP</button>
            </div>
          </div>

          <details className="glass-card p-6 rounded-2xl cursor-pointer">
            <summary className="font-bold text-lg outline-none">Tambah Soal Standar Manual ({questionsList.length} Soal)</summary>
            <div className="mt-4 space-y-4 cursor-auto">
              <textarea placeholder="Pertanyaan..." value={newQuestion.q} onChange={e => setNewQuestion({...newQuestion, q: e.target.value})} className="w-full p-3 glass-input rounded-xl" rows={3} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {['a','b','c','d','e'].map(opt => (
                  <div key={opt} className="flex items-center gap-2">
                    <input type="radio" name="answer" checked={newQuestion.answer === opt} onChange={() => setNewQuestion({...newQuestion, answer: opt})} className="w-5 h-5"/>
                    <input type="text" placeholder={`Opsi ${opt.toUpperCase()}`} value={newQuestion[opt]} onChange={e => setNewQuestion({...newQuestion, [opt]: e.target.value})} className="flex-1 p-2 glass-input rounded-lg" />
                  </div>
                ))}
              </div>
              <button onClick={addQuestion} className="px-6 py-2 bg-indigo-500 rounded-xl font-bold">Simpan Soal</button>
            </div>
          </details>
        </div>
      )}

      {activeTab === 'bank' && <div className="glass-card p-6 rounded-2xl text-center"><p className="text-indigo-200">Daftar Bank Soal Anda (Konfigurasi Sheet Terpisah)</p></div>}
      {activeTab === 'riwayat' && <div className="glass-card p-6 rounded-2xl text-center"><p className="text-indigo-200">Riwayat Sesi Sebelumnya</p></div>}
    </div>
  );
}

// ============================================================================
// MODE PESERTA (Sederhana)
// ============================================================================
function StudentMode({ setRole, db }) {
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');

  return (
    <div className="flex items-center justify-center min-h-screen p-6">
      <div className="glass-card p-10 rounded-[2.5rem] w-full max-w-md text-center">
        <h2 className="text-3xl font-bold mb-6">Gabung Kuis</h2>
        <div className="space-y-4">
          <input type="text" placeholder="PIN Ruangan" value={pin} onChange={e => setPin(e.target.value)} className="w-full p-4 glass-input rounded-2xl text-center font-bold tracking-widest text-xl" />
          <input type="text" placeholder="Nama Anda" value={name} onChange={e => setName(e.target.value)} className="w-full p-4 glass-input rounded-2xl text-center" />
          <button className="w-full py-4 bg-emerald-500 rounded-2xl font-bold text-lg shadow-lg">Masuk Ruangan</button>
        </div>
        <button onClick={() => setRole(null)} className="mt-6 text-sm opacity-70 hover:opacity-100 underline">Kembali ke Menu Utama</button>
      </div>
    </div>
  );
}
