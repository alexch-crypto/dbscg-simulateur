// Déplacements de cartes hors de la Zone de Combat (KO...), partagés par le combat et les effets.

import type { GameContext, GameEvent } from "../protocol";
import type { CardInstance, GameState, PlayerId } from "../state/types";
import { queueTriggers } from "./autos";
import { removeIfUltimate } from "./keywords";

/** 9-9-2 : les effets temporaires ne suivent pas une carte qui quitte la Zone de Combat. */
export function forgetCard(s: GameState, uid: string): void {
  s.powerMods = s.powerMods.filter((m) => m.uid !== uid);
}

/**
 * 5-12 / 21-14 : mettre KO une carte de Combat (vers la Dispersion de son propriétaire, ou
 * retirée de la partie si elle a [Ultimate], 22-14-3). Déclenche « quand cette carte quitte la
 * Zone de Combat / est mise KO ».
 */
export function koBattleCard(s: GameState, ctx: GameContext, player: PlayerId, card: CardInstance, events: GameEvent[]): void {
  const zone = s.players[player].battle;
  const index = zone.indexOf(card);
  if (index < 0) return;
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
  queueTriggers(s, { event: "leaves_battle", card }, ctx, events);
}
