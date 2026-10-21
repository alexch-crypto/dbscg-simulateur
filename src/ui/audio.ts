// Sons et musique de la partie, SYNTHÉTISÉS par le navigateur (Web Audio) : aucun fichier sonore,
// rien à télécharger, aucun problème de droits.
//
// Style « jeu de cartes » : bruits de carton (glissé, « clac » sur le tapis), impacts sourds,
// montée d'énergie pour l'attaque, accord de cuivres pour l'Éveil, et une petite boucle de
// musique de combat discrète (percussions, basse, nappe de cordes) jouée pendant la partie.

export interface AudioSettings {
  sound: boolean;
  /** Volume des effets, de 0 à 1. */
  volume: number;
  music: boolean;
  /** Volume de la musique, de 0 à 1. */
  musicVolume: number;
}

let settings: AudioSettings = { sound: true, volume: 0.5, music: true, musicVolume: 0.3 };

let ac: AudioContext | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let reverb: ConvolverNode | null = null;
let noiseBuf: AudioBuffer | null = null;

/** Contexte audio (créé au premier son : les navigateurs exigent un clic de l'utilisateur avant). */
function audio(): AudioContext | null {
  try {
    if (!ac) {
      ac = new AudioContext();
      sfxBus = ac.createGain();
      sfxBus.connect(ac.destination);
      musicBus = ac.createGain();
      musicBus.connect(ac.destination);
      // Réverbération : réponse impulsionnelle fabriquée (bruit qui décroît).
      reverb = ac.createConvolver();
      const len = Math.floor(ac.sampleRate * 2.4);
      const ir = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      reverb.buffer = ir;
      const wet = ac.createGain();
      wet.gain.value = 0.35;
      reverb.connect(wet).connect(sfxBus);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const n = noiseBuf.getChannelData(0);
      for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
      applyVolumes();
    }
    if (ac.state === "suspended") void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

function applyVolumes(): void {
  if (sfxBus) sfxBus.gain.value = settings.sound ? settings.volume : 0;
  if (musicBus) musicBus.gain.value = settings.music ? settings.musicVolume * 0.5 : 0;
}

export function setAudioSettings(s: AudioSettings): void {
  settings = s;
  applyVolumes();
  if (!s.music) stopMusic();
}

interface NoiseOpts {
  at?: number;
  dur: number;
  type?: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  gain: number;
  attack?: number;
  wet?: boolean;
  bus?: GainNode | null;
}

/** Bruit filtré (carton, souffle, impact). */
function noise(o: NoiseOpts): void {
  const a = audio();
  if (!a || !noiseBuf) return;
  const t = a.currentTime + (o.at ?? 0);
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
  f.Q.value = o.q ?? 0.8;
  const g = a.createGain();
  const attack = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f).connect(g).connect(o.bus ?? sfxBus!);
  if (o.wet) g.connect(reverb!);
  src.start(t, Math.random() * 1.5);
  src.stop(t + o.dur + 0.05);
}

interface ToneOpts {
  at?: number;
  dur: number;
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  gain: number;
  attack?: number;
  /** Filtre passe-bas (ouverture de départ et d'arrivée), pour des sons moins « bip ». */
  lowpass?: number;
  lowpassEnd?: number;
  detune?: number;
  wet?: boolean;
  bus?: GainNode | null;
}

function tone(o: ToneOpts): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + (o.at ?? 0);
  const osc = a.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  let node: AudioNode = osc;
  if (o.lowpass) {
    const f = a.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(o.lowpass, t);
    if (o.lowpassEnd) f.frequency.exponentialRampToValueAtTime(o.lowpassEnd, t + Math.min(o.dur, 0.6));
    node = osc.connect(f);
  }
  const g = a.createGain();
  const attack = o.attack ?? 0.01;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  node.connect(g).connect(o.bus ?? sfxBus!);
  if (o.wet) g.connect(reverb!);
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

/** Carte posée sur le tapis : léger glissé puis « clac » feutré. */
function cardSlap(at = 0, strength = 1): void {
  noise({ at, dur: 0.07, type: "bandpass", freq: 5200, freqEnd: 2600, q: 0.7, gain: 0.07 * strength });
  noise({ at: at + 0.05, dur: 0.05, type: "highpass", freq: 1400, q: 0.5, gain: 0.32 * strength });
  noise({ at: at + 0.05, dur: 0.09, type: "lowpass", freq: 900, q: 0.5, gain: 0.25 * strength });
  tone({ at: at + 0.05, dur: 0.07, freq: 140, freqEnd: 90, gain: 0.12 * strength });
}

/** Accord « cuivres » : dents de scie désaccordées, filtre qui s'ouvre, réverbération. */
function brass(notes: number[], at: number, dur: number, gain = 0.07): void {
  for (const f of notes) {
    for (const d of [-8, 8]) {
      tone({ at, dur, freq: f, type: "sawtooth", gain, attack: 0.12, lowpass: 500, lowpassEnd: 2600, detune: d, wet: true });
    }
  }
}

const SOUNDS = {
  play: () => cardSlap(0, 1),
  charge: () => {
    cardSlap(0, 0.75);
    tone({ at: 0.06, dur: 0.5, freq: 880, gain: 0.025, wet: true });
  },
  draw: () => noise({ dur: 0.13, type: "bandpass", freq: 4600, freqEnd: 1900, q: 0.6, gain: 0.09 }),
  /** Attaque : énergie qui se concentre puis part d'un coup. */
  attack: () => {
    noise({ dur: 0.65, type: "bandpass", freq: 250, freqEnd: 2800, q: 1.2, gain: 0.22, attack: 0.5 });
    tone({ dur: 0.65, freq: 70, freqEnd: 160, type: "sawtooth", gain: 0.08, attack: 0.5, lowpass: 300, lowpassEnd: 900 });
    noise({ at: 0.6, dur: 0.6, type: "lowpass", freq: 7000, freqEnd: 500, q: 0.4, gain: 0.4, wet: true });
    tone({ at: 0.6, dur: 0.5, freq: 110, freqEnd: 40, gain: 0.35 });
  },
  /** Coup reçu : impact sourd. */
  hit: () => {
    tone({ dur: 0.55, freq: 95, freqEnd: 32, gain: 0.6, attack: 0.004 });
    noise({ dur: 0.3, type: "lowpass", freq: 1500, freqEnd: 150, q: 0.4, gain: 0.35, wet: true });
  },
  ko: () => {
    tone({ dur: 0.6, freq: 80, freqEnd: 28, gain: 0.5, attack: 0.004 });
    noise({ dur: 0.7, type: "bandpass", freq: 900, freqEnd: 120, q: 0.6, gain: 0.3, wet: true });
  },
  /** Contre : bouclier qui résonne (partiels métalliques), sur une carte posée. */
  counter: () => {
    cardSlap(0, 0.8);
    [523, 1290, 2070, 3120].forEach((f, i) => tone({ at: 0.06, dur: 1.1 - i * 0.2, freq: f, gain: 0.05 / (i + 1), wet: true }));
  },
  combo: () => {
    cardSlap(0, 0.9);
    noise({ at: 0.05, dur: 0.35, type: "bandpass", freq: 600, freqEnd: 3000, q: 1, gain: 0.12, attack: 0.2 });
  },
  power: () => {
    noise({ dur: 0.35, type: "highpass", freq: 1800, freqEnd: 7000, q: 0.5, gain: 0.07, attack: 0.15 });
    tone({ dur: 0.4, freq: 440, freqEnd: 880, gain: 0.04, wet: true });
  },
  /** Éveil : montée de puissance, puis accord de cuivres et coup de timbale. */
  awaken: () => {
    noise({ dur: 1.1, type: "bandpass", freq: 150, freqEnd: 3500, q: 1.4, gain: 0.25, attack: 0.9 });
    tone({ dur: 1.1, freq: 55, freqEnd: 110, type: "sawtooth", gain: 0.1, attack: 0.9, lowpass: 200, lowpassEnd: 800 });
    tone({ at: 1.0, dur: 0.9, freq: 65, freqEnd: 45, gain: 0.55, attack: 0.005, wet: true });
    brass([146.8, 220, 293.7, 370], 1.0, 1.8, 0.06);
  },
  /** Début de tour : un souffle grave et une carte qui glisse. */
  turn: () => {
    tone({ dur: 0.9, freq: 73, gain: 0.12, attack: 0.08, wet: true });
    noise({ at: 0.05, dur: 0.15, type: "bandpass", freq: 4200, freqEnd: 2000, q: 0.6, gain: 0.07 });
  },
  win: () => {
    tone({ dur: 0.8, freq: 65, freqEnd: 45, gain: 0.5, wet: true });
    brass([130.8, 196, 261.6, 329.6], 0, 0.7);
    brass([174.6, 220, 261.6, 349.2], 0.55, 0.7);
    brass([196, 246.9, 293.7, 392], 1.1, 0.7);
    brass([130.8, 196, 261.6, 329.6, 523.3], 1.65, 2.2, 0.07);
  },
  lose: () => {
    brass([110, 130.8, 164.8], 0, 1.6, 0.06);
    brass([98, 116.5, 146.8], 1.2, 2.2, 0.05);
  },
};
export type SoundName = keyof typeof SOUNDS;

export function playSound(name: SoundName): void {
  if (!settings.sound || settings.volume <= 0) return;
  SOUNDS[name]();
}

// ---------------------------------------------------------------------------
// Musique de combat : boucle de 4 mesures en ré mineur (Ré m – Si♭ – Do – La), 96 BPM.
// Percussions, basse et nappe de cordes, volontairement discrètes.
// ---------------------------------------------------------------------------

const BPM = 96;
const STEP = 60 / BPM / 4; // une double croche
/** Accords (fréquences) de chaque mesure, et note de basse. */
const BARS: { chord: number[]; bass: number }[] = [
  { chord: [146.8, 174.6, 220], bass: 73.4 }, // Ré m
  { chord: [116.5, 146.8, 174.6], bass: 58.3 }, // Si♭
  { chord: [130.8, 164.8, 196], bass: 65.4 }, // Do
  { chord: [110, 138.6, 164.8], bass: 55 }, // La
];
const BASS_STEPS = [0, 3, 6, 8, 10, 14];

let musicTimer: number | null = null;
let nextTime = 0;
let step = 0;

function scheduleStep(t: number, s: number): void {
  const a = ac!;
  const at = t - a.currentTime;
  const bar = BARS[Math.floor(s / 16) % BARS.length]!;
  const inBar = s % 16;
  const bus = musicBus;
  // Grosse caisse, caisse claire (feutrée), charleston.
  if (inBar === 0 || inBar === 8 || (inBar === 10 && Math.floor(s / 16) % 2 === 1)) {
    tone({ at, dur: 0.22, freq: 110, freqEnd: 40, gain: 0.55, attack: 0.002, bus });
  }
  if (inBar === 4 || inBar === 12) {
    noise({ at, dur: 0.16, type: "bandpass", freq: 1700, q: 0.6, gain: 0.18, bus });
    tone({ at, dur: 0.08, freq: 190, freqEnd: 150, gain: 0.08, bus });
  }
  if (inBar % 2 === 0) noise({ at, dur: 0.04, type: "highpass", freq: 7000, q: 0.5, gain: inBar % 4 === 2 ? 0.05 : 0.025, bus });
  // Basse.
  if (BASS_STEPS.includes(inBar)) {
    tone({ at, dur: STEP * 1.8, freq: bar.bass, type: "sawtooth", gain: 0.12, attack: 0.01, lowpass: 380, bus });
  }
  // Nappe de cordes : un accord tenu sur toute la mesure.
  if (inBar === 0) {
    for (const f of bar.chord) {
      for (const d of [-7, 7]) {
        tone({ at, dur: STEP * 16, freq: f, type: "sawtooth", gain: 0.022, attack: 0.5, lowpass: 900, detune: d, bus });
      }
    }
  }
}

/** Lance la boucle (sans effet si elle tourne déjà ou si la musique est coupée). */
export function startMusic(): void {
  if (!settings.music || musicTimer !== null) return;
  const a = audio();
  if (!a) return;
  nextTime = a.currentTime + 0.1;
  step = 0;
  musicTimer = window.setInterval(() => {
    if (!ac) return;
    // On programme un peu d'avance pour un rythme régulier.
    while (nextTime < ac.currentTime + 0.15) {
      scheduleStep(nextTime, step);
      nextTime += STEP;
      step = (step + 1) % (16 * BARS.length);
    }
  }, 30);
}

export function stopMusic(): void {
  if (musicTimer !== null) {
    window.clearInterval(musicTimer);
    musicTimer = null;
  }
}
