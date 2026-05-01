import { noteToMidi, midiToNote, midiToFreq, autoCorrelate } from './audio-utils.js';

const { itemsByGrade } = await import(`./data.js?v=${window.__APP_VERSION__ || Date.now()}`);

let currentGrade = 1;
let currentMode = 'scale';
let currentItem = null;
let sequence = [];
let currentIndex = 0;

let audioCtx = null;
let isPlaying = false;
let stream = null;
let analyser = null;
let rafId = null;
let detected = [];
let lastTime = 0;
let lastNote = null;

let currentTempo = 72;
let learningMode = 'learning';
let playbackMode = 'synth';
let audioUnlocked = false;
let audioUnlockPromise = null;
let sessionRunning = false;
let sessionPaused = false;
let tempoTimer = null;
let countInTimer = null;
let countInActive = false;
let countInResolve = null;
let mobileSecondaryAction = null;

let canvas;
let ctx;

const sampleTokens = new Set([
  'A2', 'A3', 'A4',
  'As1', 'As2', 'As3', 'As4',
  'B1', 'B2', 'B3', 'B4',
  'C2', 'C3', 'C4', 'C5',
  'Cs2', 'Cs3', 'Cs4', 'Cs5',
  'D2', 'D3', 'D4', 'D5',
  'Ds2', 'Ds3', 'Ds4', 'Ds5',
  'E2', 'E3', 'E4', 'E5',
  'F2', 'F3', 'F4',
  'Fs2', 'Fs3', 'Fs4',
  'G2', 'G3', 'G4',
  'Gs2', 'Gs3', 'Gs4',
]);

const sampleBufferCache = new Map();
const sampleTokenMidis = new Map(
  [...sampleTokens].map((token) => [
    token,
    noteToMidi(token.replace('s', '#')),
  ]),
);

function getCurrentTempo() {
  const slider = document.getElementById('tempo-slider');
  if (!slider) return currentTempo;

  const sliderTempo = parseInt(slider.value, 10);
  if (!Number.isNaN(sliderTempo) && sliderTempo > 0) {
    currentTempo = sliderTempo;
  }

  return currentTempo;
}

function syncTempoDisplay() {
  const tempo = getCurrentTempo();
  const valueEl = document.getElementById('tempo-value');
  if (valueEl) valueEl.textContent = tempo;
}

function setTempo(value) {
  const parsedTempo = parseInt(value, 10);
  if (Number.isNaN(parsedTempo) || parsedTempo <= 0) return;

  currentTempo = parsedTempo;

  const slider = document.getElementById('tempo-slider');
  if (slider && slider.value !== String(parsedTempo)) {
    slider.value = String(parsedTempo);
  }

  syncTempoDisplay();

  if (sessionRunning && learningMode === 'performance' && !countInActive) {
    startTempoTimer();
  }
}

function setPlaybackMode(mode) {
  playbackMode = mode;
  ['synth', 'samples'].forEach((name) => {
    document.getElementById(`playback-${name}-btn`)?.setAttribute('data-active', (name === mode).toString());
  });

  if (mode === 'samples') {
    preloadCurrentSequenceSamples().catch(() => {});
  }

  updateAudioBanner();
}

function prefersFlats(note) {
  return typeof note === 'string' && note.includes('b');
}

