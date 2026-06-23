'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  mode: 'direct',        // direct | call | video | upload
  engine: 'webspeech',   // webspeech | whisper
  whisperKey: '',
  isRecording: false,
  startTime: null,
  timerInterval: null,
  recognition: null,
  finalText: '',
  transcripts: [],
  panelOpen: false,
  wsSupported: false,
};

const STORAGE_KEY = 'vc_transcripts_v2';
const SETTINGS_KEY = 'vc_settings_v1';

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  warnBar:     $('warnBar'),
  modeBtns:    document.querySelectorAll('.mode-btn'),
  micRingOuter: $('micRingOuter'),
  micBtnMain:  $('micBtnMain'),
  micIcon:     $('micIcon'),
  recStatus:   $('recStatus'),
  recTimer:    $('recTimer'),
  recHint:     $('recHint'),
  liveBox:     $('liveBox'),
  uploadZone:  $('uploadZone'),
  fileInput:   $('fileInput'),
  whisperBar:  $('whisperBar'),
  panelHeader: $('panelHeader'),
  panelToggle: $('panelToggle'),
  transScroll: $('transScroll'),
  transBadge:  $('transBadge'),
  transList:   $('transList'),
  toast:       $('toast'),
  settingsBtn: $('settingsBtn'),
  sheetOverlay: $('sheetOverlay'),
  engToggle:   $('engToggle'),
  keyRow:      $('keyRow'),
  whisperKeyInput: $('whisperKeyInput'),
  whisperKeyInline: $('whisperKeyInlineInput'),
  exportBtn:   $('exportBtn'),
  importBtn:   $('importBtn'),
  importInput: $('importInput'),
  clearAllBtn: $('clearAllBtn'),
};

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  loadSettings();
  loadTranscripts();
  checkSupport();
  bindEvents();
  renderTranscripts();
  setMode('direct');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function checkSupport() {
  S.wsSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!S.wsSupported && S.engine === 'webspeech') {
    el.warnBar.style.display = 'block';
  }
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.engine) S.engine = s.engine;
    if (s.whisperKey) S.whisperKey = s.whisperKey;
  } catch(e) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ engine: S.engine, whisperKey: S.whisperKey }));
}

function loadTranscripts() {
  try {
    S.transcripts = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch(e) { S.transcripts = []; }
}

function saveTranscriptsStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(S.transcripts));
}

// ── Mode ───────────────────────────────────────────────────────────────────
const MODE_META = {
  direct: { icon: 'ti-microphone',     status: 'Direkt aufnehmen',       hint: 'Tippen zum Starten' },
  call:   { icon: 'ti-phone',          status: 'Anruf mithören',          hint: 'Anruf auf Lautsprecher stellen, dann aufnehmen' },
  video:  { icon: 'ti-device-tv',      status: 'Video/Audio aufnehmen',   hint: 'Gerät auf Lautsprecher – Mikrofon hört mit' },
  upload: { icon: 'ti-upload',         status: 'Datei transkribieren',    hint: 'MP3, M4A, WAV, MP4 – benötigt Whisper API Key' },
};

function setMode(mode) {
  S.mode = mode;
  el.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  const meta = MODE_META[mode];
  el.micIcon.className = `ti ${meta.icon}`;
  el.recStatus.textContent = meta.status;
  el.recHint.textContent = meta.hint;

  el.uploadZone.style.display = mode === 'upload' ? 'block' : 'none';
  const isUpload = mode === 'upload';
  el.micRingOuter.style.display = isUpload ? 'none' : 'flex';
  el.micBtnMain.style.display = isUpload ? 'none' : 'flex';
  el.recTimer.style.display = 'none';
  el.liveBox.style.display = 'none';

  el.whisperBar.style.display = (isUpload || S.engine === 'whisper') ? 'flex' : 'none';
}

