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
  interimText: '',
  transcripts: [],
  panelOpen: false,
  wsSupported: false,
  selectMode: false,
  selectedIds: new Set(),
};

const STORAGE_KEY = 'vc_transcripts_v2';
const SETTINGS_KEY = 'vc_settings_v1';
const CALL_CHUNK_MS = 180_000; // 3-Minuten-Abschnitte – mehr Kontext für Whisper

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
  saveBtn:     $('saveBtn'),
  exportBtn:   $('exportBtn'),
  importBtn:   $('importBtn'),
  importInput: $('importInput'),
  clearAllBtn: $('clearAllBtn'),
  panelActions: $('panelActions'),
  selectBar:   $('selectBar'),
  selectCount: $('selectCount'),
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
  // Einmaliger Key-Import via URL: ?key=sk-...
  const urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey && urlKey.startsWith('sk-')) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.whisperKey = urlKey;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    history.replaceState(null, '', location.pathname); // Key aus URL entfernen
  }
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
  call:   { icon: 'ti-phone',          status: 'Anruf mithören',          hint: 'Anruf auf Lautsprecher → Mikrofon wird verstärkt (Whisper empfohlen)' },
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
  S.interimText = '';
  S.startTime = Date.now();
  S.isRecording = true;
  el.saveBtn.classList.remove('visible');

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

  if (S.mode === 'call' && S.whisperKey.trim()) {
    startCallRecording();
  } else if (S.engine === 'whisper') {
    startMediaRecorder();
  } else {
    if (S.mode === 'call') {
      showToast('Tipp: Mit Whisper API Key wird der Anrufer besser erfasst');
    }
    startWebSpeech();
  }
}

function stopRecording() {
  S.isRecording = false;
  clearInterval(S.timerInterval);
  clearTimeout(S._callChunkTimer);

  el.micBtnMain.className = 'mic-btn-main ready';
  el.micIcon.className = `ti ${MODE_META[S.mode].icon}`;
  el.micRingOuter.className = 'mic-ring-outer';
  el.recStatus.textContent = MODE_META[S.mode].status;
  el.recTimer.style.display = 'none';

  if (S.recognition) {
    S.recognition.onend = null;
    S.recognition.stop();
    S.recognition = null;
    if (S.interimText) {
      S.finalText += S.interimText;
      S.interimText = '';
      el.liveBox.innerHTML = `<span class="final">${esc(S.finalText)}</span>`;
    }
    showSaveButton('webspeech');
  }
  if (S._mediaRecorder && S._mediaRecorder.state !== 'inactive') {
    S._mediaRecorder.stop();
    // Für Anruf-Modus: save button wird nach finaler Chunk-Transkription gezeigt
  }

  // Anruf-Aufnahme-Ressourcen freigeben
  if (S._rawStream) {
    S._rawStream.getTracks().forEach(t => t.stop());
    S._rawStream = null;
  }
  if (S._systemStream) {
    S._systemStream.getTracks().forEach(t => t.stop());
    S._systemStream = null;
  }
  if (S._audioCtx) {
    S._audioCtx.close().catch(() => {});
    S._audioCtx = null;
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
    S.interimText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) S.finalText += e.results[i][0].transcript + ' ';
      else S.interimText += e.results[i][0].transcript;
    }
    el.liveBox.innerHTML =
      (S.finalText ? `<span class="final">${esc(S.finalText)}</span>` : '') +
      (S.interimText ? `<span class="interim">${esc(S.interimText)}</span>` : '');
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

// ── Anruf-Aufnahme ────────────────────────────────────────────────────────
async function startCallRecording() {
  try {
    const ctx = new AudioContext();
    S._audioCtx = ctx;
    const dest = ctx.createMediaStreamDestination();

    // Desktop: System-Audio direkt abgreifen (YouTube, Medien, Anrufe über PC)
    const isDesktop = !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isDesktop && navigator.mediaDevices.getDisplayMedia) {
      try {
        el.recStatus.textContent = 'Audio-Quelle auswählen…';
        const sysStream = await navigator.mediaDevices.getDisplayMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: { width: 1, height: 1 },
        });
        sysStream.getVideoTracks().forEach(t => t.stop());
        S._systemStream = sysStream;
        if (sysStream.getAudioTracks().length > 0) {
          const sysSource = ctx.createMediaStreamSource(sysStream);
          const sysGain = ctx.createGain();
          sysGain.gain.value = 2.0;
          sysSource.connect(sysGain);
          sysGain.connect(dest);
        }
      } catch(e) {
        // Nutzer hat abgebrochen – weiter mit Mikrofon
      }
    }

    // Mikrofon: eigene Stimme + akustisches Umgebungsaudio (inkl. Lautsprecher)
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
      }
    });
    S._rawStream = micStream;
    buildMicChain(ctx, micStream, dest);

    S._boostedStream = dest.stream;
    S._callTranscript = '';
    S._callChunkNum = 0;
    el.recStatus.textContent = 'Aufnahme läuft…';
    startCallChunk();
  } catch(e) {
    showToast('Mikrofon-Zugriff verweigert');
    stopRecording();
  }
}

