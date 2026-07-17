// ============================================================================
// DASHBOARD Pemateri (Tampilan Bergaya Playground / SaaS)
// ============================================================================
function TeacherMode({
  db, appId, setRole,
  teacherEmail, teacherData, teacherDataLoading, teacherDataError,
  sheetStorageReady, persistTeacherData
}) {
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
  const [activeTab, setActiveTab] = useState('setup');
  const [isSavingBank, setIsSavingBank] = useState(false);
  const [isSavingGame5RPreset, setIsSavingGame5RPreset] = useState(false);
  const importInputRef = useRef(null);

  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [showOptionLabels, setShowOptionLabels] = useState(true);
  const [stageDurations, setStageDurations] = useState({ '5r-1': 60, '5r-2': 50, '5r-3': 40 });

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
    if (code.includes('permission-denied')) return "Akses ditolak oleh Firestore Security Rules.";
    if (code.includes('unauthenticated')) return "Belum berhasil login (Anonymous Authentication).";
    if (code.includes('unavailable') || code.includes('network')) return "Tidak bisa menghubungi server Firestore.";
    return `Terjadi kendala saat menghubungi Firestore.\n\nDetail teknis: ${error?.message || error}`;
  };

  const openWaitingRoom = async (selectedType = 'standard') => {
    const isGame5R = selectedType.startsWith('5r');
    const isSkd = selectedType.startsWith('skd-');
    const skdKey = isSkd ? selectedType.replace('skd-', '') : null;
    const questionsForSession = selectedType === 'standard' ? questionsList : isSkd ? (skdQuestions[skdKey] || []) : [];

    if (selectedType === 'standard' && questionsForSession.length === 0) return alert("Buat minimal 1 soal untuk mode pilihan ganda!");
    if (isSkd && questionsForSession.length === 0) return alert(`Buat atau muat minimal 1 soal ${SKD_META[skdKey]?.label || 'SKD'} dahulu!`);

    setIsOpeningRoom(true);
    try {
      if (pin) {
        try { await deleteQuizSession(pin); } catch (cleanupError) { console.error(cleanupError); }
      }
      const generatedPin = await generateUniquePin();
      let durationMins = quizDuration;
      let durationSecondsForStage = null;

      if (isGame5R) {
        durationSecondsForStage = stageDurations[selectedType] || 60;
        durationMins = Math.max(1, Math.ceil(durationSecondsForStage / 60) + 1);
      } else if (isSkd) {
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
      await setDoc(teacherSessionPointerRef(teacherKey), { pin: generatedPin, updatedAt: Date.now() });
    } catch (error) {
      alert("Ruang kuis gagal dibuka.\n\n" + explainFirebaseError(error));
    } finally {
      setIsOpeningRoom(false);
    }
  };

  const startQuiz = async () => {
    if (!pin) return;
    try {
      const now = Date.now();
      const end = now + ((quizState.duration || 15) * 60000);
      await setDoc(quizSessionRef(pin), { ...quizState, status: 'active', startTime: now, endTime: end });
    } catch (error) {
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
      alert("Gagal mengakhiri sesi.\n\n" + explainFirebaseError(error));
    }
  };

  const saveHistoryRecord = async (finishedState) => {
    if (!sheetStorageReady || !teacherEmail) return;
    try {
      const sorted = [...students].sort((a, b) => (b.score || 0) - (a.score || 0));
      const record = {
        id: `h_${Date.now()}`,
        timestamp: Date.now(),
        judul: (finishedState.title || '').trim() || getQuizTypeName(finishedState.quizType),
        quizType: finishedState.quizType,
        pin: finishedState.pin || '',
        totalPeserta: sorted.length,
        rataRata: sorted.length > 0 ? Math.round(sorted.reduce((sum, s) => sum + (s.score || 0), 0) / sorted.length) : 0,
        top10: sorted.slice(0, 10).map(s => ({ name: s.name || 'Tanpa Nama', score: s.score || 0 })),
      };
      await persistTeacherData({ ...teacherData, riwayat: [...(teacherData.riwayat || []), record] });
    } catch (error) { console.error("Gagal menyimpan riwayat:", error); }
  };

  const kickStudent = async (studentId) => {
    if (!pin) return;
    try { await deleteDoc(quizSessionStudentRef(pin, studentId)); } 
    catch (error) { alert("Gagal mengeluarkan peserta.\n\n" + explainFirebaseError(error)); }
  };

  const resetSetup = async () => {
    try {
      if (pin) {
        try { await deleteQuizSession(pin); } catch (e) { console.error(e); }
      }
      await deleteDoc(teacherSessionPointerRef(teacherKey));
      setQuizTitle('');
    } catch (error) { alert("Gagal kembali ke menu setup.\n\n" + explainFirebaseError(error)); }
  };

  const saveToBank = async () => {
    if (questionsList.length === 0) return alert("Buat minimal 1 soal dahulu.");
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif.");
    setIsSavingBank(true);
    try {
      const record = {
        id: `b_${Date.now()}`,
        type: 'standard',
        judul: quizTitle.trim() || `Bank Soal ${new Date().toLocaleString('id-ID')}`,
        createdAt: Date.now(),
        questions: questionsList,
      };
      await persistTeacherData({ ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] });
      alert(`Berhasil disimpan!`);
    } catch (error) { alert("Gagal menyimpan ke Bank Soal."); } 
    finally { setIsSavingBank(false); }
  };

  const saveGame5RPresetToBank = async () => {
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif.");
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
      await persistTeacherData({ ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] });
      alert(`Berhasil disimpan!`);
    } catch (error) { alert("Gagal menyimpan preset."); } 
    finally { setIsSavingGame5RPreset(false); }
  };

  const saveSkdToBank = async (subtestKey) => {
    const meta = SKD_META[subtestKey];
    const list = skdQuestions[subtestKey] || [];
    if (list.length === 0) return alert(`Buat minimal 1 soal ${meta.label} dahulu.`);
    if (!sheetStorageReady) return alert("Fitur Bank Soal belum aktif.");
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
      await persistTeacherData({ ...teacherData, bankSoal: [...(teacherData.bankSoal || []), record] });
      alert(`Berhasil disimpan!`);
    } catch (error) { alert("Gagal menyimpan soal."); } 
    finally { setIsSavingSkdBank(prev => ({ ...prev, [subtestKey]: false })); }
  };

  const loadFromBank = (record) => {
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
    try { await persistTeacherData({ ...teacherData, bankSoal: (teacherData.bankSoal || []).filter(b => b.id !== id) }); } 
    catch (error) { alert("Gagal menghapus."); }
  };

  const deleteHistory = async (id) => {
    if (!window.confirm("Hapus riwayat kuis ini?")) return;
    try { await persistTeacherData({ ...teacherData, riwayat: (teacherData.riwayat || []).filter(h => h.id !== id) }); } 
    catch (error) { alert("Gagal menghapus riwayat."); }
  };

  const finishQuestionImport = (rows) => {
    const parsed = importRowsToQuestions(rows);
    if (parsed.length === 0) return alert("Tidak ada soal valid ditemukan.");
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
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          finishQuestionImport(rows);
        } catch (error) { alert("Gagal membaca file Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else if (name.endsWith('.csv') || file.type === 'text/csv') {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = String(evt.target?.result || '');
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length === 0) return alert("File CSV kosong.");
        finishQuestionImport(lines.map(parseCsvLine));
      };
      reader.readAsText(file);
    } else { alert("Format tidak didukung."); }
    if (importInputRef.current) importInputRef.current.value = '';
  };

  const downloadImportTemplate = () => {
    const header = ['Pertanyaan', 'Pilihan A', 'Pilihan B', 'Pilihan C', 'Pilihan D', 'Jawaban (a/b/c/d)', 'URL Gambar (opsional)'];
    const contoh = [['Ibu kota Indonesia?', 'Jakarta', 'Bandung', 'Surabaya', 'Medan', 'a', '']];
    const ws = XLSX.utils.aoa_to_sheet([header, ...contoh]);
    ws['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template Soal');
    XLSX.writeFile(wb, 'Template_Import_Soal.xlsx');
  };

  const getQuizTypeName = (type) => {
    if (type === '5r-1') return 'Game 5R Tahap 1 - Ringkas';
    if (type === '5r-2') return 'Game 5R Tahap 2 - Rapi';
    if (type === '5r-3') return 'Game 5R Tahap 3 - Rawat';
    if (type === 'skd-twk') return 'SKD CPNS - TWK';
    if (type === 'skd-tiu') return 'SKD CPNS - TIU';
    if (type === 'skd-tkp') return 'SKD CPNS - TKP';
    return 'Kuis Pilihan Ganda';
  };

  const status = quizState?.status || 'setup';

  // Tampilan layar penuh untuk status ruang tunggu dan kuis aktif (Immersive Experience)
  if (status === 'finished') {
    return <WinnersDashboard students={students} resetSetup={resetSetup} downloadExcel={downloadExcel} />;
  }

  if (status === 'waiting') {
    return (
      <div className="p-8 min-h-screen flex flex-col items-center justify-center text-center relative bg-black/60 backdrop-blur-md z-50">
        <button onClick={resetSetup} className="absolute top-6 left-6 glass-card px-4 py-2 rounded-xl text-white flex items-center gap-2 hover:bg-white/20">
          <ArrowLeft size={18} /> Menu Setup
        </button>
        <h2 className="text-4xl font-black mb-2 text-white">Ruang Tunggu</h2>
        <p className="text-emerald-400 font-bold text-xl">{quizState.title || getQuizTypeName(quizState.quizType)}</p>
        
        <div className="glass-card p-12 rounded-[3rem] border border-white/20 max-w-xl w-full my-8">
          <div className="text-8xl font-black text-white tracking-widest mb-6">{quizState.pin}</div>
          <div className="text-xl font-bold text-emerald-300 flex items-center justify-center gap-2">
            <Users size={24} /> {students.length} Peserta
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
      <div className="p-8 max-w-6xl mx-auto min-h-screen relative z-50">
        <div className="flex justify-between items-center mb-8 glass-card p-6 rounded-3xl">
          <div>
            <h2 className="text-2xl md:text-3xl font-black text-white flex items-center gap-3">
              <Play className="text-emerald-400 animate-pulse" /> {quizState.title || getQuizTypeName(quizState.quizType)}
            </h2>
          </div>
          <button onClick={() => endQuizSession(true)} className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold flex items-center gap-2">
            <LogOut size={18} /> Akhiri Sesi
          </button>
        </div>

        <div className="glass-card rounded-3xl p-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-white flex items-center gap-2"><Trophy className="text-yellow-400"/> Live Leaderboard</h3>
          </div>
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-2">
            {students.map((s, idx) => (
              <div key={s.id} className="flex justify-between items-center p-4 bg-white/5 rounded-2xl border border-white/10">
                <div className="flex items-center gap-4">
                  <span className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center font-black">{idx + 1}</span>
                  <div>
                    <h4 className="font-bold text-lg text-white">{s.name}</h4>
                    <p className="text-xs text-indigo-300">
                      {quizState.quizType.startsWith('5r') ? `Angka: ${s.progress || 0}/49` : `Menjawab: ${s.progress || 0}/${quizState.questions.length} soal`}
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

  // ==========================================================================
  // PLAYGROUND-STYLE DASHBOARD LAYOUT
  // ==========================================================================
  return (
    <div className="flex h-screen w-full relative z-10 overflow-hidden bg-black/10">
      
      {/* SIDEBAR (Desktop) */}
      <div className="hidden md:flex w-72 flex-col justify-between bg-white/5 border-r border-white/10 backdrop-blur-xl">
        <div>
          <div className="p-6 border-b border-white/10">
            <h1 className="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-indigo-300 flex items-center gap-2">
              <Rocket size={24} className="text-indigo-400"/> 5R AI Dashboard
            </h1>
            <p className="text-xs text-indigo-200/50 mt-1 truncate">{teacherEmail}</p>
          </div>
          <div className="p-4 space-y-2">
            <SidebarButton active={activeTab === 'setup'} onClick={() => setActiveTab('setup')} icon={<Settings2 size={18} />} label="Setup Kuis" />
            <SidebarButton active={activeTab === 'bank'} onClick={() => setActiveTab('bank')} icon={<Gamepad2 size={18} />} label={`Bank Soal (${(teacherData.bankSoal || []).length})`} />
            <SidebarButton active={activeTab === 'riwayat'} onClick={() => setActiveTab('riwayat')} icon={<History size={18} />} label={`Riwayat (${(teacherData.riwayat || []).length})`} />
          </div>
        </div>
        <div className="p-4 border-t border-white/10">
           <button onClick={() => setRole(null)} className="w-full px-4 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-bold rounded-xl flex items-center justify-center gap-2 transition">
              <LogOut size={18} /> Keluar
           </button>
        </div>
      </div>

      {/* MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
        
        {/* HEADER */}
        <div className="h-20 border-b border-white/10 px-6 md:px-8 flex flex-wrap items-center justify-between bg-black/20 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-4">
            {/* Mobile Sidebar Toggle - Visible only on small screens */}
            <button onClick={() => setRole(null)} className="md:hidden text-indigo-200 hover:text-white transition">
              <ArrowLeft size={24} />
            </button>
            <h2 className="text-xl font-bold text-white capitalize">{activeTab} Panel</h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:block">
              <SyncStatusBadge sheetStorageReady={sheetStorageReady} loading={teacherDataLoading} error={teacherDataError} />
            </div>
            <button onClick={downloadExcel} className="px-4 py-2 bg-emerald-600/80 hover:bg-emerald-500 text-white font-bold rounded-xl flex items-center gap-2 text-sm shadow-lg border border-emerald-400/30">
              <Download size={16} /> <span className="hidden sm:inline">Export Excel</span>
            </button>
          </div>
        </div>

        {/* Mobile Tab Navigation */}
        <div className="md:hidden flex p-4 gap-2 overflow-x-auto bg-black/10 border-b border-white/10">
           <TabButton active={activeTab === 'setup'} onClick={() => setActiveTab('setup')} icon={<Settings2 size={14} />} label="Setup" />
           <TabButton active={activeTab === 'bank'} onClick={() => setActiveTab('bank')} icon={<Gamepad2 size={14} />} label="Bank" />
           <TabButton active={activeTab === 'riwayat'} onClick={() => setActiveTab('riwayat')} icon={<History size={14} />} label="Riwayat" />
        </div>

        {/* SCROLLABLE PANEL CONTENT */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-5xl mx-auto space-y-8 pb-20">
            
            {activeTab === 'setup' && (
              <div className="space-y-6">
                <div className="glass-card p-6 rounded-2xl border border-white/10 shadow-lg">
                  <label className="text-sm font-bold text-indigo-200 mb-2 flex items-center gap-2">Judul Sesi Kuis</label>
                  <input type="text" placeholder='Contoh: "Kuis 5R Kelas 7A"' className="w-full p-4 glass-input rounded-xl focus:ring-2 ring-indigo-500/50" value={quizTitle} onChange={e => setQuizTitle(e.target.value)} />
                </div>

                <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/10 shadow-lg">
                  <div className="flex items-center gap-3 mb-6 border-b border-white/10 pb-4">
                    <Settings2 className="text-indigo-300" size={24} />
                    <div>
                      <h2 className="text-xl font-bold text-white">Waktu &amp; Tampilan</h2>
                      <p className="text-indigo-200/70 text-xs mt-1">Hanya untuk Kuis Pilihan Ganda Standar.</p>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-2 gap-8">
                    <div>
                      <label className="text-xs text-indigo-200 mb-2 block font-bold">Durasi Kuis (menit)</label>
                      <input type="number" min={1} max={180} value={quizDuration} onChange={e => setQuizDuration(Math.max(1, parseInt(e.target.value, 10) || 1))} className="w-full p-3 glass-input rounded-xl mb-4" />
                    </div>
                    <div className="space-y-3">
                      <ToggleRow icon={<Shuffle size={15} />} label="Acak Opsi Jawaban" checked={shuffleOptions} onChange={setShuffleOptions} />
                      <ToggleRow icon={<Eye size={15} />} label="Tampil Label A/B/C/D" checked={showOptionLabels} onChange={setShowOptionLabels} />
                    </div>
                  </div>
                </div>

                <div className="grid lg:grid-cols-2 gap-6">
                  <div className="glass-card p-6 rounded-2xl border border-white/10 shadow-lg">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-bold text-white">Buat Soal Manual</h3>
                    </div>
                    <textarea placeholder="Pertanyaan..." className="w-full p-4 glass-input rounded-xl mb-4" value={newQuestion.q} onChange={e => setNewQuestion({...newQuestion, q: e.target.value})} />
                    
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      {['a', 'b', 'c', 'd'].map(opt => (
                        <input key={opt} type="text" placeholder={`Pilihan ${opt.toUpperCase()}`} className="p-3 glass-input rounded-xl" value={newQuestion[opt]} onChange={e => setNewQuestion({...newQuestion, [opt]: e.target.value})} />
                      ))}
                    </div>
                    <div className="flex gap-3">
                      <select className="p-3 bg-indigo-900/50 rounded-xl text-white font-bold border border-white/10 flex-1" value={newQuestion.answer} onChange={e => setNewQuestion({...newQuestion, answer: e.target.value})}>
                        <option value="a">Kunci: A</option><option value="b">Kunci: B</option><option value="c">Kunci: C</option><option value="d">Kunci: D</option>
                      </select>
                      <button onClick={addQuestion} className="px-6 py-3 bg-indigo-500 hover:bg-indigo-400 transition text-white font-bold rounded-xl shadow-lg flex-1">Tambah Soal</button>
                    </div>
                  </div>

                  <div className="glass-card p-6 rounded-2xl border border-white/10 flex flex-col justify-between shadow-lg">
                    <div>
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-bold text-white">Daftar Soal ({questionsList.length})</h3>
                        <label className="px-3 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/40 border border-indigo-400/30 text-indigo-200 text-xs font-bold rounded-lg flex items-center gap-1.5 cursor-pointer transition">
                          <Upload size={14} /> Import CSV/Excel
                          <input ref={importInputRef} type="file" accept=".csv,.xlsx" onChange={handleQuestionImport} className="hidden" />
                        </label>
                      </div>
                      <div className="max-h-56 overflow-y-auto space-y-2 pr-2">
                        {questionsList.map((q, idx) => (
                          <div key={idx} className="p-3 bg-white/5 rounded-xl border border-white/5 text-sm font-medium flex justify-between gap-3">
                            <span className="truncate">{idx + 1}. {q.q}</span>
                            <button onClick={() => removeQuestion(idx)} className="text-red-400 hover:text-red-300 shrink-0"><X size={16}/></button>
                          </div>
                        ))}
                        {questionsList.length === 0 && <p className="text-indigo-300/50 text-sm text-center py-10">Belum ada soal ditambahkan.</p>}
                      </div>
                    </div>
                    <div className="mt-6 pt-4 border-t border-white/10 space-y-3">
                      <button onClick={saveToBank} disabled={questionsList.length === 0 || isSavingBank} className="w-full py-3 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-white font-bold rounded-xl transition flex items-center justify-center gap-2 text-sm border border-white/10">
                        <Save size={16} /> {isSavingBank ? 'Menyimpan...' : 'Simpan ke Bank Soal'}
                      </button>
                    </div>
                  </div>
                </div>
                
                {/* SKD CPNS BUILDER (Sleek layout wrapper) */}
                <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/10 shadow-lg mt-8">
                    <div className="flex items-center gap-3 mb-6 border-b border-white/10 pb-4">
                      <ClipboardList className="text-indigo-300" size={24} />
                      <div>
                        <h2 className="text-xl font-bold text-white">Buat Soal SKD CPNS</h2>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-6">
                      {SKD_ORDER.map(key => {
                        const meta = SKD_META[key];
                        const active = skdSubtestSelector === key;
                        return (
                          <button key={key} type="button" onClick={() => setSkdSubtestSelector(key)} className={`px-4 py-2 rounded-xl font-bold text-sm transition border ${active ? 'bg-indigo-500 border-indigo-400 text-white' : 'bg-transparent border-white/10 text-indigo-300 hover:bg-white/5'}`}>
                            {meta.label} ({ (skdQuestions[key] || []).length })
                          </button>
                        );
                      })}
                    </div>
                    <SkdQuestionBuilder
                      subtestKey={skdSubtestSelector}
                      questions={skdQuestions[skdSubtestSelector] || []}
                      onAdd={(q) => setSkdQuestions(prev => ({ ...prev, [skdSubtestSelector]: [...(prev[skdSubtestSelector] || []), q] }))}
                      onRemove={(idx) => setSkdQuestions(prev => ({ ...prev, [skdSubtestSelector]: (prev[skdSubtestSelector] || []).filter((_, i) => i !== idx) }))}
                      onImportRows={finishQuestionImport} // Assuming logic follows standard import
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
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// KOMPONEN KECIL UNTUK PLAYGROUND UI
// ============================================================================
function SidebarButton({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm transition ${active ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'text-indigo-100/70 hover:bg-white/5 hover:text-white'}`}>
      {icon} {label}
    </button>
  );
}

// ============================================================================
// PENYELESAIAN KOMPONEN: BankSoalPanel (Melanjutkan kode yang terpotong)
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
    <div className="space-y-8">
      {/* SECTION: PILIH & BUKA GAME */}
      <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/10 shadow-lg">
        <div className="flex items-center gap-3 mb-6 border-b border-white/10 pb-4">
          <Gamepad2 className="text-indigo-300" size={24} />
          <div>
            <h2 className="text-xl font-bold text-white">Launcher Game & Kuis</h2>
            <p className="text-indigo-200/70 text-xs mt-1">Konfigurasi durasi dan luncurkan ruang permainan.</p>
          </div>
        </div>

        {/* 5R SECTION */}
        <h4 className="text-xs font-black text-indigo-300/80 uppercase tracking-widest mb-4">Game 5R</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {STAGE_5R_CARDS.map(stage => {
            const Icon = stage.icon;
            return (
              <div key={stage.type} className={`p-5 rounded-2xl flex flex-col justify-between border ${stage.card}`}>
                <div className="mb-4">
                  <span className={`font-black text-[10px] px-2 py-1 rounded-md ${stage.badge}`}>{stage.label}</span>
                  <h3 className="text-lg font-black text-white mt-3">{stage.title}</h3>
                  <div className="flex items-center justify-between gap-2 mt-4 bg-black/20 p-2 rounded-xl">
                    <label className="text-[11px] font-bold text-white/80"><Timer size={12} className="inline mr-1"/> Detik</label>
                    <input type="number" min={5} max={600} value={stageDurations[stage.type]} onChange={e => setStageDurations(prev => ({ ...prev, [stage.type]: Math.max(5, parseInt(e.target.value, 10) || 5) }))} className="w-16 p-1 glass-input rounded-lg text-center text-xs" />
                  </div>
                </div>
                <button onClick={() => onOpenGame(stage.type)} disabled={isOpeningRoom} className={`w-full py-2.5 disabled:opacity-50 font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg transition ${stage.btn}`}>
                  <Icon size={14} /> {isOpeningRoom ? 'Membuka...' : `Luncurkan`}
                </button>
              </div>
            );
          })}
        </div>
        <button onClick={onSaveGame5RPreset} disabled={isSavingGame5RPreset} className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-white font-bold rounded-xl flex items-center gap-2 text-xs border border-white/10 transition">
          <Save size={14} /> Simpan Preset Durasi 5R
        </button>

        {/* SKD SECTION */}
        <h4 className="text-xs font-black text-indigo-300/80 uppercase tracking-widest mt-10 mb-4">SKD CPNS</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SKD_ORDER.map(key => {
            const meta = SKD_META[key];
            const Icon = meta.icon;
            const accent = SKD_ACCENTS[meta.accent];
            const count = (skdQuestions?.[key] || []).length;
            return (
              <div key={key} className={`p-5 rounded-2xl flex flex-col justify-between border ${accent.card}`}>
                <div className="mb-4">
                  <span className={`font-black text-[10px] px-2 py-1 rounded-md ${accent.badge}`}>{meta.label}</span>
                  <h3 className="text-lg font-black text-white mt-3">{meta.nama}</h3>
                  <p className="text-xs text-white/70 mt-2 font-medium">{count} Soal Tersedia</p>
                  <div className="flex items-center justify-between gap-2 mt-4 bg-black/20 p-2 rounded-xl">
                    <label className="text-[11px] font-bold text-white/80"><Timer size={12} className="inline mr-1"/> Menit</label>
                    <input type="number" min={1} max={180} value={skdDurations[key]} onChange={e => setSkdDurations(prev => ({ ...prev, [key]: Math.max(1, parseInt(e.target.value, 10) || 1) }))} className="w-16 p-1 glass-input rounded-lg text-center text-xs" />
                  </div>
                </div>
                <button onClick={() => onOpenGame(meta.quizType)} disabled={isOpeningRoom || count === 0} className={`w-full py-2.5 disabled:opacity-50 font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg transition ${accent.btn}`}>
                  <Icon size={14} /> Luncurkan
                </button>
              </div>
            );
          })}
        </div>

        {/* REGULAR QUIZ SECTION */}
        <h4 className="text-xs font-black text-indigo-300/80 uppercase tracking-widest mt-10 mb-4">Kuis Pilihan Ganda</h4>
        <div className="p-5 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-white">Kuis Pilihan Ganda</h3>
            <p className="text-xs text-emerald-100/70 mt-1">{questionsList.length} Soal siap diuji.</p>
          </div>
          <button onClick={() => onOpenGame('standard')} disabled={isOpeningRoom || questionsList.length === 0} className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg transition">
            <Play size={16} /> Luncurkan Kuis
          </button>
        </div>
      </div>

      {/* SECTION: BANK SOAL TERKUMPUL */}
      <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/10 shadow-lg">
        <div className="flex items-center gap-3 mb-6 border-b border-white/10 pb-4">
          <BookOpen className="text-indigo-300" size={24} />
          <h2 className="text-xl font-bold text-white">Koleksi Bank Soal</h2>
        </div>

        {!sheetStorageReady && (
          <p className="text-amber-200 bg-amber-900/30 border border-amber-500/30 p-4 rounded-xl text-sm mb-6">
            Database belum terhubung (VITE_SHEETS_API_URL).
          </p>
        )}
        {loading && <p className="text-indigo-300 text-sm mb-4 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Memuat...</p>}

        {!loading && sorted.length === 0 && (
          <p className="text-indigo-300/50 text-sm text-center py-10">Koleksi bank soal masih kosong.</p>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          {sorted.map(set => {
            const isGame5R = set.type === 'game5r';
            const isSkd = typeof set.type === 'string' && set.type.startsWith('skd-');
            
            return (
              <div key={set.id} className="p-5 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 transition flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded bg-indigo-500/30 text-indigo-200">
                      {isGame5R ? 'PRESET 5R' : isSkd ? set.type.toUpperCase() : 'PILIHAN GANDA'}
                    </span>
                    <span className="text-xs text-white/40">{formatTanggal(set.createdAt)}</span>
                  </div>
                  <h3 className="font-bold text-white text-lg truncate">{set.judul}</h3>
                  <p className="text-xs text-indigo-200/70 mt-1">
                    {isGame5R ? 'Durasi tersimpan' : `${(set.questions || []).length} Soal`}
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-5">
                  <button onClick={() => onLoad(set)} className="flex-1 px-3 py-2 bg-indigo-500/20 hover:bg-indigo-500/40 border border-indigo-500/30 text-indigo-100 text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition">
                    <Upload size={14} /> Muat ke Setup
                  </button>
                  <button onClick={() => onDelete(set.id)} className="px-3 py-2 bg-red-500/20 hover:bg-red-500/40 border border-red-500/30 text-red-200 rounded-xl transition">
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