// ── Recording ──────────────────────────────────────────────────────────────
function toggleRecording() {
  if (S.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (!S.wsSupported && S.engine === 'webspeech') {
    showToast('Web Speech nicht verfügbar – bitte Chrome/Edge verwenden');
    return;
  }

  S.finalText = '';
  S.startTime = Date.now();
  S.isRecording = true;

  el.micBtnMain.className = 'mic-btn-main recording';
  el.micIcon.className = 'ti ti-square-rounded-filled';
  el.micRingOuter.className = 'mic-ring-outer recording';
  el.recStatus.textContent = 'Aufnahme läuft…';
  el.recTimer.style.display = 'block';
  el.liveBox.style.display = 'block';
  el.liveBox.innerHTML = '<span class="interim">Warte auf Sprache…</span>';

  S.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - S.startTime) / 1000);
    el.recTimer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 500);

  if (S.engine === 'whisper') {
    startMediaRecorder();
  } else {
    startWebSpeech();
  }
}

function stopRecording() {
  S.isRecording = false;
  clearInterval(S.timerInterval);

  el.micBtnMain.className = 'mic-btn-main ready';
  el.micIcon.className = `ti ${MODE_META[S.mode].icon}`;
  el.micRingOuter.className = 'mic-ring-outer';
  el.recStatus.textContent = MODE_META[S.mode].status;
  el.recTimer.style.display = 'none';

  if (S.recognition) {
    S.recognition.onend = null;
    S.recognition.stop();
    S.recognition = null;
    finalize('webspeech');
  }
  if (S._mediaRecorder && S._mediaRecorder.state !== 'inactive') {
    S._mediaRecorder.stop();
  }
}

// ── Web Speech ─────────────────────────────────────────────────────────────
function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  S.recognition = new SR();
  S.recognition.lang = 'de-DE';
  S.recognition.continuous = true;
  S.recognition.interimResults = true;

  S.recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) S.finalText += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    el.liveBox.innerHTML =
      (S.finalText ? `<span class="final">${esc(S.finalText)}</span>` : '') +
      (interim ? `<span class="interim">${esc(interim)}</span>` : '');
    el.liveBox.scrollTop = el.liveBox.scrollHeight;
  };

  S.recognition.onerror = e => {
    const msgs = {
      'not-allowed': 'Mikrofon-Zugriff verweigert',
      'no-speech': 'Keine Sprache erkannt – bitte lauter sprechen',
      'audio-capture': 'Kein Mikrofon gefunden',
      'network': 'Netzwerkfehler bei Spracherkennung',
      'aborted': 'Spracherkennung abgebrochen',
    };
    showToast(msgs[e.error] || `Fehler: ${e.error}`);
    if (e.error !== 'no-speech') stopRecording();
  };

  S.recognition.onend = () => {
    if (S.isRecording) S.recognition.start();
    else { S.recognition = null; finalize('webspeech'); }
  };

  S.recognition.start();
}

// ── MediaRecorder → Whisper ────────────────────────────────────────────────
function startMediaRecorder() {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      const chunks = [];
      S._stream = stream;
      S._mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMime() });
      S._mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      S._mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: S._mediaRecorder.mimeType });
        transcribeWhisper(blob);
      };
      S._mediaRecorder.start(1000);
    })
    .catch(() => { showToast('Mikrofon-Zugriff verweigert'); stopRecording(); });
}

function getSupportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function transcribeWhisper(blob, filename = 'recording.webm') {
  const key = S.whisperKey.trim();
  if (!key) { showToast('Bitte Whisper API Key in Einstellungen eingeben'); return; }

  el.recStatus.textContent = 'Transkribiere mit Whisper…';
  el.micBtnMain.className = 'mic-btn-main processing';
  el.micIcon.className = 'ti ti-loader-2';

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  form.append('language', 'de');

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
    });
    const data = await res.json();
    if (data.error) {
      showToast('Fehler: ' + (data.error.message || 'Unbekannt'));
    } else if (data.text && data.text.trim()) {
      S.finalText = data.text;
      el.liveBox.style.display = 'block';
      el.liveBox.innerHTML = `<span class="final">${esc(data.text)}</span>`;
      finalize('whisper');
    } else {
      showToast('Keine Sprache erkannt');
    }
  } catch(e) {
    showToast('Netzwerkfehler bei Whisper');
  } finally {
    el.micBtnMain.className = 'mic-btn-main ready';
    el.micIcon.className = `ti ${MODE_META[S.mode].icon}`;
    el.recStatus.textContent = MODE_META[S.mode].status;
  }
}

