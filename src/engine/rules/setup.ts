// Préparatifs d'avant-jeu (manuel, 6-2-1).
// 6-2-1-1 (vérification des decks) et 6-2-1-2 (Leader côté face) sont faits par createGame.
// Non géré pour l'instant : 6-2-1-3 (capacités « Quand cette carte est placée dans la Zone
// du Leader »), 6-2-1-8 (deck Z), 6-2-2 (capacités qui modifient la mise en place).

import type { Action, GameEvent } from "../protocol";
import { nextRandom } from "../rng";
import { opponentOf, PLAYER_IDS, type GameState, type PlayerId } from "../state/types";
import { drawCards, shuffleDeck } from "./basic";
import { startTurn } from "./turn";

export const STARTING_HAND = 6; // 6-2-1-9
export const STARTING_LIFE = 8; // 6-2-1-10
export const SECOND_PLAYER_ENERGY_MARKERS = 1; // 6-2-1-11

/** 6-2-1-4 : le hasard désigne le joueur qui choisira qui joue en premier. */
export function startSetup(s: GameState, events: GameEvent[]): void {
  const winner: PlayerId = nextRandom(s) < 0.5 ? "P1" : "P2";
  events.push({ type: "COIN_TOSS", winner });
  s.pending = { type: "CHOOSE_FIRST_PLAYER", player: winner };
}

export function chooseFirstPlayer(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_FIRST_PLAYER" }>,
  events: GameEvent[],
): void {
  // 6-2-1-4 / 6-2-1-5
  s.firstPlayer = action.first;
  s.turnPlayer = action.first;
  events.push({ type: "FIRST_PLAYER_CHOSEN", chooser: action.player, first: action.first });

  // 6-2-1-6 : point de contrôle (rien à traiter tant que les capacités ne sont pas gérées).
  // 6-2-1-7 : chaque joueur mélange son deck.
  // 6-2-1-9 : chaque joueur pioche six cartes.
  for (const p of PLAYER_IDS) shuffleDeck(s, p, events);
  for (const p of PLAYER_IDS) drawCards(s, p, STARTING_HAND, events);

  // 6-2-1-9 : repioche, en commençant par le joueur qui joue en premier.
  s.pending = { type: "MULLIGAN", player: action.first };
}

export function mulligan(s: GameState, action: Extract<Action, { type: "MULLIGAN" }>, events: GameEvent[]): void {
  const player = action.player;
  events.push({ type: "MULLIGAN", player, redraw: action.redraw });
  if (action.redraw) {
    // 6-2-1-9-1 : remettre toute la main dans le deck, remélanger, piocher six cartes.
    const p = s.players[player];
    p.deck.push(...p.hand.splice(0));
    shuffleDeck(s, player, events);
    drawCards(s, player, STARTING_HAND, events);
  }

  if (player === s.firstPlayer) {
    s.pending = { type: "MULLIGAN", player: opponentOf(player) };
  } else {
    finishSetup(s, events);
  }
}

function finishSetup(s: GameState, events: GameEvent[]): void {
  s.pending = null;
  const first = s.firstPlayer!;

  // 6-2-1-10 : les huit cartes du dessus du deck, face cachée, dans la Zone de Vie.
  for (const id of PLAYER_IDS) {
    const p = s.players[id];
    const life = p.deck.splice(0, STARTING_LIFE);
    for (const c of life) c.faceUp = false;
    p.life.push(...life);
    events.push({ type: "LIFE_PLACED", player: id, count: life.length });
  }

  // 6-2-1-11 : le joueur qui joue en second place un marqueur Énergie.
  const second = opponentOf(first);
  s.players[second].energyMarkers += SECOND_PLAYER_ENERGY_MARKERS;
  events.push({ type: "ENERGY_MARKER_PLACED", player: second, count: SECOND_PLAYER_ENERGY_MARKERS });

  // 6-2-1-12 : le premier joueur commence la partie et son tour.
  startTurn(s, first, 1, events);
}
