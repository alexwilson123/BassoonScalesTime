export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteToMidi(s) {
  try {
    const n = s.replace(/♭/g, 'b').replace(/♯/g, '#');
    const m = n.match(/^([A-Ga-g])([#b]?)([-]?[0-8])$/i);
    if (!m) return 60;
    let [, letter, acc, octaveStr] = m;
    letter = letter.toUpperCase();
    const octave = parseInt(octaveStr, 10);
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    let midi = base[letter] + (octave + 1) * 12;
    if (acc === '#') midi += 1;
    if (acc === 'b') midi -= 1;
    return midi;
  } catch {
    return 60;
  }
}

export function midiToNote(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  return NOTES[noteIndex] + octave;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return -1;

  // Bassoon fundamentals can be low; search down to ~55Hz (A1).
  const minFreq = 55;
  const maxFreq = 1200;
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(size - 2, Math.floor(sampleRate / minFreq));

  let bestLag = -1;
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    let e0 = 0;
    let e1 = 0;
    const count = size - lag;

    for (let i = 0; i < count; i++) {
      const x0 = buffer[i];
      const x1 = buffer[i + lag];
      ac += x0 * x1;
      e0 += x0 * x0;
      e1 += x1 * x1;
    }

    const denom = Math.sqrt(e0 * e1);
    if (!denom) continue;
    const score = ac / denom;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Confidence gate to reduce octave-jump/noise detections.
  if (bestScore > 0.82 && bestLag > 0) return sampleRate / bestLag;
  return -1;
}
