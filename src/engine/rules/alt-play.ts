// Mises en jeu par Capacité-clef depuis la main : [Successeur] (22-38) et [Espace-temps] (22-15).
//
// [Successeur] (Activation : Principale) :
//   - choisir des cartes de Combat de sa Zone de Combat exclusivement vertes, exclusivement
//     jaunes et/ou multicolores vert-jaune dont le total des coûts d'énergie ACTUELS est
//     EXACTEMENT égal au coût d'énergie imprimé de la carte (décision du joueur) ;
//   - les placer dans la Dispersion de leur propriétaire, payer le coût de Capacité
//     (énergie, « piochez X cartes »...), puis jouer la carte.
//   - Leader Freezer face arrière : une fois par tour, des cartes de Combat adverses peuvent
//     être choisies, en tant que cartes exclusivement vertes.
//   - Zarbon, Accompagnateur : réduit le coût de Capacité du prochain Successeur.
// [Espace-temps X] (Activation : Principale) : avec X cartes ou plus dans sa Dispersion,
//   transférer toute sa Dispersion dans sa Dimension parallèle, puis jouer la carte ; si elle
//   est toujours dans la Zone de Combat à la fin du tour, elle part en Dimension parallèle.
//   [Espace-temps] et [Espace-temps obscur] : une seule fois par tour au total (22-15-7).

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Color } from "../cards/types";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import { opponentOf, type CardInstance, type EffectStep, type GameState, type PlayerId } from "../state/types";
import { queueTriggers } from "./autos";
import { drawCards } from "./basic";
import { checkConditions, currentEnergyCost, energyCostOf, matchesFilter } from "./conditions";
import { checkDefeat } from "./defeat";
import { startResolution } from "./effects";
import { availableEnergySources, findPayment, type EnergyPayment } from "./energy";
import { removeIfUltimate } from "./keywords";
import { successorOpponentCardsFilter } from "./permanents";
import { payEnergy } from "./play";
import { forgetCard } from "./zones";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// [Successeur]
// ---------------------------------------------------------------------------

export interface SuccessorOption {
  uid: string;
  cardId: string;
  index: number;
  ability: RawAbility;
  /** Coût d'énergie imprimé de la carte : total exact à atteindre avec les cartes sacrifiées. */
  target: number;
  /** Cartes de Combat utilisables (les siennes, et éventuellement celles de l'adversaire). */
  pool: { uid: string; owner: PlayerId; cost: number }[];
  /** Variantes du coût d'énergie (« (vert)/(jaune) » = deux variantes), réductions comprises. */
  energyVariants: EnergyPayment[];
  /** Nombre de cartes à piocher en coût de Capacité. */
  draw: number;
  /** Une des cartes de la réserve vient de l'adversaire (via le Leader). */
  usesOpponentCards: boolean;
}

const GREEN_YELLOW: Color[][] = [["green"], ["yellow"], ["green", "yellow"]];
const sameColors = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c) => b.includes(c));

/** Réductions « prochain Successeur » applicables à cette carte (la plus ancienne d'abord). */
function discountFor(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext) {
  return s.successorDiscounts.find((d) => {
    if (d.player !== player || d.untilTurn < s.turnNumber) return false;
    const { zone: _zone, ...filter } = d.filter as Json;
    return matchesFilter(card, filter, ctx.cards, s) === true;
  });
}

function applyDiscount(payment: EnergyPayment, discount: ReturnType<typeof discountFor>): EnergyPayment {
  if (!discount) return payment;
  const colors = { ...payment.colors };
  let generic = payment.generic;
  for (const [c, n] of Object.entries(discount.colors) as [Color, number][]) {
    const removed = Math.min(colors[c] ?? 0, n);
    colors[c] = (colors[c] ?? 0) - removed;
    if (colors[c] === 0) delete colors[c];
  }
  generic = Math.max(0, generic - discount.generic);
  return { colors, generic };
}

