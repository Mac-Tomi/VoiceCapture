# VoiceCapture – Session 2026-07-02

## Wo wir stehen
Alle Änderungen sind committed und in `js/app.js`, `index.html`, `css/style.css`.

---

## Was heute geändert wurde

### 1. Auto-Speichern (kein manueller Speicher-Button mehr)
- Speicher-Button aus HTML/CSS/JS entfernt
- Transkripte werden jetzt automatisch gespeichert wenn Aufnahme endet

### 2. WebSpeech – nur 2 Wörter Bug gefixt
**Root Cause 1:** `onerror('aborted')` rief `stopRecording()` auf → Chrome wirft 'aborted' wenn Recognition nach `onend` zu schnell neu gestartet wird → Aufnahme stoppte nach erstem Satz-Burst (2-3 Wörter).
**Fix:** Nur `not-allowed` und `audio-capture` stoppen die Aufnahme. 'aborted' und 'no-speech' werden ignoriert, `onend` startet neu.

**Root Cause 2:** `finalize()` wurde synchron nach `stop()` aufgerufen, bevor der Browser die letzten `onresult`-Events geliefert hat.
**Fix:** `finalize('webspeech')` jetzt im `onend`-Callback (feuert NACH dem letzten `onresult`).

**Root Cause 3:** Zu schneller Neustart → 'aborted'-Schleife.
**Fix:** 150ms Delay im `onend` vor `recognition.start()`.

### 3. Video-Modus + Whisper – YouTube-Audio richtig erfassen (ÜBERHOLT, siehe Punkt 5)
**Root Cause:** Video-Modus nutzte nur `startMediaRecorder()` (Mikrofon) → YouTube-Ton kam nur akustisch über Lautsprecher → Mikrofon. Schlechte Qualität, viele Lücken.
**Fix (mittlerweile wieder entfernt):** Video-Modus + Whisper-Key → `startCallRecording()` mit `isVideoMode=true`, System-Audio via `getDisplayMedia`. War technisch sauber, wurde aber im selben Tag wieder rausgenommen (siehe Punkt 5) – Details hier nur noch als Referenz, falls digitale Tab-Audio-Erfassung mal wieder gebraucht wird.

### 4. Call-Modus Race Condition gefixt
- Wenn letzter 60s-Chunk leer war (Stop direkt nach Chunk-Grenze), wurde nie gespeichert
- Fix: Leerer Final-Chunk prüft ob `S.finalText` vorhanden → `finalize()` direkt

### 5. Modi auf "Direktaufnahme" + "Datei" reduziert, robust für 1h+ Gespräche
**Anlass:** Eigentlicher Bedarf ist ein Diktiergerät-Ersatz – ein Button, das alles im Raum aufnimmt (eigene Stimme, Handy auf Lautsprecher, Kundengespräch), auch über 1 Stunde, Ergebnis als durchgehender Text zur Auswertung.

**Entfernt:**
- Modus-Buttons "Anruf" und "Video/Media" raus (index.html + app.js), nur noch **Direktaufnahme** (= alte Anruf-Mikrofon-Kette: EQ + Kompressor + Whisper-Chunking, `buildMicChain`) und **Datei**-Upload.
- Damit auch die `getDisplayMedia`-Tab-Audio-Erfassung (Screen-Share-Dialog) raus – **YouTube-Ton über den Browser-Tab wird jetzt nicht mehr digital erfasst, sondern läuft (falls über Lautsprecher abgespielt) über die normale Mikrofon-Kette wie jede andere Raumquelle.** Qualität dafür etwas schlechter als vorher, aber deutlich einfacher/einheitlicher. Bei Bedarf ließe sich ein separater "Tab-Audio"-Modus wieder ergänzen.
- Settings: "Whisper API verwenden"-Toggle raus – Whisper läuft jetzt automatisch sobald ein API-Key eingetragen ist, ohne Key automatisch WebSpeech-Fallback (nur eigene Stimme, live).

**Robustheit für lange Aufnahmen (Kern des Auftrags):**
- Chunking (60s, `CALL_CHUNK_MS`) bleibt bestehen – nötig wegen Whispers 25MB-Limit pro Request, macht auch mehrstündige Aufnahmen unproblematisch.
- **Retry:** `postWhisperChunk()` versucht bei Netzwerkfehler/HTTP-Fehler jeden Chunk automatisch ein zweites Mal, bevor er als verloren gilt.
- **Lücken-Markierung:** Scheitert ein Chunk trotzdem, wird `[Lücke – Abschnitt konnte nicht transkribiert werden]` in den Text eingefügt statt den Text stillschweigend zu verlieren – wichtig, weil das Transkript danach zur Auswertung weitergegeben wird.
- **Kontext über Chunk-Grenzen:** Die letzten ~200 Zeichen des bisherigen Transkripts gehen als Whisper-`prompt` in den nächsten Chunk, damit Sätze/Namen an den 60s-Grenzen konsistent bleiben.
- **Zwischenspeichern:** `saveDraft()` schreibt nach jedem Chunk den bisherigen Stand in `localStorage` (nicht erst am Ende) – bei Tab-Crash/Schließen während einer 1h+-Aufnahme geht nicht mehr alles verloren. `finalize()` übernimmt den Draft-Eintrag statt ihn zu duplizieren.

---

## Offene Punkte / nächste Schritte
- Noch kein commit gemacht (war keine Anfrage)
- In der App getestet werden sollte: eine wirklich lange Aufnahme (>30min) am Stück, inkl. simuliertem Netzwerkfehler, um Retry/Lücken-Markierung/Zwischenspeichern in der Praxis zu prüfen
- Falls YouTube/Tab-Audio-Transkription in guter Qualität wieder gebraucht wird: separaten Modus mit `getDisplayMedia` erneut ergänzen (Code-Referenz siehe Punkt 3 in der Git-Historie vor diesem Commit)