function buildMicChain(ctx, stream, dest) {
  const source = ctx.createMediaStreamSource(stream);

  // Rumpeln unter 80 Hz entfernen
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;

  // Sprachpräsenz boosten (+7 dB bei 2,5 kHz)
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2500;
  presence.gain.value = 7;
  presence.Q.value = 0.7;

  // Kompressor: laute/leise Passagen und schnelle Sprache angleichen
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -30;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.2;

  // Make-up-Gain
  const gain = ctx.createGain();
  gain.gain.value = 5.0;

  source.connect(highpass);
  highpass.connect(presence);
  presence.connect(compressor);
  compressor.connect(gain);
  gain.connect(dest);
}

function startCallChunk() {
  if (!S.isRecording) return;

  S._callChunkNum++;
  const chunkNum = S._callChunkNum;
  const chunks = [];

  const recorder = new MediaRecorder(S._boostedStream, { mimeType: getSupportedMime() });
  S._mediaRecorder = recorder;

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  recorder.onstop = async () => {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    await transcribeCallChunk(blob, chunkNum, !S.isRecording);
  };

  recorder.start(1000);

  S._callChunkTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
    startCallChunk();
  }, CALL_CHUNK_MS);
}

async function transcribeCallChunk(blob, chunkNum, isFinal = false) {
  const key = S.whisperKey.trim();
  if (!key) return;

  if (isFinal) {
    el.recStatus.textContent = 'Letzter Abschnitt wird transkribiert…';
  } else if (S.isRecording) {
    el.recStatus.textContent = `Abschnitt ${chunkNum} wird transkribiert…`;
  }

  const form = new FormData();
  form.append('file', blob, `chunk${chunkNum}.webm`);
  form.append('model', 'whisper-1');
  form.append('language', 'de');
  form.append('prompt', 'Telefonat auf Lautsprecher. Umgangssprache, Dialekt und schnelle Sprache möglich. Wörter vollständig transkribieren.');

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const data = await res.json();
    if (data.text && data.text.trim()) {
      S._callTranscript = (S._callTranscript ? S._callTranscript + ' ' : '') + data.text.trim();
      S.finalText = S._callTranscript;
      el.liveBox.style.display = 'block';
      el.liveBox.innerHTML = `<span class="final">${esc(S._callTranscript)}</span>`;
      el.liveBox.scrollTop = el.liveBox.scrollHeight;
    }
  } catch(e) {
    // Netzwerkfehler nicht anzeigen – Aufnahme läuft weiter
  } finally {
    if (S.isRecording) {
      el.recStatus.textContent = 'Aufnahme läuft…';
    } else if (isFinal) {
      el.recStatus.textContent = MODE_META[S.mode].status;
    }
  }

  if (isFinal && S.finalText.trim()) {
    showSaveButton('whisper');
  }
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
      showSaveButton('whisper');
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

// ── Save Button ───────────────────────────────────────────────────────────
function showSaveButton(engine) {
  const text = S.finalText.trim();
  if (!text) { showToast('Keine Sprache erkannt'); return; }
  S._pendingEngine = engine;
  el.saveBtn.classList.add('visible');
}

