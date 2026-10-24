// Déroulement d'un tour (manuel, section 7).
// Les effets « pour tout le tour », « au début de... », etc. et les points de contrôle
// n'ont rien à traiter tant que les capacités ne sont pas gérées : ils sont seulement
// signalés en commentaire, à leur place exacte, pour les brancher plus tard.

import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type GameState, type PlayerId } from "../state/types";
import { drawCards } from "./basic";
import { checkDefeat } from "./defeat";
import { cardHasKeyword, KW, readyBlockedByEffect } from "./keywords";
import { forgetCard } from "./zones";
import { warpAtEndOfTurn } from "./alt-play";
import { activePermanentEffects, negatesOwnKeyword } from "./permanents";
import { startResolution } from "./effects";

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
  s.attackLimits = s.attackLimits.filter((l) => l.untilTurn >= turnNumber);
  s.attackTaxes = s.attackTaxes.filter((t) => t.untilTurn >= turnNumber);
  s.restrictions = s.restrictions.filter((r) => r.untilTurn >= turnNumber);
  s.delayed = s.delayed.filter((d) => d.untilTurn >= turnNumber);
  s.drawReplacements = s.drawReplacements.filter((d) => d.untilTurn >= turnNumber);
  s.nextDiscounts = s.nextDiscounts.filter((d) => d.untilTurn >= turnNumber);
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
  for (const c of [...p.battle, ...p.energy, ...p.unison]) if (!locked.has(c.uid)) c.mode = "active";
  events.push({ type: "CARDS_READIED", player });

  // 7-2-8 : point de contrôle.
  // 7-2-9 : le joueur actif pioche une carte, sauf le premier joueur à son premier tour (7-2-9-1).
  const isFirstTurnOfFirstPlayer = turnNumber === 1 && player === s.firstPlayer;
  if ((!isFirstTurnOfFirstPlayer || s.rules.firstTurnDraw) && s.rules.drawPerTurn > 0) {
    drawCards(s, player, s.rules.drawPerTurn, events);
    if (checkDefeat(s, events)) return;
  }

  // 7-2-10 : point de contrôle.
  // 7-2-11 : le joueur actif peut placer une carte de sa main dans sa Zone d'Énergie
  // (partie personnalisée : plusieurs, ou aucune).
  if (s.rules.chargePerTurn > 0) s.pending = { type: "CHARGE", player };
  else startMainPhase(s, events);
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
    // Certaines cartes annulent leur propre Fuite d'énergie (« s'il y a une autre carte vert-jaune
    // parmi vos Énergies »).
    const exhaust =
      cardHasKeyword(ctx.cards.get(card!.cardId), KW.energyExhaust) && !negatesOwnKeyword(s, action.player, card!, KW.energyExhaust, ctx);
    card!.mode = exhaust ? "rest" : "active";
    card!.faceUp = true;
    p.energy.push(card!);
    events.push({ type: "ENERGY_CHARGED", player: action.player, uid: card!.uid, cardId: card!.cardId, mode: card!.mode });
    // « Quand vous placez cette carte dans vos Énergies, vous pouvez [coût]. Si vous le faites,
    // annulez sa Fuite d'énergie » (ex. Xeres et Sawar) : le joueur décide, puis la phase principale.
    const placed = exhaust
      ? activePermanentEffects(s, action.player, card!, ctx).find((e) => e["do"] === "on_placed_in_energy")
      : undefined;
    if (placed) {
      s.phase = "main";
      events.push({ type: "PHASE_STARTED", player: s.turnPlayer, phase: "main" });
      const opt = (placed["optional"] ?? {}) as Record<string, unknown>;
      startResolution(
        s,
        ctx,
        action.player,
        { uid: card!.uid, cardId: card!.cardId },
        [{ do: "optional", cost: opt["cost"] ?? [], then: opt["then"] ?? [] }],
        { kind: "restore", pending: { type: "MAIN", player: s.turnPlayer } },
        events,
      );
      return null;
    }
    // Partie personnalisée : encore une Énergie à placer ?
    s.turnUsage["charges"] = (s.turnUsage["charges"] ?? 0) + 1;
    if (s.turnUsage["charges"] < s.rules.chargePerTurn && p.hand.length > 0) {
      s.pending = { type: "CHARGE", player: action.player };
      return null;
    }
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

/** Applique les effets « à la fin du tour » de ce tour (la carte doit toujours être en jeu). */
function endOfTurnEffects(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const due = s.endOfTurn.filter((e) => e.turn === s.turnNumber);
  s.endOfTurn = s.endOfTurn.filter((e) => e.turn !== s.turnNumber);
  for (const e of due) {
    for (const pl of ["P1", "P2"] as const) {
      const zone = s.players[pl].battle;
      const card = zone.find((c) => c.uid === e.uid);
      if (!card) continue;
      if (e.action === "set_active") {
        if (card.mode === "rest" && !readyBlockedByEffect(s, card.uid)) {
          card.mode = "active";
          events.push({ type: "CARDS_MODE_CHANGED", uids: [card.uid], mode: "active" });
        }
        continue;
      }
      zone.splice(zone.indexOf(card), 1);
      forgetCard(s, card.uid);
      card.mode = "active";
      if (e.action === "return_to_hand") {
        card.faceUp = false;
        s.players[card.owner].hand.push(card);
        events.push({ type: "EFFECT_NOTE", player: e.player, cardId: card.cardId, text: "retourne dans la main à la fin du tour" });
      } else {
        card.faceUp = true;
        s.players[card.owner].removed.push(card);
        events.push({ type: "CARD_REMOVED", player: pl, uid: card.uid, cardId: card.cardId });
      }
    }
  }
}

/** 7-3-4-5 : le joueur actif termine sa phase principale. */
export function endMainPhase(s: GameState, events: GameEvent[], ctx: GameContext): void {
  // 7-3-5 : étape de Fin de la phase principale (effets « à la fin de la phase principale »,
  // point de contrôle, fin des effets « pour toute la phase principale »).
  // 7-4 : phase de Fin.
  s.phase = "end";
  s.pending = null;
  events.push({ type: "PHASE_STARTED", player: s.turnPlayer, phase: "end" });
  // 7-4-2 à 7-4-6 : effets « à la fin du tour », points de contrôle, fin des effets du tour.
  // 7-4-7 : le tour se termine, l'adversaire devient le joueur actif.
  // 7-4-2 : effets « à la fin du tour » — 22-15-6 [Espace-temps], « passez-la en mode Action »,
  // « retournez cette carte dans votre main », « retirez cette carte de la partie ».
  endOfTurnEffects(s, ctx, events);
  warpAtEndOfTurn(s, events);
  events.push({ type: "TURN_ENDED", player: s.turnPlayer });
  startTurn(s, opponentOf(s.turnPlayer), s.turnNumber + 1, events);
}
