// Préparatifs d'avant-jeu (manuel, 6-2-1).
// 6-2-1-1 (vérification des decks) et 6-2-1-2 (Leader côté face) sont faits par createGame.
// Non géré pour l'instant : 6-2-1-3 (capacités « Quand cette carte est placée dans la Zone
// du Leader »), 6-2-1-8 (deck Z), 6-2-2 (capacités qui modifient la mise en place).

import type { Action, GameContext, GameEvent } from "../protocol";
import { nextRandom } from "../rng";
import { opponentOf, PLAYER_IDS, type GameState, type PlayerId } from "../state/types";
import { drawCards, shuffleDeck } from "./basic";
import { startTurn } from "./turn";
import { startResolution } from "./effects";

// Main de départ (6-2-1-9 : 6) et Vie (6-2-1-10 : 8) : dans les règles de la partie (s.rules).
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
  ctx: GameContext,
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
  for (const p of PLAYER_IDS) drawCards(s, p, s.rules.startingHand, events);

  // 6-2-1-9 : repioche, en commençant par le joueur qui joue en premier (sauf partie sans repioche).
  if (s.rules.mulligan) s.pending = { type: "MULLIGAN", player: action.first };
  else finishSetup(s, ctx, events);
}

export function mulligan(s: GameState, action: Extract<Action, { type: "MULLIGAN" }>, ctx: GameContext, events: GameEvent[]): void {
  const player = action.player;
  events.push({ type: "MULLIGAN", player, redraw: action.redraw });
  if (action.redraw) {
    // 6-2-1-9-1 : remettre toute la main dans le deck, remélanger, piocher six cartes.
    const p = s.players[player];
    p.deck.push(...p.hand.splice(0));
    shuffleDeck(s, player, events);
    drawCards(s, player, s.rules.startingHand, events);
  }

  if (player === s.firstPlayer) {
    s.pending = { type: "MULLIGAN", player: opponentOf(player) };
  } else {
    finishSetup(s, ctx, events);
  }
}

function finishSetup(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  s.pending = null;
  const first = s.firstPlayer!;

  // 6-2-1-10 : les huit cartes du dessus du deck, face cachée, dans la Zone de Vie.
  for (const id of PLAYER_IDS) {
    const p = s.players[id];
    const life = p.deck.splice(0, s.rules.startingLife);
    for (const c of life) c.faceUp = false;
    p.life.push(...life);
    events.push({ type: "LIFE_PLACED", player: id, count: life.length });
  }

  // 6-2-1-11 : le joueur qui joue en second place un marqueur Énergie.
  const second = opponentOf(first);
  s.players[second].energyMarkers += SECOND_PLAYER_ENERGY_MARKERS;
  events.push({ type: "ENERGY_MARKER_PLACED", player: second, count: SECOND_PLAYER_ENERGY_MARKERS });

  // Partie personnalisée : Énergies de départ, prises sur le dessus du deck (en mode Action).
  if (s.rules.startingEnergy > 0) {
    for (const id of PLAYER_IDS) {
      const p = s.players[id];
      for (const c of p.deck.splice(0, s.rules.startingEnergy)) {
        c.faceUp = true;
        c.mode = "active";
        p.energy.push(c);
        events.push({ type: "ENERGY_CHARGED", player: id, uid: c.uid, cardId: c.cardId, mode: "active" });
      }
    }
  }
  // Partie personnalisée : les Leaders commencent éveillés.
  if (s.rules.awakenedLeaders) {
    for (const id of PLAYER_IDS) {
      const leader = s.players[id].leader;
      if (leader.side === "front" && ctx.cards.get(leader.cardId)?.back) {
        leader.side = "back";
        events.push({ type: "LEADER_FLIPPED", player: id, side: "back" });
      }
    }
  }
  // Partie personnalisée : chaque joueur prend des cartes au choix dans son deck (le premier joueur d'abord).
  if (s.rules.tutorAtStart > 0) {
    startTutor(s, ctx, first, opponentOf(first), events);
    return;
  }
  // 6-2-1-12 : le premier joueur commence la partie et son tour.
  startTurn(s, first, 1, events);
}

/** « Prenez jusqu'à N cartes au choix dans votre deck » (partie personnalisée), puis le joueur suivant. */
function startTutor(s: GameState, ctx: GameContext, player: PlayerId, next: PlayerId | null, events: GameEvent[]): void {
  const leader = s.players[player].leader;
  startResolution(
    s,
    ctx,
    player,
    { uid: leader.uid, cardId: leader.cardId },
    [{ do: "look_top_deck", count: s.players[player].deck.length, pick: { up_to: s.rules.tutorAtStart, to: "hand" }, then: "shuffle_deck" }],
    { kind: "setup_tutor", next },
    events,
  );
}

/** Suite de la mise en place après les cartes au choix d'un joueur. */
export function continueSetupTutor(s: GameState, ctx: GameContext, next: PlayerId | null, events: GameEvent[]): void {
  if (next) startTutor(s, ctx, next, null, events);
  else startTurn(s, s.firstPlayer!, 1, events);
}