function isSamePitch(a, b) {
  const valid = /^[A-G](#|b)?-?[0-8]$/;
  if (!valid.test(a || '') || !valid.test(b || '')) return false;
  return noteToMidi(a) === noteToMidi(b);
}

function updateTuner(freq) {
  const noteEl = document.getElementById('tuner-note');
  const needle = document.getElementById('tuner-needle');
  if (!noteEl || !needle) return;

  if (freq < 40) {
    noteEl.textContent = '—';
    needle.style.left = '50%';
    return;
  }

  const midi = 12 * Math.log2(freq / 440) + 69;
  const nearest = Math.round(midi);
  const cents = 1200 * Math.log2(freq / midiToFreq(nearest));
  const preferFlats = prefersFlats(sequence[currentIndex]);

  noteEl.textContent = midiToNote(nearest, preferFlats);

  let pos = 50 + cents;
  pos = Math.max(0, Math.min(100, pos));
  needle.style.left = `${pos}%`;
}

function listen() {
  if (!analyser) {
    rafId = requestAnimationFrame(listen);
    return;
  }

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, audioCtx.sampleRate);

  updateTuner(freq);
  drawPitch(freq);

  if (freq > 40) {
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const exp = sequence[currentIndex];
    const preferFlats = prefersFlats(exp);
    const note = midiToNote(midi, preferFlats);
    document.getElementById('live-pitch').textContent = note;

    const now = Date.now();
    if (note === lastNote && now - lastTime > 180) {
      const correct = isSamePitch(note, exp);
      const displayNote = correct ? exp : note;

      document.getElementById('you-played-live').textContent = displayNote;
      document.getElementById('you-played-live').style.color = correct ? '#10b981' : '#ef4444';

      if (detected.length <= currentIndex) detected[currentIndex] = displayNote;

      if (correct) {
        markNote(currentIndex, true);
        if (learningMode === 'practice') {
          currentIndex = Math.min(currentIndex + 1, sequence.length - 1);
          updateLiveExpected();
          if (currentIndex >= sequence.length - 1) stopSession();
        }
      } else if (learningMode === 'performance') {
        markNote(currentIndex, false);
      }
    } else if (note !== lastNote) {
      lastNote = note;
      lastTime = now;
    }
  } else {
    document.getElementById('live-pitch').textContent = '—';
    document.getElementById('you-played-live').textContent = '—';
  }

  rafId = requestAnimationFrame(listen);
}

function selectGrade(g) {
  currentGrade = g;
  document.querySelectorAll('.grade-btn').forEach((b) => {
    const t = b.textContent.trim();
    const num = t === 'Grade 1' ? 1 : parseInt(t, 10);
    b.dataset.active = (num === g).toString();
  });
  renderItems();
  loadFirstAvailableItem();
}

function setMode(m) {
  currentMode = m;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.dataset.active = (b.id === `mode-${m}`).toString();
  });
  renderItems();
  loadFirstAvailableItem();
}

function setLearningMode(mode) {
  learningMode = mode;
  ['learning', 'practice', 'performance'].forEach((m) => {
    document.getElementById(`${m}-btn`).dataset.active = (m === mode).toString();
  });
  document.getElementById('live-feedback').classList.toggle('hidden', mode === 'learning');
  updateModeUI();
  updateMobileActionBar();
}

function updateModeUI() {
  const container = document.getElementById('mode-dependent-btn');
  container.innerHTML = '';
  const isLearning = learningMode === 'learning';
  const btn = document.createElement('button');
  if (isLearning) {
    btn.onclick = playSequence;
    btn.id = 'btn-play';
    btn.className = 'inline-flex items-center gap-2 px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50';
    btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg> Play';
  } else {
    btn.onclick = toggleSession;
    btn.id = 'btn-session';
    btn.className = 'inline-flex items-center gap-2 px-8 py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl shadow-lg transition-all disabled:opacity-50';
    btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg> <span>Start</span>';
  }
  container.appendChild(btn);
  updateCountInDisplay();
  updateMobileActionBar();
}

function setMobileSecondaryAction(action) {
  mobileSecondaryAction = action;
  updateMobileActionBar();
}