/** Existe-t-il un sous-ensemble de coûts dont la somme vaut exactement `target` ? */
function subsetSumExists(costs: number[], target: number): boolean {
  let reachable = new Set([0]);
  for (const c of costs) {
    const next = new Set(reachable);
    for (const r of reachable) if (r + c <= target) next.add(r + c);
    reachable = next;
  }
  return reachable.has(target);
}

/** Quelques sous-ensembles (uids) dont la somme vaut exactement `target` (pour les coups proposés). */
export function exactSubsets(pool: SuccessorOption["pool"], target: number, limit = 20): string[][] {
  const result: string[][] = [];
  const walk = (i: number, sum: number, chosen: string[]) => {
    if (result.length >= limit) return;
    if (sum === target && chosen.length > 0) {
      result.push([...chosen]);
      return;
    }
    if (i >= pool.length || sum > target) return;
    walk(i + 1, sum + pool[i]!.cost, [...chosen, pool[i]!.uid]);
    walk(i + 1, sum, chosen);
  };
  walk(0, 0, []);
  return result;
}

/** Les Successeurs que `player` peut activer maintenant (phase principale, depuis la main). */
export function successorOptions(s: GameState, player: PlayerId, ctx: GameContext): SuccessorOption[] {
  if (s.pending?.type !== "MAIN" || s.pending.player !== player) return [];
  const p = s.players[player];
  const sources = availableEnergySources(s, player, ctx.cards);
  const result: SuccessorOption[] = [];
  for (const card of p.hand) {
    const def = ctx.cards.get(card.cardId);
    if (def?.type !== "battle") continue;
    abilitiesOf(ctx.cards, def).forEach((ability, index) => {
      if (ability["kind"] !== "successor") return;
      const limits = (ability["limits"] ?? {}) as Json;
      if (typeof limits["limit"] === "number" && (s.turnUsage[`limit:${player}:${card.cardId}#${index}`] ?? 0) >= limits["limit"]) return;
      if (checkConditions(s, player, ability["condition"], ctx.cards, card.uid) !== true) return;
      // Coût de Capacité : énergie (éventuellement « au choix »), « piochez X ».
      let variants: EnergyPayment[] = [{ colors: {}, generic: 0 }];
      let draw = 0;
      for (const c of (ability["cost"] ?? []) as Json[]) {
        if (c["do"] === "pay_energy") {
          variants = [{ colors: (c["specified"] ?? {}) as EnergyPayment["colors"], generic: (c["generic"] as number) ?? 0 }];
        } else if (c["do"] === "pay_energy_one_of") {
          variants = ((c["options"] ?? []) as Json[]).map((o) => ({ colors: o as EnergyPayment["colors"], generic: 0 }));
        } else if (c["do"] === "draw" && typeof c["count"] === "number") {
          draw = c["count"];
        } else {
          return; // coût pas encore géré
        }
      }
      const discount = discountFor(s, player, card, ctx);
      variants = variants.map((v) => applyDiscount(v, discount));
      if (!variants.some((v) => findPayment(sources, v))) return;
      if (p.deck.length < draw) return;
      // Réserve de cartes à sacrifier.
      const pool: SuccessorOption["pool"] = p.battle
        .filter((c) => GREEN_YELLOW.some((colors) => sameColors(ctx.cards.get(c.cardId)?.colors ?? [], colors)))
        .map((c) => ({ uid: c.uid, owner: player, cost: currentEnergyCost(s, c, ctx.cards) }));
      let usesOpponentCards = false;
      const oppFilter = successorOpponentCardsFilter(s, player, ctx);
      if (oppFilter && !s.turnUsage[`successor_opponent:${player}`]) {
        const { zone: _zone, ...filter } = oppFilter;
        if (matchesFilter(card, filter, ctx.cards, s) === true) {
          const opp = opponentOf(player);
          for (const c of s.players[opp].battle) pool.push({ uid: c.uid, owner: opp, cost: currentEnergyCost(s, c, ctx.cards) });
          usesOpponentCards = s.players[opp].battle.length > 0;
        }
      }
      const target = energyCostOf(def);
      if (!subsetSumExists(pool.map((x) => x.cost), target)) return;
      result.push({ uid: card.uid, cardId: card.cardId, index, ability, target, pool, energyVariants: variants, draw, usesOpponentCards });
    });
  }
  return result;
}

