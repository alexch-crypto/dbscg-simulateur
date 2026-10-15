// Déroulement d'un tour (manuel, section 7).
// Les effets « pour tout le tour », « au début de... », etc. et les points de contrôle
// n'ont rien à traiter tant que les capacités ne sont pas gérées : ils sont seulement
// signalés en commentaire, à leur place exacte, pour les brancher plus tard.

import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type GameState, type PlayerId } from "../state/types";
import { drawCards } from "./basic";
import { checkDefeat } from "./defeat";
import { cardHasKeyword, KW } from "./keywords";

/** 7-2 : début du tour de `player`, phase de Recharge jusqu'au choix de l'Énergie. */
export function startTurn(s: GameState, player: PlayerId, turnNumber: number, events: GameEvent[]): void {
  s.turnPlayer = player;
  s.turnNumber = turnNumber;
  s.phase = "charge";
  // Les compteurs « une fois par tour / X fois par tour » repartent de zéro, et les effets
  // « pour tout le tour » du tour précédent sont terminés (7-4-6).
  s.turnUsage = {};
  s.powerMods = s.powerMods.filter((m) => m.until !== "turn");
  s.effects = s.effects.filter((e) => e.untilTurn >= turnNumber);
  events.push({ type: "TURN_STARTED", player, turnNumber });

  // 7-2-2 à 7-2-5 : effets « pour tout le tour », fin des effets « jusqu'au début du tour
  // adverse », effets « au début du tour / de la phase de Recharge ».
  // 7-2-6 : point de contrôle.

  // 7-2-7 : le joueur actif passe en mode Action ses cartes en mode Inertie de sa Zone du
  // Leader, de Combat, d'Énergie (et Unisson, non gérée pour l'instant).
  // Sauf les cartes qui « ne peuvent pas passer en mode Action » à cause d'un effet.
  const p = s.players[player];
  const locked = new Set(s.effects.filter((e) => e.kind === "lock_active").map((e) => e.uid));
  if (!locked.has(p.leader.uid)) p.leader.mode = "active";
  for (const c of [...p.battle, ...p.energy]) if (!locked.has(c.uid)) c.mode = "active";
  events.push({ type: "CARDS_READIED", player });

  // 7-2-8 : point de contrôle.
  // 7-2-9 : le joueur actif pioche une carte, sauf le premier joueur à son premier tour (7-2-9-1).
  const isFirstTurnOfFirstPlayer = turnNumber === 1 && player === s.firstPlayer;
  if (!isFirstTurnOfFirstPlayer) {
    drawCards(s, player, 1, events);
    if (checkDefeat(s, events)) return;
  }

  // 7-2-10 : point de contrôle.
  // 7-2-11 : le joueur actif peut placer une carte de sa main dans sa Zone d'Énergie.
  s.pending = { type: "CHARGE", player };
}

/** 7-2-11 : placer (ou non) une carte de la main dans la Zone d'Énergie. */
export function chargeEnergy(
  s: GameState,
  action: Extract<Action, { type: "CHARGE_ENERGY" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const p = s.players[action.player];
  if (action.uid !== null) {
    const index = p.hand.findIndex((c) => c.uid === action.uid);
    if (index < 0) return "7-2-11 : la carte doit venir de votre main";
    const [card] = p.hand.splice(index, 1);
    // L'Énergie posée arrive en mode Action, sauf avec [Fuite d'énergie] : mode Inertie (22-31-2).
    // (Les Capacités qui annulent la Fuite d'énergie viendront à l'étape des effets.)
    // La Zone d'Énergie est publique.
    card!.mode = cardHasKeyword(ctx.cards.get(card!.cardId), KW.energyExhaust) ? "rest" : "active";
    card!.faceUp = true;
    p.energy.push(card!);
    events.push({ type: "ENERGY_CHARGED", player: action.player, uid: card!.uid, cardId: card!.cardId, mode: card!.mode });
  }
  // 7-2-12 : point de contrôle. 7-2-13 : passez à la phase principale.
  startMainPhase(s, events);
  return null;
}

/** 7-3 : phase principale. */
function startMainPhase(s: GameState, events: GameEvent[]): void {
  s.phase = "main";
  events.push({ type: "PHASE_STARTED", player: s.turnPlayer, phase: "main" });
  // 7-3-2 : effets « Au début de la phase principale ». 7-3-3 : point de contrôle.
  // 7-3-4 : le joueur actif reçoit un timing libre.
  s.pending = { type: "MAIN", player: s.turnPlayer };
}

/** 7-3-4-5 : le joueur actif termine sa phase principale. */
export function endMainPhase(s: GameState, events: GameEvent[]): void {
  // 7-3-5 : étape de Fin de la phase principale (effets « à la fin de la phase principale »,
  // point de contrôle, fin des effets « pour toute la phase principale »).
  // 7-4 : phase de Fin.
  s.phase = "end";
  s.pending = null;
  events.push({ type: "PHASE_STARTED", player: s.turnPlayer, phase: "end" });
  // 7-4-2 à 7-4-6 : effets « à la fin du tour », points de contrôle, fin des effets du tour.
  // 7-4-7 : le tour se termine, l'adversaire devient le joueur actif.
  events.push({ type: "TURN_ENDED", player: s.turnPlayer });
  startTurn(s, opponentOf(s.turnPlayer), s.turnNumber + 1, events);
}