function updateMobileActionBar() {
  const primaryBtn = document.getElementById('mobile-primary-btn');
  const secondaryBtn = document.getElementById('mobile-secondary-btn');
  const titleEl = document.getElementById('mobile-action-title');
  const subtitleEl = document.getElementById('mobile-action-subtitle');
  if (!primaryBtn || !secondaryBtn || !titleEl || !subtitleEl) return;

  titleEl.textContent = currentItem?.name || 'Select an exercise';
  subtitleEl.textContent = currentItem
    ? `Grade ${currentGrade} • ${learningMode === 'learning' ? 'Learning' : learningMode === 'practice' ? 'Practice' : 'Performance'}`
    : 'Choose a grade and exercise to begin';

  primaryBtn.disabled = !currentItem;
  primaryBtn.classList.toggle('opacity-50', !currentItem);

  if (learningMode === 'learning') {
    primaryBtn.textContent = isPlaying ? 'Playing...' : 'Play';
  } else if (sessionRunning) {
    primaryBtn.textContent = 'Pause';
  } else if (sessionPaused) {
    primaryBtn.textContent = 'Resume';
  } else {
    primaryBtn.textContent = 'Start';
  }

  const showSecondary = mobileSecondaryAction !== null;
  secondaryBtn.classList.toggle('hidden', !showSecondary);
  if (showSecondary) {
    secondaryBtn.textContent = mobileSecondaryAction?.label || '';
    secondaryBtn.classList.toggle('bg-orange-600', mobileSecondaryAction?.tone === 'orange');
    secondaryBtn.classList.toggle('hover:bg-orange-500', mobileSecondaryAction?.tone === 'orange');
    secondaryBtn.classList.toggle('bg-slate-700', mobileSecondaryAction?.tone !== 'orange');
    secondaryBtn.classList.toggle('hover:bg-slate-600', mobileSecondaryAction?.tone !== 'orange');
  }
}

function updateAudioBanner() {
  const banner = document.getElementById('audio-banner');
  if (!banner) return;
  const shouldShow = !audioUnlocked;
  banner.classList.toggle('hidden', !shouldShow);
}

function getSampleToken(note) {
  try {
    const sharpNote = midiToNote(noteToMidi(note), false);
    return sharpNote.replace('#', 's');
  } catch {
    return null;
  }
}

function getSampleUrl(note) {
  const token = getSampleToken(note);
  if (!token || !sampleTokens.has(token)) return null;
  return new URL(`../assets/samples/bassoon_${token}_05_forte_normal.mp3`, import.meta.url).href;
}

function getClosestSampleToken(note) {
  const targetMidi = noteToMidi(note);
  const exactToken = getSampleToken(note);
  if (exactToken && sampleTokens.has(exactToken)) {
    return { token: exactToken, playbackRate: 1 };
  }

  let bestToken = null;
  let bestDistance = Infinity;

  sampleTokenMidis.forEach((sampleMidi, token) => {
    const distance = Math.abs(sampleMidi - targetMidi);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestToken = token;
    }
  });

  if (!bestToken) return null;

  const sourceMidi = sampleTokenMidis.get(bestToken);
  return {
    token: bestToken,
    playbackRate: 2 ** ((targetMidi - sourceMidi) / 12),
  };
}