/** Paiement suggéré pour une variante de coût d'énergie (ou null si impayable). */
export function suggestPayment(s: GameState, player: PlayerId, payment: EnergyPayment, ctx: GameContext): PaymentChoice | null {
  const chosen = findPayment(availableEnergySources(s, player, ctx.cards), payment);
  if (!chosen) return null;
  return {
    energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
    markers: chosen.filter((src) => src.id === "marker").length,
  };
}

/** Déplace une carte de la Zone de Combat vers la Dispersion de son propriétaire via une Capacité. */
function battleToDrop(s: GameState, ctx: GameContext, owner: PlayerId, card: CardInstance, events: GameEvent[]): void {
  const zone = s.players[owner].battle;
  zone.splice(zone.indexOf(card), 1);
  forgetCard(s, card.uid);
  events.push({ type: "CARD_TO_DROP", player: owner, uid: card.uid, cardId: card.cardId, from: "battle" });
  if (removeIfUltimate(s, card, ctx.cards)) {
    events.push({ type: "CARD_REMOVED", player: owner, uid: card.uid, cardId: card.cardId });
  } else {
    card.mode = "active";
    card.faceUp = true;
    s.players[card.owner].drop.push(card);
  }
  // « Quand cette carte quitte une Zone de Combat via une Capacité » (ex. Zarbon P-223).
  queueTriggers(s, { event: "leaves_battle", card }, ctx, events);
}

