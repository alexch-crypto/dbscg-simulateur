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
}

const KEY = "dbscg.prefs";
const DEFAULTS: Prefs = { pseudo: "", theme: "dark", counterPrompt: "always", logHidden: false, showImages: true };

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
