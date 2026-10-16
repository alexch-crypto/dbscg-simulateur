// Déplacements de cartes hors de la Zone de Combat (KO...), partagés par le combat et les effets.

import type { GameContext, GameEvent } from "../protocol";
import type { CardInstance, GameState, PlayerId } from "../state/types";
import { queueTriggers } from "./autos";
import { removeIfUltimate } from "./keywords";

/** 9-9-2 : les effets temporaires ne suivent pas une carte qui quitte la Zone de Combat. */
export function forgetCard(s: GameState, uid: string): void {
  s.powerMods = s.powerMods.filter((m) => m.uid !== uid);
  s.effects = s.effects.filter((e) => e.uid !== uid);
}

/**
 * 21-9 / 13-5-2 : retirer des marqueurs d'une Unisson ; à 0 marqueur, elle quitte la Zone Unisson.
 */
export function removeMarkers(s: GameState, ctx: GameContext, player: PlayerId, card: CardInstance, n: number, events: GameEvent[]): void {
  if (n <= 0 || !s.players[player].unison.includes(card)) return;
  card.markers = Math.max(0, (card.markers ?? 0) - n);
  events.push({ type: "MARKERS_CHANGED", player, uid: card.uid, cardId: card.cardId, markers: card.markers });
  if (card.markers === 0) leaveUnison(s, ctx, player, card, events);
}

/** Une Unisson quitte la Zone Unisson : Dispersion, ou retirée de la partie si c'est une carte Z. */
export function leaveUnison(s: GameState, ctx: GameContext, player: PlayerId, card: CardInstance, events: GameEvent[]): void {
  const zone = s.players[player].unison;
  const index = zone.indexOf(card);
  if (index < 0) return;
  zone.splice(index, 1);
  forgetCard(s, card.uid);
  if (removeIfUltimate(s, card, ctx.cards)) {
    events.push({ type: "CARD_REMOVED", player, uid: card.uid, cardId: card.cardId });
  } else {
    delete card.markers;
    card.mode = "active";
    card.faceUp = true;
    s.players[card.owner].drop.push(card);
    events.push({ type: "CARD_TO_DROP", player, uid: card.uid, cardId: card.cardId, from: "unison" });
  }
}

/**
 * 5-12 / 21-14 : mettre KO une carte de Combat (vers la Dispersion de son propriétaire, ou
 * retirée de la partie si elle a [Ultimate], 22-14-3). Déclenche « quand cette carte quitte la
 * Zone de Combat / est mise KO », sauf si ses Capacités étaient annulées (9-6-9-2).
 */
export function koBattleCard(s: GameState, ctx: GameContext, player: PlayerId, card: CardInstance, events: GameEvent[]): void {
  const zone = s.players[player].battle;
  const index = zone.indexOf(card);
  if (index < 0) return;
  const negated = s.effects.some((e) => e.uid === card.uid && e.kind === "negate_all");
  zone.splice(index, 1);
  forgetCard(s, card.uid);
  events.push({ type: "CARD_KO", player, uid: card.uid, cardId: card.cardId });
  if (removeIfUltimate(s, card, ctx.cards)) {
    events.push({ type: "CARD_REMOVED", player, uid: card.uid, cardId: card.cardId });
  } else {
    card.mode = "active";
    card.faceUp = true;
    s.players[card.owner].drop.push(card);
  }
  if (!negated) queueTriggers(s, { event: "leaves_battle", card }, ctx, events);
}