// ── File Upload → Whisper ─────────────────────────────────────────────────
function handleFileUpload(file) {
  if (!file) return;
  const key = S.whisperKey.trim();
  if (!key) { showToast('Bitte Whisper API Key eingeben'); return; }
  showToast('Datei wird verarbeitet…');
  const reader = new FileReader();
  reader.onerror = () => showToast('Datei konnte nicht gelesen werden');
  reader.onload = async () => {
    const blob = new Blob([reader.result], { type: file.type });
    await transcribeWhisper(blob, file.name);
  };
  reader.readAsArrayBuffer(file);
  el.fileInput.value = '';
}

// ── Finalize transcript ────────────────────────────────────────────────────
function finalize(engine) {
  const text = S.finalText.trim();
  if (!text) { showToast('Keine Sprache erkannt'); return; }

  const entry = {
    id: Date.now(),
    title: '',
    text,
    date: new Date().toISOString(),
    duration: S.startTime ? Date.now() - S.startTime : 0,
    mode: S.mode,
    engine,
    expanded: false,
  };
  S.transcripts.unshift(entry);
  saveTranscriptsStore();
  renderTranscripts();
  if (!S.panelOpen) togglePanel();
  showToast('Transkript gespeichert ✓');
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderTranscripts() {
  el.transBadge.textContent = S.transcripts.length;
  if (!S.transcripts.length) {
    el.transList.innerHTML = '<div class="empty-trans">Noch keine Aufnahmen</div>';
    return;
  }

  el.transList.innerHTML = S.transcripts.map(t => `
    <div class="t-card" id="tc-${t.id}">
      ${t.title ? `<div class="t-title">${esc(t.title)}</div>` : ''}
      <div class="t-meta">
        <span class="t-date">${fmtDate(t.date)}</span>
        <span class="t-dur">${fmtDur(t.duration)}</span>
        <span class="t-mode ${t.engine}">${t.engine === 'whisper' ? 'Whisper' : 'Live'} · ${fmtMode(t.mode)}</span>
      </div>
      <div class="t-text ${t.expanded ? 'expanded' : ''}" id="tt-${t.id}">${esc(t.text)}</div>
      <div class="t-actions">
        <button class="t-btn send" onclick="copyAndSend(${t.id})">↗ An Claude</button>
        <button class="t-btn" onclick="copyOnly(${t.id})">⎘ Kopieren</button>
        <button class="t-btn" onclick="renameT(${t.id})">✎ Umbenennen</button>
        <button class="t-btn" onclick="toggleExpand(${t.id})">${t.expanded ? '▲ Weniger' : '▼ Mehr'}</button>
        <button class="t-btn del" onclick="deleteT(${t.id})">✕</button>
      </div>
    </div>
  `).join('');
}

// ── Actions ────────────────────────────────────────────────────────────────
function copyAndSend(id) {
  const t = S.transcripts.find(x => x.id === id);
  if (!t) return;
  const msg = `Bitte verarbeite folgendes Transkript (${fmtMode(t.mode)}, ${fmtDate(t.date)}):\n\n${t.text}`;
  if (window.sendPrompt) {
    window.sendPrompt(msg);
  } else {
    navigator.clipboard.writeText(msg).catch(() => {}).then(() => showToast('In Zwischenablage – in Claude einfügen'));
  }
}

function copyOnly(id) {
  const t = S.transcripts.find(x => x.id === id);
  if (!t) return;
  navigator.clipboard.writeText(t.text)
    .then(() => showToast('Kopiert!'))
    .catch(() => { fallbackCopy(t.text); showToast('Kopiert!'); });
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function toggleExpand(id) {
  const t = S.transcripts.find(x => x.id === id);
  if (t) { t.expanded = !t.expanded; renderTranscripts(); }
}

function renameT(id) {
  const t = S.transcripts.find(x => x.id === id);
  if (!t) return;
  const name = prompt('Titel eingeben:', t.title || '');
  if (name === null) return;
  t.title = name.trim();
  saveTranscriptsStore();
  renderTranscripts();
  if (t.title) showToast('Umbenannt');
}

function deleteT(id) {
  S.transcripts = S.transcripts.filter(x => x.id !== id);
  saveTranscriptsStore();
  renderTranscripts();
  showToast('Gelöscht');
}

// ── Panel ──────────────────────────────────────────────────────────────────
function togglePanel() {
  S.panelOpen = !S.panelOpen;
  el.transScroll.classList.toggle('open', S.panelOpen);
  el.panelToggle.classList.toggle('open', S.panelOpen);
}

// ── Settings Sheet ─────────────────────────────────────────────────────────
function openSettings() {
  el.engToggle.className = 'toggle' + (S.engine === 'whisper' ? ' on' : '');
  el.keyRow.style.display = S.engine === 'whisper' ? 'block' : 'none';
  el.whisperKeyInput.value = S.whisperKey;
  el.sheetOverlay.classList.add('open');
}

function closeSettings() {
  S.whisperKey = el.whisperKeyInput.value.trim();
  saveSettings();
  el.sheetOverlay.classList.remove('open');
  setMode(S.mode);
}

// ── Backup ────────────────────────────────────────────────────────────────
function exportBackup() {
  const backup = {
    version: 2,
    date: new Date().toISOString(),
    settings: { engine: S.engine, whisperKey: S.whisperKey },
    transcripts: S.transcripts,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `VoiceCapture-Backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup exportiert');
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => showToast('Datei konnte nicht gelesen werden');
  reader.onload = () => {
    try {
      const backup = JSON.parse(reader.result);
      if (!backup.transcripts || !Array.isArray(backup.transcripts)) {
        showToast('Ungültiges Backup-Format');
        return;
      }
      if (backup.settings) {
        if (backup.settings.engine) S.engine = backup.settings.engine;
        if (backup.settings.whisperKey) S.whisperKey = backup.settings.whisperKey;
        saveSettings();
      }
      S.transcripts = backup.transcripts;
      saveTranscriptsStore();
      renderTranscripts();
      closeSettings();
      showToast(backup.transcripts.length + ' Transkripte importiert');
    } catch (e) {
      showToast('Backup-Datei ist fehlerhaft');
    }
  };
  reader.readAsText(file);
  el.importInput.value = '';
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), 2500);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) +
    ' ' + d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
}

function fmtDur(ms) {
  if (!ms) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s/60) + ':' + String(s%60).padStart(2,'0') + 'min';
}

function fmtMode(m) {
  return { direct:'Direkt', call:'Anruf', video:'Video', upload:'Upload' }[m] || m;
}

// ── Events ─────────────────────────────────────────────────────────────────
function bindEvents() {
  el.modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  el.micBtnMain.addEventListener('click', toggleRecording);
  el.panelHeader.addEventListener('click', togglePanel);
  el.settingsBtn.addEventListener('click', openSettings);
  el.sheetOverlay.addEventListener('click', e => { if (e.target === el.sheetOverlay) closeSettings(); });

  el.engToggle.addEventListener('click', () => {
    S.engine = S.engine === 'webspeech' ? 'whisper' : 'webspeech';
    el.engToggle.className = 'toggle' + (S.engine === 'whisper' ? ' on' : '');
    el.keyRow.style.display = S.engine === 'whisper' ? 'block' : 'none';
    checkSupport();
  });

  el.exportBtn.addEventListener('click', exportBackup);
  el.importBtn.addEventListener('click', () => el.importInput.click());
  el.importInput.addEventListener('change', e => importBackup(e.target.files[0]));

  el.clearAllBtn.addEventListener('click', () => {
    S.transcripts = [];
    saveTranscriptsStore();
    renderTranscripts();
    closeSettings();
    showToast('Alle gelöscht');
  });

  // Inline whisper key sync
  el.whisperKeyInline.addEventListener('input', () => {
    S.whisperKey = el.whisperKeyInline.value.trim();
    el.whisperKeyInput.value = el.whisperKeyInline.value;
    saveSettings();
  });

  // File upload
  el.uploadZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', e => handleFileUpload(e.target.files[0]));
  el.uploadZone.addEventListener('dragover', e => { e.preventDefault(); el.uploadZone.classList.add('drag'); });
  el.uploadZone.addEventListener('dragleave', () => el.uploadZone.classList.remove('drag'));
  el.uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    el.uploadZone.classList.remove('drag');
    handleFileUpload(e.dataTransfer.files[0]);
  });

  // Keyboard shortcut: Space to toggle recording (desktop)
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body && S.mode !== 'upload') {
      e.preventDefault(); toggleRecording();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
