// Outils partagés par les tests.
import { expect } from "vitest";
import freezerFile from "../cards/freezer.json";
import {
  applyAction,
  buildCardDatabase,
  createGame,
  parseCardFile,
  type Action,
  type CardInstance,
  type GameContext,
  type PlayerId,
  type GameEvent,
  type GameState,
} from "../src/engine";

export const freezer = parseCardFile(freezerFile);
export const db = buildCardDatabase([freezer.cards]);
export const ctx: GameContext = { cards: db };

/**
 * Nouvelle partie Freezer contre Freezer, avec une graine fixe par défaut. Les fenêtres de
 * contre ne s'arrêtent que si un joueur a un contre jouable (`counterPrompt`), pour garder les
 * tests courts ; les tests de contre vérifient aussi le mode « always ».
 */
export function newMirrorGame(seed = 42, counterPrompt: "always" | "only_if_playable" = "only_if_playable"): GameState {
  const result = createGame(
    { decks: { P1: freezer.deck!, P2: freezer.deck! }, seed, counterPrompt: { P1: counterPrompt, P2: counterPrompt } },
    db,
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.state;
}

/** Joue une suite d'actions qui doivent toutes être acceptées. Renvoie l'état final et tous les événements. */
export function play(state: GameState, ...actions: Action[]): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (const action of actions) {
    const r = applyAction(state, action, ctx);
    if (!r.ok) throw new Error(`action refusée ${JSON.stringify(action)} : ${r.error}`);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

/** Vérifie qu'une action est refusée, avec un message contenant `expected`. */
export function expectRefused(state: GameState, action: Action, expected: string): void {
  const r = applyAction(state, action, ctx);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(expected);
}

/**
 * Déplace un exemplaire de la carte `cardId` vers une zone d'un joueur (préparation de scénario).
 * L'exemplaire est cherché dans le deck, puis la Vie, puis la main.
 */
export function give(
  s: GameState,
  player: PlayerId,
  cardId: string,
  zone: "hand" | "energy" | "battle",
  mode: "active" | "rest" = "active",
): CardInstance {
  const p = s.players[player];
  for (const from of ["deck", "life", "hand"] as const) {
    if (from === zone) continue;
    const i = p[from].findIndex((c) => c.cardId === cardId);
    if (i < 0) continue;
    const [card] = p[from].splice(i, 1);
    card!.mode = mode;
    card!.faceUp = zone !== "hand";
    p[zone].push(card!);
    return card!;
  }
  const inPlace = zone === "hand" && p.hand.find((c) => c.cardId === cardId);
  if (inPlace) return inPlace;
  throw new Error(`plus de ${cardId} disponible pour ${player}`);
}

/** P1, premier tour, en phase principale, sans Énergie posée ce tour-ci. */
export function p1Main(seed = 42): GameState {
  return play(startedMirrorGame(seed), { type: "CHARGE_ENERGY", player: "P1", uid: null }).state;
}

/** P2, premier tour (il a son marqueur Énergie et peut attaquer), en phase principale. */
export function p2Main(seed = 42): GameState {
  return play(
    p1Main(seed),
    { type: "END_MAIN_PHASE", player: "P1" },
    { type: "CHARGE_ENERGY", player: "P2", uid: null },
  ).state;
}

/** Partie dont la mise en place est terminée : P1 commence, personne ne repioche. */
export function startedMirrorGame(seed = 42): GameState {
  const s = newMirrorGame(seed);
  const chooser = s.pending!.player;
  return play(
    s,
    { type: "CHOOSE_FIRST_PLAYER", player: chooser, first: "P1" },
    { type: "MULLIGAN", player: "P1", redraw: false },
    { type: "MULLIGAN", player: "P2", redraw: false },
  ).state;
}