/** 22-38 : activer [Successeur]. */
export function activateSuccessor(
  s: GameState,
  action: Extract<Action, { type: "SUCCESSOR" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const option = successorOptions(s, action.player, ctx).find((o) => o.uid === action.uid);
  if (!option) return "22-38 : [Successeur] ne peut pas être activé (condition, limite, coût ou cartes insuffisantes)";
  // Les cartes choisies : distinctes, dans la réserve, total EXACT.
  const chosen = action.sacrifice;
  if (new Set(chosen).size !== chosen.length) return "22-38 : une même carte est choisie deux fois";
  const picked = chosen.map((uid) => option.pool.find((x) => x.uid === uid));
  if (picked.some((x) => !x)) return "22-38 : seules des cartes de Combat exclusivement vertes, jaunes ou vert-jaune peuvent être choisies";
  const total = picked.reduce((sum, x) => sum + x!.cost, 0);
  if (total !== option.target) {
    return `22-38 : le total des coûts choisis (${total}) doit être exactement égal à ${option.target}`;
  }
  const variant = option.energyVariants[action.variant ?? 0];
  if (!variant) return "variante de coût inconnue";
  const resume = s.pending!;
  // Coût d'énergie (réductions comprises).
  const error = payEnergy(s, action.player, variant, action.payment, ctx);
  if (error) return error;
  const successorCard = s.players[action.player].hand.find((c) => c.uid === option.uid)!;
  successorCard.faceUp = true; // 9-4-2 : révélée
  const discount = discountFor(s, action.player, successorCard, ctx);
  if (discount) s.successorDiscounts.splice(s.successorDiscounts.indexOf(discount), 1);
  events.push({
    type: "SUCCESSOR_ACTIVATED",
    player: action.player,
    uid: option.uid,
    cardId: option.cardId,
    sacrificed: picked.map((x) => x!.uid),
  });
  // 22-38-3 : les cartes choisies vont dans la Dispersion de leur propriétaire.
  if (picked.some((x) => x!.owner !== action.player)) s.turnUsage[`successor_opponent:${action.player}`] = 1;
  for (const x of picked) {
    const card = s.players[x!.owner].battle.find((c) => c.uid === x!.uid)!;
    battleToDrop(s, ctx, x!.owner, card, events);
  }
  // « Piochez X cartes » fait partie du coût (décision du joueur).
  if (option.draw > 0) {
    drawCards(s, action.player, option.draw, events);
    if (checkDefeat(s, events)) return null;
  }
  const limits = (option.ability["limits"] ?? {}) as Json;
  if (typeof limits["limit"] === "number") {
    const key = `limit:${action.player}:${option.cardId}#${option.index}`;
    s.turnUsage[key] = (s.turnUsage[key] ?? 0) + 1;
  }
  // 22-10-3-1 : fenêtre de [Contre : Mise en jeu], puis 22-38-5 : la carte est jouée.
  const steps: EffectStep[] = [{ do: "counter_window_play" }, { do: "play_self", from: "hand", via: "successor" }];
  startResolution(s, ctx, action.player, { uid: option.uid, cardId: option.cardId }, steps, { kind: "restore", pending: resume }, events);
  return null;
}

// ---------------------------------------------------------------------------
// [Espace-temps]
// ---------------------------------------------------------------------------

/** Cartes de la main que `player` peut jouer via [Espace-temps] maintenant. */
export function overRealmOptions(s: GameState, player: PlayerId, ctx: GameContext): CardInstance[] {
  if (s.pending?.type !== "MAIN" || s.pending.player !== player) return [];
  if (s.turnUsage[`over_realm:${player}`]) return []; // 22-15-7
  const p = s.players[player];
  return p.hand.filter((c) => {
    const def = ctx.cards.get(c.cardId);
    const keyword = def?.keywords.find((k) => k.id === "over_realm");
    return def?.type === "battle" && keyword !== undefined && p.drop.length >= (keyword.value ?? 0);
  });
}

/** 22-15 : activer [Espace-temps]. */
export function activateOverRealm(
  s: GameState,
  action: Extract<Action, { type: "OVER_REALM" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const card = overRealmOptions(s, action.player, ctx).find((c) => c.uid === action.uid);
  if (!card) return "22-15 : [Espace-temps] ne peut pas être activé (cartes dans la Dispersion, ou déjà utilisé ce tour)";
  const resume = s.pending!;
  const p = s.players[action.player];
  s.turnUsage[`over_realm:${action.player}`] = 1;
  card.faceUp = true; // 9-4-2 : révélée
  // 22-15-4 : coût — transférer toute sa Dispersion dans sa Dimension parallèle.
  const moved = p.drop.splice(0);
  p.warp.push(...moved);
  events.push({ type: "OVER_REALM_ACTIVATED", player: action.player, uid: card.uid, cardId: card.cardId, warped: moved.length });
  const steps: EffectStep[] = [{ do: "counter_window_play" }, { do: "play_self", from: "hand", via: "over_realm" }];
  startResolution(s, ctx, action.player, { uid: card.uid, cardId: card.cardId }, steps, { kind: "restore", pending: resume }, events);
  return null;
}

/** 22-15-6 : à la fin du tour, les cartes jouées via [Espace-temps] partent en Dimension parallèle. */
export function warpAtEndOfTurn(s: GameState, events: GameEvent[]): void {
  const marked = new Set(s.effects.filter((e) => e.kind === "warp_at_end_of_turn").map((e) => e.uid));
  if (marked.size === 0) return;
  for (const player of ["P1", "P2"] as const) {
    const zone = s.players[player].battle;
    for (const card of [...zone]) {
      if (!marked.has(card.uid)) continue;
      zone.splice(zone.indexOf(card), 1);
      forgetCard(s, card.uid);
      card.mode = "active";
      card.faceUp = true;
      s.players[card.owner].warp.push(card);
      events.push({ type: "CARDS_TO_WARP", player: card.owner, cardIds: [card.cardId] });
    }
  }
  s.effects = s.effects.filter((e) => e.kind !== "warp_at_end_of_turn");
}