async function getSampleBuffer(url) {
  if (!sampleBufferCache.has(url)) {
    sampleBufferCache.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load sample: ${url}`);
      const arrayBuffer = await response.arrayBuffer();
      return audioCtx.decodeAudioData(arrayBuffer.slice(0));
    })());
  }

  return sampleBufferCache.get(url);
}

async function preloadCurrentSequenceSamples() {
  if (playbackMode !== 'samples' || !sequence.length) return;
  await initAudio();

  const urls = new Set();
  sequence.forEach((note) => {
    const sampleMatch = getClosestSampleToken(note);
    if (!sampleMatch) return;
    urls.add(new URL(`../assets/samples/bassoon_${sampleMatch.token}_05_forte_normal.mp3`, import.meta.url).href);
  });

  await Promise.allSettled([...urls].map((url) => getSampleBuffer(url)));
}

function playSynthNote(note, durationMs) {
  const midi = noteToMidi(note);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const filt = audioCtx.createBiquadFilter();

  osc.type = 'sawtooth';
  filt.type = 'lowpass';
  filt.frequency.value = 800;
  osc.frequency.value = midiToFreq(midi);
  gain.gain.value = 0.28;

  osc.connect(filt).connect(gain).connect(audioCtx.destination);
  osc.start();
  setTimeout(() => {
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.08);
    osc.stop(audioCtx.currentTime + 0.12);
  }, durationMs);
}

async function playSampleNote(note, durationMs) {
  if (!audioCtx) {
    playSynthNote(note, durationMs);
    return;
  }

  const sampleMatch = getClosestSampleToken(note);
  if (!sampleMatch) {
    playSynthNote(note, durationMs);
    return;
  }

  const url = new URL(`../assets/samples/bassoon_${sampleMatch.token}_05_forte_normal.mp3`, import.meta.url).href;

  try {
    const buffer = await getSampleBuffer(url);
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    const attack = 0.01;
    const release = 0.08;
    const sustainTime = Math.max(durationMs / 1000 - attack - release, 0.02);
    const stopTime = now + attack + sustainTime + release;

    source.buffer = buffer;
    source.playbackRate.setValueAtTime(sampleMatch.playbackRate, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.9, now + attack);
    gain.gain.setValueAtTime(0.9, now + attack + sustainTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopTime);

    source.connect(gain).connect(audioCtx.destination);
    source.start(now);
    source.stop(stopTime + 0.01);
  } catch {
    playSynthNote(note, durationMs);
  }
}

async function playSequenceNote(note, durationMs) {
  if (playbackMode === 'samples') {
    await playSampleNote(note, durationMs);
    return;
  }
  playSynthNote(note, durationMs);
}

function renderItems() {
  const cont = document.getElementById('item-list');
  cont.innerHTML = '';
  const modeItems = (itemsByGrade[currentGrade] || []).filter((item) => {
    const categories = item.categories || ['scale'];
    return categories.includes(currentMode);
  });

  if (!modeItems.length) {
    const empty = document.createElement('div');
    empty.className = 'px-4 py-6 bg-slate-800/30 rounded-xl text-slate-400 text-sm';
    empty.textContent = `No ${currentMode} exercises are available for Grade ${currentGrade} yet.`;
    cont.appendChild(empty);
    return;
  }

  modeItems.forEach((item) => {
    const div = document.createElement('div');
    div.className = `px-4 py-3.5 bg-slate-800/60 hover:bg-slate-700/70 rounded-xl cursor-pointer ${currentItem?.name === item.name ? 'ring-2 ring-emerald-500' : ''}`;
    div.innerHTML = `<div class="font-medium">${item.name}</div><div class="text-xs text-slate-500">${item.octaves} oct • ${item.type}</div>`;
    div.onclick = () => loadItem(item);
    cont.appendChild(div);
  });
}

function getModeItems() {
  return (itemsByGrade[currentGrade] || []).filter((item) => {
    const categories = item.categories || ['scale'];
    return categories.includes(currentMode);
  });
}

function clearCurrentItem() {
  currentItem = null;
  sequence = [];
  currentIndex = 0;
  document.getElementById('selected-title').textContent = 'Select an exercise';
  document.getElementById('selected-desc').textContent = '';
  document.getElementById('notes-container').innerHTML = '';
  document.getElementById('results-area').classList.add('hidden');
  updateLiveExpected();
  updateModeUI();
  updateMobileActionBar();
}

function loadFirstAvailableItem() {
  const first = getModeItems()[0];
  if (first) {
    loadItem(first);
    return;
  }
  clearCurrentItem();
}

function loadItem(item) {
  currentItem = item;
  sequence = item.notes || [];
  currentIndex = 0;

  const label = currentMode === 'scale'
    ? 'Scale'
    : currentMode === 'thirds'
      ? 'Scale in Thirds'
      : currentMode === 'arpeggio'
        ? 'Arpeggio'
        : 'Broken chords';
  document.getElementById('selected-title').textContent = `${label} – ${item.name}`;
  document.getElementById('selected-desc').textContent = `${item.octaves} octave${item.octaves > 1 ? 's' : ''} • ${item.type} • Root ${item.root}`;

  const cont = document.getElementById('notes-container');
  cont.innerHTML = '';
  sequence.forEach((n, i) => {
    const p = document.createElement('div');
    p.className = 'note-pill px-5 py-3 bg-slate-800/70 rounded-lg text-center min-w-[60px] text-base font-medium';
    p.textContent = n;
    p.dataset.index = i;
    cont.appendChild(p);
  });

  document.getElementById('results-area').classList.add('hidden');
  updateLiveExpected();
  updateModeUI();
  preloadCurrentSequenceSamples().catch(() => {});
  updateMobileActionBar();
}

async function playSequence() {
  if (!currentItem || isPlaying || learningMode !== 'learning') return;
  await initAudio();
  isPlaying = true;
  const playBtn = document.getElementById('btn-play');
  if (playBtn) playBtn.disabled = true;

  const pills = document.querySelectorAll('#notes-container > div');
  updateMobileActionBar();

  for (let i = 0; i < sequence.length; i++) {
    if (!isPlaying) break;
    pills.forEach((p, idx) => p.classList.toggle('highlight', idx === i));
    const msPerBeat = 60000 / getCurrentTempo();
    const noteDur = msPerBeat * 0.85;
    await playSequenceNote(sequence[i], noteDur);
    await new Promise((r) => setTimeout(r, msPerBeat));
  }

  pills.forEach((p) => p.classList.remove('highlight'));
  isPlaying = false;
  if (playBtn) playBtn.disabled = false;
  updateMobileActionBar();
}

async function startSession(resetProgress = true) {
  await initAudio();
  sessionRunning = true;
  sessionPaused = false;

  if (resetProgress) {
    currentIndex = 0;
    detected = [];
    document.querySelectorAll('.note-pill').forEach((p) => p.classList.remove('correct', 'wrong'));
  }

  const btn = document.getElementById('btn-session');
  if (btn) btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M10 9v2m4-2v2m7-5a9 9 0 01-9 9 9 9 0 01-9-9 9 9 0 019-9 9 9 0 019 9z"/></svg><span>Pause</span>';
  document.getElementById('btn-listen')?.classList.add('hidden');
  document.getElementById('btn-analyze')?.classList.remove('hidden');
  setMobileSecondaryAction({ label: 'Stop & Check', tone: 'slate', handler: stopAndAnalyze });

  const listeningReady = await startListening();
  if (!listeningReady) {
    stopSession();
    return;
  }

  if (learningMode === 'performance') await runPerformanceCountIn();
  if (!sessionRunning) return;

  if (learningMode === 'performance') startTempoTimer();
  updateLiveExpected();
  updateMobileActionBar();
}

function pauseSession() {
  sessionRunning = false;
  if (tempoTimer) clearTimeout(tempoTimer);
  cancelCountIn();
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  analyser = null;
  rafId = null;
  stream = null;
  sessionPaused = true;
  updateCountInDisplay();
  const btn = document.getElementById('btn-session');
  if (btn) btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg><span>Resume</span>';
  updateMobileActionBar();
}

function toggleSession() {
  if (!currentItem) return alert('Select an exercise first');
  if (!sessionRunning) startSession(!sessionPaused);
  else pauseSession();
}

function startTempoTimer() {
  if (tempoTimer) clearTimeout(tempoTimer);
  const ms = 60000 / getCurrentTempo();
  tempoTimer = setTimeout(() => {
    if (!sessionRunning || learningMode !== 'performance') return;
    currentIndex = Math.min(currentIndex + 1, sequence.length - 1);
    updateLiveExpected();
    if (currentIndex < sequence.length - 1) startTempoTimer();
    else stopSession();
  }, ms);
}

function updateLiveExpected() {
  document.getElementById('expected-live').textContent = sequence[currentIndex] || '—';
  document.querySelectorAll('.note-pill').forEach((p) => {
    p.classList.remove('current');
    if (parseInt(p.dataset.index, 10) === currentIndex) p.classList.add('current');
  });
}

function markNote(idx, correct) {
  const p = document.querySelector(`.note-pill[data-index="${idx}"]`);
  if (p) p.classList.add(correct ? 'correct' : 'wrong');
}

function updateCountInDisplay(beat = null, text = 'Get ready') {
  const container = document.getElementById('count-in-display');
  const textEl = document.getElementById('count-in-text');
  const numberEl = document.getElementById('count-in-number');
  if (!container || !textEl || !numberEl) return;

  const show = learningMode === 'performance' && (countInActive || beat !== null);
  container.classList.toggle('hidden', !show);
  textEl.textContent = text;
  numberEl.textContent = beat ?? '4';
}

function playCountInClick(isAccent = false) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = isAccent ? 'triangle' : 'square';
  osc.frequency.setValueAtTime(isAccent ? 1320 : 980, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(isAccent ? 0.16 : 0.1, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.12);
}

function wait(ms) {
  return new Promise((resolve) => {
    countInResolve = resolve;
    countInTimer = setTimeout(resolve, ms);
  });
}

function cancelCountIn() {
  if (countInTimer) clearTimeout(countInTimer);
  countInTimer = null;
  countInActive = false;
  if (countInResolve) {
    const resolve = countInResolve;
    countInResolve = null;
    resolve();
  }
}

async function runPerformanceCountIn() {
  countInActive = true;

  for (let beat = 4; beat >= 1; beat--) {
    if (!sessionRunning) break;
    const msPerBeat = 60000 / getCurrentTempo();
    updateCountInDisplay(beat, beat === 1 ? 'Start on the next beat' : 'Performance starts soon');
    playCountInClick(beat === 4);
    await wait(msPerBeat);
  }

  countInActive = false;
  countInTimer = null;
  countInResolve = null;
  updateCountInDisplay();
}

async function startListening() {
  await initAudio();
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available in this browser.');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    src.connect(analyser);
    rafId = requestAnimationFrame(listen);
    return true;
  } catch (e) {
    alert(`Microphone access failed: ${e.message}`);
    return false;
  }
}

function stopSession() {
  if (rafId) cancelAnimationFrame(rafId);
  if (tempoTimer) clearTimeout(tempoTimer);
  cancelCountIn();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  sessionRunning = false;
  sessionPaused = false;
  analyser = null;
  rafId = null;
  stream = null;
  drawPitch(-1);
  updateCountInDisplay();
  const btn = document.getElementById('btn-session');
  if (btn) btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg><span>Start Again</span>';
  setMobileSecondaryAction(null);
  updateMobileActionBar();
}

function stopAndAnalyze() {
  stopSession();
  const rows = document.getElementById('results-rows');
  rows.innerHTML = '';
  let correct = 0;
  sequence.forEach((exp, i) => {
    const got = detected[i] || '—';
    const match = isSamePitch(got, exp);
    if (match) correct++;
    const row = document.createElement('div');
    row.className = 'flex justify-between items-center bg-slate-900/50 px-5 py-3.5 rounded-xl';
    row.innerHTML = `
      <div class="flex-1"><div class="text-emerald-400 text-xs">EXPECTED</div><div class="text-lg font-medium">${exp}</div></div>
      <div class="text-center flex-1"><div class="text-orange-400 text-xs">YOU PLAYED</div><div class="text-lg font-medium ${match ? 'text-emerald-400' : 'text-red-400'}">${got}</div></div>
      <div class="text-2xl">${match ? '✅' : '❌'}</div>`;
    rows.appendChild(row);
  });
  const pct = sequence.length ? Math.round((correct / sequence.length) * 100) : 0;
  document.getElementById('score-display').textContent = `${pct}%`;
  document.getElementById('results-area').classList.remove('hidden');
  updateMobileActionBar();
}

async function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
    await audioCtx.resume();
  }
  if (!audioUnlocked) {
    await unlockAudioContext();
  }
}

async function unlockAudioContext() {
  if (audioUnlocked) return;
  if (audioUnlockPromise) return audioUnlockPromise;

  audioUnlockPromise = (async () => {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
      await audioCtx.resume();
    }

    const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();

    source.buffer = buffer;
    gain.gain.value = 0.0001;
    source.connect(gain).connect(audioCtx.destination);
    source.start(0);
    source.stop(audioCtx.currentTime + 0.01);

    audioUnlocked = true;
    updateAudioBanner();
  })();

  try {
    await audioUnlockPromise;
  } finally {
    audioUnlockPromise = null;
  }
}

function registerAudioUnlock() {
  const unlock = () => {
    initAudio().catch(() => {});
  };

  ['touchstart', 'touchend', 'pointerdown', 'click'].forEach((eventName) => {
    document.addEventListener(eventName, unlock, { passive: true });
  });
}

function setupMobileUI() {
  document.getElementById('audio-banner-btn')?.addEventListener('click', () => {
    initAudio().catch(() => {});
  });

  document.getElementById('mobile-primary-btn')?.addEventListener('click', () => {
    if (!currentItem) return;
    if (learningMode === 'learning') {
      playSequence();
      return;
    }
    toggleSession();
  });

  document.getElementById('mobile-secondary-btn')?.addEventListener('click', () => {
    mobileSecondaryAction?.handler?.();
  });
}

function setupCanvas() {
  canvas = document.getElementById('pitch-canvas');
  if (canvas) ctx = canvas.getContext('2d');
}

function setupControls() {
  document.querySelectorAll('.grade-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const text = button.textContent.trim();
      const grade = text === 'Grade 1' ? 1 : parseInt(text, 10);
      if (!Number.isNaN(grade)) selectGrade(grade);
    });
  });

  const modeMap = {
    'mode-scale': 'scale',
    'mode-thirds': 'thirds',
    'mode-arpeggio': 'arpeggio',
    'mode-broken': 'broken',
  };
  Object.entries(modeMap).forEach(([id, mode]) => {
    document.getElementById(id)?.addEventListener('click', () => setMode(mode));
  });

  ['learning', 'practice', 'performance'].forEach((mode) => {
    document.getElementById(`${mode}-btn`)?.addEventListener('click', () => setLearningMode(mode));
  });

  ['synth', 'samples'].forEach((mode) => {
    document.getElementById(`playback-${mode}-btn`)?.addEventListener('click', () => setPlaybackMode(mode));
  });

  document.getElementById('btn-listen')?.addEventListener('click', startListening);
  document.getElementById('btn-analyze')?.addEventListener('click', stopAndAnalyze);
}

function drawPitch(freq) {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (freq < 40) {
    ctx.fillStyle = 'rgba(50,50,60,0.4)';
    ctx.fillRect(0, 40, canvas.width, 20);
    return;
  }
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  const x = ((midi % 12) / 12) * canvas.width + Math.floor(midi / 12) * 8;
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, 35, x, 30);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 20px Inter';
  ctx.textAlign = 'center';
  ctx.fillText(midiToNote(midi, prefersFlats(sequence[currentIndex])), x, 90);
}

function init() {
  setupCanvas();
  setupControls();
  setupMobileUI();
  registerAudioUnlock();
  selectGrade(1);
  setMode('scale');
  renderItems();
  setPlaybackMode('synth');
  setLearningMode('learning');
  updateAudioBanner();
  updateMobileActionBar();

  const tempoSlider = document.getElementById('tempo-slider');
  ['input', 'change'].forEach((eventName) => {
    tempoSlider.addEventListener(eventName, (event) => {
      setTempo(event.target.value);
    });
  });
  setTempo(tempoSlider.value);

  setTimeout(() => {
    const first = itemsByGrade[1]?.[0];
    if (first) loadItem(first);
  }, 400);
}

Object.assign(window, {
  selectGrade,
  setMode,
  setTempo,
  setPlaybackMode,
  setLearningMode,
  startListening,
  stopAndAnalyze,
  toggleSession,
});

window.addEventListener('load', init);
