/**
 * =============================================================================
 * JEMBATAN SPREADSHEET UNTUK "KUIS & GAME 5R AI"
 * -----------------------------------------------------------------------------
 * Script ini WAJIB di-deploy sebagai "Web App" langsung dari dalam spreadsheet
 * login Pemateri yang sama (kolom A = email, kolom B = password), supaya
 * fitur Bank Soal & Riwayat Kuis di aplikasi bisa membaca & menulis data.
 *
 * CARA PASANG (lihat juga README.md):
 *   1. Buka spreadsheet login Pemateri di Google Sheets.
 *   2. Menu Extensions -> Apps Script.
 *   3. Hapus semua kode contoh yang ada, ganti dengan SELURUH isi file ini.
 *   4. Klik Deploy -> New deployment -> pilih ikon gear -> "Web app".
 *        - Description: bebas, mis. "Kuis 5R Bridge"
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Klik Deploy, izinkan permission yang diminta (punya akun sendiri).
 *   6. Salin URL yang berakhiran ".../exec" -> tempel sebagai Environment
 *      Variable VITE_SHEETS_API_URL di Vercel (atau file .env lokal).
 *   7. Kalau nanti kode ini diubah lagi, harus bikin "New deployment" lagi
 *      (atau Manage deployments -> Edit -> versi baru) supaya perubahannya
 *      benar-benar aktif di URL yang sama.
 *
 * CARA KERJA PENYIMPANAN:
 *   - Data Bank Soal + Riwayat Kuis milik satu guru digabung jadi satu teks
 *     JSON, lalu dipotong-potong (maksimal ~45.000 karakter per sel, sedikit
 *     di bawah batas 50.000 karakter/sel Google Sheets) dan ditulis mulai
 *     dari KOLOM C pada baris email guru tersebut, meluber ke kolom D, E, F,
 *     dst sesuai kebutuhan.
 *   - JANGAN mengedit manual sel-sel di kolom C dan seterusnya, karena bisa
 *     merusak data tersimpan (aplikasi akan menimpa ulang seluruh kolom itu
 *     setiap kali menyimpan).
 * =============================================================================
 */

var START_COLUMN = 3;   // Kolom C (A=email, B=password)
var MAX_COLUMNS = 60;   // Batas kolom yang boleh dipakai untuk 1 baris guru
var CHUNK_SIZE = 45000; // Karakter per sel (aman di bawah batas 50.000 Sheets)

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    var params = parseParams(e);
    var action = params.action;
    var email = normalizeEmail(params.email);

    if (!email) return jsonOutput({ ok: false, error: 'Parameter email wajib diisi.' });

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var rowIndex = findRowByEmail(sheet, email);

    if (rowIndex === -1) {
      return jsonOutput({ ok: false, error: 'Email tidak ditemukan di spreadsheet login.' });
    }

    if (action === 'load') {
      return jsonOutput({ ok: true, data: readRowData(sheet, rowIndex) });
    }

    if (action === 'save') {
      var content = (params.data || '').toString();
      writeRowData(sheet, rowIndex, content);
      return jsonOutput({ ok: true });
    }

    return jsonOutput({ ok: false, error: 'Parameter action tidak dikenali (gunakan "load" atau "save").' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function parseParams(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      // Bukan JSON valid -> lanjut coba baca dari query string di bawah
    }
  }
  var out = {};
  if (e && e.parameter) {
    for (var key in e.parameter) out[key] = e.parameter[key];
  }
  return out;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function findRowByEmail(sheet, email) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return -1;
  var colA = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    var cell = normalizeEmail(colA[i][0]);
    if (cell && cell === email) return i + 1; // baris di Sheets dimulai dari 1
  }
  return -1;
}

function readRowData(sheet, rowIndex) {
  var values = sheet.getRange(rowIndex, START_COLUMN, 1, MAX_COLUMNS).getValues()[0];
  var chunks = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === '' || v === null || v === undefined) break;
    chunks.push(v.toString());
  }
  return chunks.join('');
}

function writeRowData(sheet, rowIndex, content) {
  var chunks = [];
  for (var pos = 0; pos < content.length; pos += CHUNK_SIZE) {
    chunks.push(content.substring(pos, pos + CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks = [''];

  if (chunks.length > MAX_COLUMNS) {
    throw new Error(
      'Data Bank Soal & Riwayat Kuis sudah terlalu besar untuk disimpan (melebihi ' +
      MAX_COLUMNS + ' kolom). Hapus sebagian riwayat/bank soal lama lalu coba lagi.'
    );
  }

  // Kosongkan dulu seluruh kolom C..(C+MAX_COLUMNS-1) di baris ini supaya
  // tidak ada sisa data lama nyangkut di kolom-kolom yang tidak dipakai lagi.
  sheet.getRange(rowIndex, START_COLUMN, 1, MAX_COLUMNS).clearContent();
  sheet.getRange(rowIndex, START_COLUMN, 1, chunks.length).setValues([chunks]);
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
