// Enregistrement et relecture d'une partie.
// Une partie se résume à : les decks, la graine du hasard et la liste des coups joués.
// Rejouer ces coups avec le même moteur redonne exactement la même partie (le moteur est
// déterministe). C'est ce qui permet :
//  - de reproduire un bug à partir d'un fichier de partie exporté ;
//  - plus tard, au multijoueur de n'échanger que des coups entre l'hôte et l'invité.
//
// Attention : un enregistrement contient la graine, donc permet de reconstituer TOUTES les
// informations cachées (mains, decks). Il ne doit pas être envoyé à un adversaire en cours de partie.

import type { DeckList } from "./cards/types";
import { applyAction } from "./actions";
import type { Action, GameContext, GameEvent } from "./protocol";
import { createGame } from "./state/create";
import type { CounterPrompt, GameRules, GameState, PlayerId } from "./state/types";

export const RECORD_FORMAT = "dbscg-partie";
export const RECORD_VERSION = 1;

export interface GameRecord {
  format: typeof RECORD_FORMAT;
  version: number;
  seed: number;
  decks: Record<PlayerId, DeckList>;
  /** Réglage des fenêtres de contre de chaque joueur (absent = « always »). */
  counterPrompt?: Record<PlayerId, CounterPrompt>;
  /** Règles de la partie personnalisée (absentes = règles officielles). */
  rules?: Partial<GameRules>;
  actions: Action[];
}

export function newRecord(
  seed: number,
  decks: Record<PlayerId, DeckList>,
  counterPrompt?: Record<PlayerId, CounterPrompt>,
  rules?: Partial<GameRules>,
): GameRecord {
  return { format: RECORD_FORMAT, version: RECORD_VERSION, seed, decks, ...(counterPrompt ? { counterPrompt } : {}), ...(rules ? { rules } : {}), actions: [] };
}

export type ReplayResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string; state?: GameState; actionIndex?: number };

/** Rejoue une partie enregistrée, coup par coup. S'arrête au premier coup refusé. */
export function replayGame(record: unknown, ctx: GameContext): ReplayResult {
  const r = record as Partial<GameRecord> | null;
  if (!r || r.format !== RECORD_FORMAT) return { ok: false, error: "ce fichier n'est pas une partie enregistrée" };
  if (r.version !== RECORD_VERSION) return { ok: false, error: `version de fichier non gérée : ${String(r.version)}` };
  if (typeof r.seed !== "number" || !r.decks || !Array.isArray(r.actions)) {
    return { ok: false, error: "fichier de partie incomplet" };
  }
  const created = createGame(
    { decks: r.decks, seed: r.seed, ...(r.counterPrompt ? { counterPrompt: r.counterPrompt } : {}), ...(r.rules ? { rules: r.rules } : {}) },
    ctx.cards,
  );
  if (!created.ok) return { ok: false, error: `decks invalides : ${created.errors.join(" ; ")}` };
  let state = created.state;
  const events = [...created.events];
  for (let i = 0; i < r.actions.length; i++) {
    const result = applyAction(state, r.actions[i]!, ctx);
    if (!result.ok) return { ok: false, error: `coup n°${i + 1} refusé : ${result.error}`, state, actionIndex: i };
    state = result.state;
    events.push(...result.events);
  }
  return { ok: true, state, events };
}
