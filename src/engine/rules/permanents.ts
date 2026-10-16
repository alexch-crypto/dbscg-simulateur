// Capacités [Permanent] (manuel 9-5) qu'une carte applique à elle-même, et celles du Leader
// qui changent les règles de jeu. Elles sont valides tant que leurs conditions sont remplies.
//
// Gérées :
//   modify_energy_cost  (this, main)   ex. Piccolo Daimaô : -1 par carte verte non « Saiyan »...
//   modify_combo_cost   (this, main)   ex. Freezer, Empereur planétaire : -1 coût de Combo
//   negate_keyword      (this)         ex. Overdrive / Anilaza : annule leur [Fuite d'énergie]
//   successor_may_use_opponent_cards   Leader Freezer face arrière

import { abilitiesOf } from "../cards/abilities";
import type { GameContext } from "../protocol";
import type { CardInstance, GameState, PlayerId } from "../state/types";
import { checkConditions, matchesFilter } from "./conditions";

type Json = Record<string, unknown>;

/** Effets des [Permanent] d'une carte dont les conditions sont remplies. */
export function activePermanentEffects(
  s: GameState,
  player: PlayerId,
  card: { uid: string; cardId: string },
  ctx: GameContext,
  side?: "front" | "back",
): Json[] {
  const result: Json[] = [];
  for (const ability of abilitiesOf(ctx.cards, ctx.cards.get(card.cardId), side)) {
    if (ability["kind"] !== "permanent") continue;
    if (checkConditions(s, player, ability["condition"], ctx.cards, card.uid) !== true) continue;
    for (const e of (ability["effect"] ?? []) as Json[]) result.push(e);
  }
  return result;
}

/** Nombre de cartes correspondant à une description « pour chaque carte ... parmi vos zones ». */
function countCards(s: GameState, player: PlayerId, spec: Json, ctx: GameContext): number {
  const zones = (spec["zones"] ?? []) as string[];
  const zoneName = (z: string) => (z === "z_energy" ? "zEnergy" : z) as "zEnergy" | "drop" | "energy" | "battle" | "hand";
  let n = 0;
  for (const z of zones) {
    const cards: CardInstance[] = s.players[player][zoneName(z)] ?? [];
    n += cards.filter((c) => matchesFilter(c, spec["filter"], ctx.cards, s) === true).length;
  }
  return n;
}

/** Modification du coût d'énergie d'une carte de la main par ses propres [Permanent]. */
export function handCostChange(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext): number {
  let change = 0;
  for (const e of activePermanentEffects(s, player, card, ctx)) {
    if (e["do"] !== "modify_energy_cost" || e["target"] !== "this" || e["zone"] !== "hand") continue;
    const amount = e["amount"];
    if (typeof amount === "number") change += amount;
    else if (amount === "-count" && typeof e["count"] === "object") change -= countCards(s, player, e["count"] as Json, ctx);
  }
  return change;
}

/** Modification du coût de Combo d'une carte de la main par ses propres [Permanent]. */
export function comboCostChange(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext): number {
  let change = 0;
  for (const e of activePermanentEffects(s, player, card, ctx)) {
    if (e["do"] === "modify_combo_cost" && e["target"] === "this" && typeof e["amount"] === "number") change += e["amount"];
  }
  return change;
}

/** La carte annule-t-elle elle-même ce mot-clé (« annulez la Capacité X de cette carte ») ? */
export function negatesOwnKeyword(s: GameState, player: PlayerId, card: CardInstance, keyword: string, ctx: GameContext): boolean {
  return activePermanentEffects(s, player, card, ctx).some(
    (e) => e["do"] === "negate_keyword" && e["keyword"] === keyword && e["target"] === "this",
  );
}

/**
 * Leader Freezer face arrière : « Quand vous choisissez des cartes pour le coût de Successeur
 * d'un <Freezer> de votre main, une fois par tour, vous pouvez choisir des cartes de Combat
 * adverses en tant que cartes de Combat exclusivement vertes. » Renvoie le filtre de la carte
 * avec Successeur concernée, ou null.
 */
export function successorOpponentCardsFilter(s: GameState, player: PlayerId, ctx: GameContext): Json | null {
  const leader = s.players[player].leader;
  for (const e of activePermanentEffects(s, player, leader, ctx, leader.side)) {
    if (e["do"] === "successor_may_use_opponent_cards") return (e["applies_to"] ?? {}) as Json;
  }
  return null;
}
