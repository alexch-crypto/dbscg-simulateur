// Préférences du joueur, mémorisées dans le navigateur (pseudo, thème, réglages par défaut).
// Si le stockage du navigateur est indisponible, les valeurs par défaut sont utilisées.

import type { CounterPrompt } from "../engine";

export type Theme = "auto" | "dark" | "light";

export interface Prefs {
  /** Pseudo affiché en ligne (vide = « P1 » / « P2 »). */
  pseudo: string;
  theme: Theme;
  /** Réglage par défaut des fenêtres de contre. */
  counterPrompt: CounterPrompt;
  /** Journal de la partie masqué. */
  logHidden: boolean;
  /** Afficher les images des cartes importées (si le joueur en a importé). */
  showImages: boolean;
  /** Sons de la partie et leur volume (0 à 1). */
  sound: boolean;
  volume: number;
  /** Animations de la partie. */
  animations: boolean;
  /** Musique de combat pendant la partie, et son volume (0 à 1). */
  music: boolean;
  musicVolume: number;
}

const KEY = "dbscg.prefs";
const DEFAULTS: Prefs = { pseudo: "", theme: "dark", counterPrompt: "always", logHidden: false, showImages: true, sound: true, volume: 0.5, animations: true, music: true, musicVolume: 0.3 };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    // Ancienne préférence du journal (avant le menu Paramètres).
    const oldLog = localStorage.getItem("dbscg.logHidden");
    return {
      pseudo: typeof raw.pseudo === "string" ? raw.pseudo.slice(0, 20) : DEFAULTS.pseudo,
      theme: raw.theme === "auto" || raw.theme === "light" || raw.theme === "dark" ? raw.theme : DEFAULTS.theme,
      counterPrompt: raw.counterPrompt === "only_if_playable" ? "only_if_playable" : DEFAULTS.counterPrompt,
      logHidden: typeof raw.logHidden === "boolean" ? raw.logHidden : oldLog === "1",
      showImages: typeof raw.showImages === "boolean" ? raw.showImages : DEFAULTS.showImages,
      sound: typeof raw.sound === "boolean" ? raw.sound : DEFAULTS.sound,
      volume: typeof raw.volume === "number" && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULTS.volume,
      animations: typeof raw.animations === "boolean" ? raw.animations : DEFAULTS.animations,
      music: typeof raw.music === "boolean" ? raw.music : DEFAULTS.music,
      musicVolume: typeof raw.musicVolume === "number" && raw.musicVolume >= 0 && raw.musicVolume <= 1 ? raw.musicVolume : DEFAULTS.musicVolume,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Stockage indisponible : les préférences ne seront simplement pas mémorisées.
  }
}

/** Applique le thème à la page (« auto » suit le réglage clair / sombre de l'ordinateur). */
export function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
}