function manualSave() {
  finalize(S._pendingEngine || 'webspeech');
  el.saveBtn.classList.remove('visible');
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
  el.panelActions.classList.toggle('visible', S.panelOpen && S.transcripts.length > 0 && !S.selectMode);

  if (!S.transcripts.length) {
    el.transList.innerHTML = '<div class="empty-trans">Noch keine Aufnahmen</div>';
    return;
  }

  el.transList.innerHTML = S.transcripts.map(t => {
    const sel = S.selectedIds.has(t.id);
    return `
      <div class="t-card${S.selectMode ? ' selectable' : ''}${sel ? ' selected' : ''}" id="tc-${t.id}"
           ${S.selectMode ? `onclick="toggleCardSelect(${t.id})"` : ''}>
        ${S.selectMode ? `<div class="t-select-cb">${sel ? '✓' : ''}</div>` : ''}
        ${t.title ? `<div class="t-title">${esc(t.title)}</div>` : ''}
        <div class="t-meta">
          <span class="t-date">${fmtDate(t.date)}</span>
          <span class="t-dur">${fmtDur(t.duration)}</span>
          <span class="t-mode ${t.engine}">${t.engine === 'whisper' ? 'Whisper' : 'Live'} · ${fmtMode(t.mode)}</span>
        </div>
        <div class="t-text ${t.expanded ? 'expanded' : ''}" id="tt-${t.id}">${esc(t.text)}</div>
        ${!S.selectMode ? `<div class="t-actions">
          <button class="t-btn send" onclick="copyAndSend(${t.id})">↗ An Claude</button>
          <button class="t-btn" onclick="copyOnly(${t.id})">⎘ Kopieren</button>
          <button class="t-btn" onclick="renameT(${t.id})">✎ Umbenennen</button>
          <button class="t-btn" onclick="toggleExpand(${t.id})">${t.expanded ? '▲ Weniger' : '▼ Mehr'}</button>
          <button class="t-btn del" onclick="deleteT(${t.id})">✕</button>
        </div>` : ''}
      </div>
    `;
  }).join('');
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
  if (!S.panelOpen && S.selectMode) {
    S.selectMode = false;
    S.selectedIds.clear();
    el.selectBar.classList.remove('visible');
  }
  el.panelActions.classList.toggle('visible', S.panelOpen && S.transcripts.length > 0 && !S.selectMode);
}

// ── Auswählen & Zusammenführen ─────────────────────────────────────────────
function toggleSelectMode() {
  S.selectMode = !S.selectMode;
  S.selectedIds.clear();
  el.selectBar.classList.toggle('visible', S.selectMode);
  el.selectCount.textContent = '0 ausgewählt';
  el.panelActions.classList.toggle('visible', !S.selectMode && S.panelOpen && S.transcripts.length > 0);
  renderTranscripts();
}

function toggleCardSelect(id) {
  if (S.selectedIds.has(id)) S.selectedIds.delete(id);
  else S.selectedIds.add(id);
  el.selectCount.textContent = S.selectedIds.size + ' ausgewählt';
  const card = $('tc-' + id);
  const sel = S.selectedIds.has(id);
  card.classList.toggle('selected', sel);
  const cb = card.querySelector('.t-select-cb');
  if (cb) cb.textContent = sel ? '✓' : '';
}

function mergeSelected() {
  if (S.selectedIds.size < 2) { showToast('Mindestens 2 Einträge auswählen'); return; }
  const selected = S.transcripts
    .filter(t => S.selectedIds.has(t.id))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const merged = {
    id: Date.now(),
    title: selected[0].title || '',
    text: selected.map(t => t.text).join('\n\n'),
    date: new Date().toISOString(),
    duration: selected.reduce((sum, t) => sum + (t.duration || 0), 0),
    mode: selected[0].mode,
    engine: selected[0].engine,
    expanded: false,
  };

  S.transcripts = S.transcripts.filter(t => !S.selectedIds.has(t.id));
  S.transcripts.unshift(merged);
  S.selectedIds.clear();
  S.selectMode = false;
  el.selectBar.classList.remove('visible');
  saveTranscriptsStore();
  renderTranscripts();
  showToast(selected.length + ' Transkripte zusammengeführt');
}

function copyAllTranscripts() {
  if (!S.transcripts.length) { showToast('Keine Transkripte vorhanden'); return; }
  const text = [...S.transcripts]
    .reverse()
    .map(t => `[${fmtDate(t.date)} · ${fmtMode(t.mode)}]\n${t.text}`)
    .join('\n\n---\n\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('Alle ' + S.transcripts.length + ' Transkripte kopiert'))
    .catch(() => { fallbackCopy(text); showToast('Alle kopiert'); });
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
  el.saveBtn.addEventListener('click', manualSave);
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
