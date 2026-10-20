// [Union-Fusion] (manuel 22-13-4) : jouer une carte de Combat depuis sa main en révélant puis en
// plaçant dans sa Dispersion une carte de chaque personnage indiqué, avec la MÊME puissance, puis
// en payant le coût de Capacité (énergie, « piochez une carte »...).
//
// Les réductions « la prochaine fois que vous activez la Capacité Union d'un <...> » (Pan,
// Adorable Soutien ; Fusion ultime) s'appliquent au coût de Capacité, puis sont consommées.

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Color } from "../cards/types";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import type { CardInstance, GameState, NextDiscount, PlayerId } from "../state/types";
import { queueTriggers } from "./autos";
import { drawCards } from "./basic";
import { abilityConditions, checkConditions, matchesFilter } from "./conditions";
import { openCounterWindow } from "./counters";
import { availableEnergySources, findPayment, type EnergyPayment } from "./energy";
import { uniqueBlocks } from "./keywords";
import { payEnergy } from "./play";

type Json = Record<string, unknown>;

export interface UnionOption {
  uid: string;
  cardId: string;
  ability: RawAbility;
  /** Coût d'énergie de la Capacité, réductions comprises. */
  energy: EnergyPayment;
  draw: number;
  /** Réduction consommée par cette activation (s'il y en a une). */
  discount: NextDiscount | null;
  /** Paires (ou groupes) de cartes de la main utilisables, de même puissance. */
  materials: string[][];
}

/** Réduction « prochaine Capacité Union » applicable à cette carte (la plus ancienne d'abord). */
function unionDiscount(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext): NextDiscount | null {
  return (
    s.nextDiscounts.find((d) => {
      if (d.player !== player || d.on !== "union" || d.untilTurn < s.turnNumber) return false;
      const { zone: _zone, ...filter } = d.filter as Json;
      return matchesFilter(card, filter, ctx.cards, s) === true;
    }) ?? null
  );
}

function applyDiscount(payment: EnergyPayment, d: NextDiscount | null): EnergyPayment {
  if (!d) return payment;
  const colors = { ...payment.colors };
  for (const [c, n] of Object.entries(d.colors) as [Color, number][]) {
    colors[c] = Math.max(0, (colors[c] ?? 0) - n);
    if (colors[c] === 0) delete colors[c];
  }
  return { colors, generic: Math.max(0, payment.generic - d.generic) };
}

/** Groupes de cartes de la main (une par description) ayant toutes la même puissance. */
function materialGroups(hand: CardInstance[], specs: Json[], exclude: string, ctx: GameContext, s: GameState): string[][] {
  const result: string[][] = [];
  const pick = (i: number, chosen: CardInstance[]) => {
    if (i === specs.length) {
      const powers = new Set(chosen.map((c) => ctx.cards.get(c.cardId)?.power));
      if (powers.size === 1) result.push(chosen.map((c) => c.uid));
      return;
    }
    for (const c of hand) {
      if (c.uid === exclude || chosen.includes(c)) continue;
      if (ctx.cards.get(c.cardId)?.type !== "battle") continue;
      if (matchesFilter(c, specs[i], ctx.cards, s) !== true) continue;
      pick(i + 1, [...chosen, c]);
    }
  };
  pick(0, []);
  return result;
}

/** Cartes de la main dont l'[Union-Fusion] peut être activée maintenant (phase principale). */
export function unionOptions(s: GameState, player: PlayerId, ctx: GameContext): UnionOption[] {
  if (s.pending?.type !== "MAIN" || s.pending.player !== player) return [];
  const p = s.players[player];
  const sources = availableEnergySources(s, player, ctx.cards);
  const result: UnionOption[] = [];
  for (const card of p.hand) {
    for (const ability of abilitiesOf(ctx.cards, ctx.cards.get(card.cardId))) {
      if (ability["kind"] !== "union_fusion") continue;
      if (uniqueBlocks(s, card, ctx.cards)) continue;
      if (checkConditions(s, player, abilityConditions(ability), ctx.cards, card.uid) !== true) continue;
      let energy: EnergyPayment = { colors: {}, generic: 0 };
      let draw = 0;
      let supported = true;
      for (const c of (ability["cost"] ?? []) as Json[]) {
        if (c["do"] === "pay_energy") energy = { colors: (c["specified"] ?? {}) as EnergyPayment["colors"], generic: (c["generic"] as number) ?? 0 };
        else if (c["do"] === "draw" && typeof c["count"] === "number") draw = c["count"];
        else supported = false;
      }
      if (!supported || p.deck.length < draw) continue;
      const discount = unionDiscount(s, player, card, ctx);
      energy = applyDiscount(energy, discount);
      if (!findPayment(sources, energy)) continue;
      const materials = materialGroups(p.hand, (ability["materials"] ?? []) as Json[], card.uid, ctx, s);
      if (materials.length === 0) continue;
      result.push({ uid: card.uid, cardId: card.cardId, ability, energy, draw, discount, materials });
    }
  }
  return result;
}

/** Paiement suggéré pour une [Union-Fusion]. */
export function suggestUnionPayment(s: GameState, player: PlayerId, option: UnionOption, ctx: GameContext): PaymentChoice {
  const chosen = findPayment(availableEnergySources(s, player, ctx.cards), option.energy) ?? [];
  return { energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id), markers: chosen.filter((src) => src.id === "marker").length };
}

/** 22-13-4 : activer l'[Union-Fusion] d'une carte de sa main. */
export function activateUnion(s: GameState, action: Extract<Action, { type: "UNION_FUSION" }>, ctx: GameContext, events: GameEvent[]): string | null {
  const option = unionOptions(s, action.player, ctx).find((o) => o.uid === action.uid);
  if (!option) return "22-13-4 : [Union-Fusion] ne peut pas être activée (cartes, coût ou moment)";
  const key = [...action.materials].sort().join(",");
  if (!option.materials.some((m) => [...m].sort().join(",") === key)) {
    return "22-13-4 : il faut une carte de chaque personnage indiqué, toutes avec la même puissance, depuis votre main";
  }
  // Coût : les cartes indiquées vont dans la Dispersion, puis l'énergie, puis « piochez ».
  const p = s.players[action.player];
  const error = payEnergy(s, action.player, option.energy, action.payment, ctx);
  if (error) return error;
  const card = p.hand.find((c) => c.uid === option.uid)!;
  card.faceUp = true;
  const used: string[] = [];
  for (const uid of action.materials) {
    const i = p.hand.findIndex((c) => c.uid === uid);
    const m = p.hand.splice(i, 1)[0]!;
    m.faceUp = true;
    m.mode = "active";
    s.players[m.owner].drop.push(m);
    used.push(m.cardId);
  }
  if (option.discount) s.nextDiscounts.splice(s.nextDiscounts.indexOf(option.discount), 1);
  events.push({ type: "UNION_ACTIVATED", player: action.player, uid: card.uid, cardId: card.cardId, materials: used });
  drawCards(s, action.player, option.draw, events);
  // « Quand vous activez une Capacité Union » (ex. Leader Gogeta SS4, Vaniteux).
  queueTriggers(s, { event: "union_activated", player: action.player }, ctx, events);
  // 22-10-3-1 : fenêtre de [Contre : Mise en jeu], puis la carte est jouée.
  s.pending = null;
  openCounterWindow(
    s,
    ctx,
    { on: "play", player: action.player, cardUid: card.uid, cardId: card.cardId },
    { kind: "finish_play", player: action.player, uid: card.uid },
    events,
  );
  return null;
}
