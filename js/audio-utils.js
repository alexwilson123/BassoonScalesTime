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
  const maxOffset = Math.min(1024, size >> 1);

  let rms = 0;
  for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return -1;

  let bestOffset = -1;
  let bestCorrelation = 0;

  for (let offset = 20; offset < maxOffset; offset++) {
    let correlation = 0;
    const count = size - offset;
    for (let i = 0; i < count; i++) {
      correlation += Math.abs(buffer[i] - buffer[i + offset]);
    }
    correlation = 1 - correlation / count;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  if (bestCorrelation > 0.25 && bestOffset > 0) return sampleRate / bestOffset;
  return -1;
}
