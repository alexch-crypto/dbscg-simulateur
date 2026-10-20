// Deck Z (manuel 1-3, 1-4, 3-12, 3-13, 14 à 18) : jouer des cartes Z, payer l'Énergie Z,
// Unissons (marqueurs) et [Éveil Z].
//
//  - Carte de Combat Z (16-2-1), Extra Z (17-2-1), Unisson Z (18-2-1) : pendant sa phase
//    principale, révéler la carte, payer son coût d'Énergie ET son coût d'Énergie Z (placer ce
//    nombre de cartes de sa Zone d'Énergie Z dans sa Dispersion, 5-4), fenêtre de contre, puis :
//      Combat Z  → Zone de Combat ; Extra Z → Zone de Combat (une seule Extra Z à la fois,
//      17-2-1-3) ; Unisson Z → Zone Unisson (une seule, 3-11-4), avec autant de marqueurs que
//      d'Énergies passées en mode Inertie (18-2-1-3).
//  - [Éveil Z] (Leader Z) : quand on veut pendant son tour (phase principale, étape d'Attaque),
//    conditions + coût de Capacité + coût d'Énergie Z ; le Leader Z est posé par-dessus le
//    Leader et garde son mode (décision du joueur).
//  - Une carte Z qui quitte sa zone est retirée de la partie (14-1-4, voir removeIfUltimate).

import { abilitiesOf } from "../cards/abilities";
import type { CardDefinition } from "../cards/types";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import type { CardInstance, GameState, PlayerId } from "../state/types";
import { checkpoint, queueTriggers } from "./autos";
import { abilityConditions, checkConditions, matchesFilter } from "./conditions";
import { openCounterWindow } from "./counters";
import { applyCostModifiers, availableEnergySources, findPayment, paymentForCost, paymentSize, type EnergyPayment } from "./energy";
import { removeIfUltimate } from "./keywords";
import { activePermanentEffects, zoneCostModifiers } from "./permanents";
import { payEnergy } from "./play";
import { forgetCard, leaveUnison } from "./zones";

type Json = Record<string, unknown>;

/** Type de carte Z jouable depuis le deck Z. */
type ZKind = "battle" | "extra" | "unison";
const Z_KINDS: Record<string, ZKind> = { z_battle: "battle", z_extra: "extra", z_unison: "unison" };

export interface ZPlayOption {
  uid: string;
  cardId: string;
  kind: ZKind;
  zCost: number;
  /**
   * Paiements possibles : un seul, ou un par valeur de X (Unissons). `alt` : coût alternatif
   * (« au lieu de payer son coût d'énergie et son coût d'énergie Z, vous pouvez... »).
   */
  payments: { x?: number; payment: EnergyPayment; alt?: { zCost: number; sacrifice: string[] } }[];
}

/** « La prochaine fois que vous placez une Extra Z, réduisez de (...) son coût d'énergie » (Trunks). */
function extraZDiscount(s: GameState, player: PlayerId) {
  return s.nextDiscounts.find((d) => d.player === player && d.on === "extra_z" && d.untilTurn >= s.turnNumber) ?? null;
}

/** Paiement d'énergie d'une carte du deck Z, ses propres réductions comprises (ex. Son Gohan BT28-081). */
function zPayment(s: GameState, player: PlayerId, card: CardInstance, def: CardDefinition, ctx: GameContext, x = 0): EnergyPayment | null {
  if (!def.cost) return { colors: {}, generic: 0 };
  const mods = zoneCostModifiers(s, player, card, "z_deck", ctx);
  const discount = def.type === "z_extra" ? extraZDiscount(s, player) : null;
  if (discount) mods.push({ kind: "colors", colors: Object.fromEntries(Object.entries(discount.colors).map(([c, n]) => [c, -(n ?? 0)])) });
  return paymentForCost(applyCostModifiers(def.cost, mods, x), x);
}

/** Coût alternatif d'une carte Z (Broly SS3, le Tyran), s'il est possible maintenant. */
function zAltCost(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext) {
  for (const e of activePermanentEffects(s, player, card, ctx)) {
    if (e["do"] !== "z_play_alt_cost") continue;
    let payment: EnergyPayment = { colors: {}, generic: 0 };
    let zCost = 0;
    let filter: unknown = undefined;
    for (const step of (e["replace_with"] ?? []) as Json[]) {
      if (step["do"] === "pay_energy") payment = { colors: (step["specified"] ?? {}) as EnergyPayment["colors"], generic: (step["generic"] as number) ?? 0 };
      else if (step["do"] === "z_energy_to_drop") zCost = (step["count"] as number) ?? 1;
      else if (step["do"] === "move_to_drop") filter = ((step["target"] ?? {}) as Json)["filter"];
    }
    const sacrifice = s.players[player].battle
      .filter((b) => ["battle", "z_battle"].includes(ctx.cards.get(b.cardId)?.type ?? "") && matchesFilter(b, filter, ctx.cards, s) === true)
      .map((b) => b.uid);
    if (sacrifice.length > 0 && zCostPayable(s, player, zCost)) return { payment, zCost, sacrifice };
  }
  return null;
}

/** 5-4-3 : peut-on payer le coût d'Énergie Z ? */
const zCostPayable = (s: GameState, player: PlayerId, zCost: number) => s.players[player].zEnergy.length >= zCost;

/** Cartes du deck Z jouables maintenant (phase principale du joueur actif). */
export function zPlayOptions(s: GameState, player: PlayerId, ctx: GameContext): ZPlayOption[] {
  if (s.pending?.type !== "MAIN" || s.pending.player !== player) return [];
  const sources = availableEnergySources(s, player, ctx.cards);
  const result: ZPlayOption[] = [];
  for (const card of s.players[player].zDeck) {
    const def = ctx.cards.get(card.cardId);
    const kind = def ? Z_KINDS[def.type] : undefined;
    if (!def || !kind) continue;
    const zCost = def.zCost ?? 0;
    const payments: ZPlayOption["payments"] = [];
    const alt = zAltCost(s, player, card, ctx);
    if (alt && findPayment(sources, alt.payment)) payments.push({ payment: alt.payment, alt: { zCost: alt.zCost, sacrifice: alt.sacrifice } });
    if (!zCostPayable(s, player, zCost)) {
      if (payments.length > 0) result.push({ uid: card.uid, cardId: card.cardId, kind, zCost, payments });
      continue;
    }
    if (def.cost?.total === "X") {
      // 1-2-2-2 : coût X choisi par le joueur (au moins le coût de couleur, 1-2-2-1).
      const colorSum = Object.values(def.cost.specified).reduce((a, b) => a + (b ?? 0), 0);
      for (let x = Math.max(colorSum, 1); x <= sources.length; x++) {
        const payment = zPayment(s, player, card, def, ctx, x)!;
        if (findPayment(sources, payment)) payments.push({ x, payment });
      }
    } else {
      const payment = zPayment(s, player, card, def, ctx)!;
      if (findPayment(sources, payment)) payments.push({ payment });
    }
    if (payments.length > 0) result.push({ uid: card.uid, cardId: card.cardId, kind, zCost, payments });
  }
  return result;
}

/** Paiement suggéré (Énergies et Énergies Z) pour un coût donné. */
export function suggestZPayment(s: GameState, player: PlayerId, payment: EnergyPayment, zCost: number, ctx: GameContext) {
  const chosen = findPayment(availableEnergySources(s, player, ctx.cards), payment) ?? [];
  const energy: PaymentChoice = {
    energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
    markers: chosen.filter((src) => src.id === "marker").length,
  };
  return { payment: energy, zEnergy: s.players[player].zEnergy.slice(0, zCost).map((c) => c.uid) };
}

/** 5-4-1 : payer un coût d'Énergie Z avec les cartes choisies de sa Zone d'Énergie Z. */
function payZEnergy(s: GameState, player: PlayerId, uids: string[], zCost: number, events: GameEvent[]): string | null {
  const p = s.players[player];
  if (new Set(uids).size !== uids.length) return "5-4 : une même Énergie Z est choisie deux fois";
  if (uids.length !== zCost) return `5-4-1 : il faut placer exactement ${zCost} Énergie(s) Z dans la Dispersion`;
  const cards = uids.map((uid) => p.zEnergy.find((c) => c.uid === uid));
  if (cards.some((c) => !c)) return "5-4-1 : les Énergies Z doivent venir de votre Zone d'Énergie Z";
  for (const c of cards) {
    p.zEnergy.splice(p.zEnergy.indexOf(c!), 1);
    s.players[c!.owner].drop.push(c!);
  }
  if (cards.length > 0) events.push({ type: "Z_ENERGY_PAID", player, cardIds: cards.map((c) => c!.cardId) });
  return null;
}

/** 16-2-1 / 17-2-1 / 18-2-1 : jouer une carte de son deck Z. */
export function playFromZDeck(s: GameState, action: Extract<Action, { type: "PLAY_Z" }>, ctx: GameContext, events: GameEvent[]): string | null {
  const option = zPlayOptions(s, action.player, ctx).find((o) => o.uid === action.uid);
  if (!option) return "14 : cette carte Z ne peut pas être jouée maintenant (phase, coût d'énergie ou d'Énergie Z)";
  const choice = option.payments.find((p) => p.x === action.x && !!p.alt === (action.sacrifice !== undefined));
  if (!choice) return action.sacrifice !== undefined ? "le coût alternatif de cette carte n'est pas possible" : "1-2-2-2 : choisissez une valeur de X que vous pouvez payer";
  if (choice.alt && !choice.alt.sacrifice.includes(action.sacrifice!)) return "cette carte ne peut pas être placée dans la Dispersion pour ce coût";
  const error = payEnergy(s, action.player, choice.payment, action.payment, ctx);
  if (error) return error;
  const zError = payZEnergy(s, action.player, action.zEnergy, choice.alt ? choice.alt.zCost : option.zCost, events);
  if (zError) return zError;
  const p = s.players[action.player];
  if (choice.alt) {
    // Coût alternatif : la carte choisie de la Zone de Combat va dans la Dispersion.
    const sacrificed = p.battle.find((b) => b.uid === action.sacrifice)!;
    p.battle.splice(p.battle.indexOf(sacrificed), 1);
    forgetCard(s, sacrificed.uid);
    sacrificed.mode = "active";
    sacrificed.faceUp = true;
    s.players[sacrificed.owner].drop.push(sacrificed);
    events.push({ type: "CARD_TO_DROP", player: action.player, uid: sacrificed.uid, cardId: sacrificed.cardId, from: "battle" });
    queueTriggers(s, { event: "leaves_battle", card: sacrificed, toDrop: true }, ctx, events);
  }
  // La réduction « prochaine Extra Z » est consommée.
  if (option.kind === "extra") {
    const d = extraZDiscount(s, action.player);
    if (d) s.nextDiscounts.splice(s.nextDiscounts.indexOf(d), 1);
  }
  const card = p.zDeck.find((c) => c.uid === option.uid)!;
  card.faceUp = true; // révélée
  events.push({ type: "Z_PLAY_DECLARED", player: action.player, uid: card.uid, cardId: card.cardId, zEnergy: choice.alt ? choice.alt.zCost : option.zCost });
  s.pending = null;
  // 18-2-1-3 : l'Unisson entre en jeu avec autant de marqueurs que d'Énergies passées en mode Inertie.
  const markers = option.kind === "unison" ? paymentSize(choice.payment) : 0;
  openCounterWindow(
    s,
    ctx,
    { on: "play", player: action.player, cardUid: card.uid, cardId: card.cardId },
    { kind: "finish_z_play", player: action.player, uid: card.uid, markers },
    events,
  );
  return null;
}

/** Après la fenêtre de contre : la carte Z arrive dans sa zone. */
export function finishZPlay(s: GameState, ctx: GameContext, player: PlayerId, uid: string, markers: number, events: GameEvent[]): void {
  const p = s.players[player];
  const index = p.zDeck.findIndex((c) => c.uid === uid);
  if (index >= 0) {
    const card = p.zDeck.splice(index, 1)[0]!;
    const kind = Z_KINDS[ctx.cards.get(card.cardId)?.type ?? ""];
    card.faceUp = true;
    card.mode = "active";
    if (kind === "battle") {
      p.battle.push(card);
      events.push({ type: "CARD_PLAYED", player, uid: card.uid, cardId: card.cardId });
      queueTriggers(s, { event: "played", card }, ctx, events);
    } else if (kind === "extra") {
      // 17-2-1-3 : les autres Extras Z de votre Zone de Combat sont retirées de la partie.
      for (const other of [...p.battle]) {
        if (ctx.cards.get(other.cardId)?.type !== "z_extra") continue;
        p.battle.splice(p.battle.indexOf(other), 1);
        forgetCard(s, other.uid);
        removeIfUltimate(s, other, ctx.cards);
        events.push({ type: "CARD_REMOVED", player, uid: other.uid, cardId: other.cardId });
      }
      p.battle.push(card);
      events.push({ type: "EXTRA_Z_PLACED", player, uid: card.uid, cardId: card.cardId });
      // « Quand cette carte est placée dans une Zone de Combat ».
      queueTriggers(s, { event: "played", card }, ctx, events);
    } else {
      // 3-11-4 / 18-2-1-3 : une seule Unisson ; l'ancienne quitte la Zone Unisson.
      for (const other of [...p.unison]) leaveUnison(s, ctx, player, other, events);
      card.markers = markers;
      p.unison.push(card);
      events.push({ type: "UNISON_PLAYED", player, uid: card.uid, cardId: card.cardId, markers });
      queueTriggers(s, { event: "played", card }, ctx, events);
    }
  }
  checkpoint(s, ctx, { kind: "restore", pending: { type: "MAIN", player } }, events);
}

// ---------------------------------------------------------------------------
// [Éveil Z]
// ---------------------------------------------------------------------------

export interface ZAwakenOption {
  uid: string;
  cardId: string;
  payment: EnergyPayment;
  zCost: number;
}

/** Leaders Z du deck Z dont l'[Éveil Z] peut être activé maintenant. */
export function zAwakenOptions(s: GameState, player: PlayerId, ctx: GameContext): ZAwakenOption[] {
  const pending = s.pending;
  // Pendant son tour : phase principale ou étape d'Attaque (décision du joueur).
  if (!pending || pending.player !== player || player !== s.turnPlayer) return [];
  if (pending.type !== "MAIN" && pending.type !== "OFFENSE") return [];
  const sources = availableEnergySources(s, player, ctx.cards);
  const result: ZAwakenOption[] = [];
  for (const card of s.players[player].zDeck) {
    const def = ctx.cards.get(card.cardId);
    if (def?.type !== "z_leader") continue;
    const ability = abilitiesOf(ctx.cards, def).find((a) => a["kind"] === "z_awaken");
    if (!ability) continue;
    if (checkConditions(s, player, abilityConditions(ability), ctx.cards, card.uid) !== true) continue;
    let payment: EnergyPayment = { colors: {}, generic: 0 };
    let supported = true;
    for (const c of (ability["cost"] ?? []) as Json[]) {
      if (c["do"] === "pay_energy") {
        payment = { colors: (c["specified"] ?? {}) as EnergyPayment["colors"], generic: (c["generic"] as number) ?? 0 };
      } else supported = false;
    }
    const zCost = def.zCost ?? 0;
    if (!supported || !zCostPayable(s, player, zCost) || !findPayment(sources, payment)) continue;
    result.push({ uid: card.uid, cardId: card.cardId, payment, zCost });
  }
  return result;
}

/** [Éveil Z] : poser le Leader Z par-dessus le Leader (15-1). */
export function zAwaken(s: GameState, action: Extract<Action, { type: "Z_AWAKEN" }>, ctx: GameContext, events: GameEvent[]): string | null {
  const option = zAwakenOptions(s, action.player, ctx).find((o) => o.uid === action.uid);
  if (!option) return "[Éveil Z] : impossible maintenant (moment, condition, coût ou Énergie Z)";
  const error = payEnergy(s, action.player, option.payment, action.payment, ctx);
  if (error) return error;
  const zError = payZEnergy(s, action.player, action.zEnergy, option.zCost, events);
  if (zError) return zError;
  const p = s.players[action.player];
  const card = p.zDeck.splice(p.zDeck.findIndex((c) => c.uid === option.uid), 1)[0]!;
  // Un Leader Z déjà en place est retiré de la partie.
  if (p.leader.z) p.removed.push({ uid: p.leader.z.uid, cardId: p.leader.z.cardId, owner: action.player, mode: "active", faceUp: true });
  // Le Leader garde son mode, et reste en combat s'il y était (même uid de Leader).
  p.leader.z = { uid: card.uid, cardId: card.cardId };
  events.push({ type: "LEADER_Z", player: action.player, uid: card.uid, cardId: card.cardId });
  return null;
}

/** Retirer de la partie le Leader Z posé sur le Leader (15-1-5 : le Leader d'origine reste). */
export function removeLeaderZ(s: GameState, player: PlayerId, events: GameEvent[]): void {
  const p = s.players[player];
  const z = p.leader.z;
  if (!z) return;
  delete p.leader.z;
  p.removed.push({ uid: z.uid, cardId: z.cardId, owner: player, mode: "active", faceUp: true });
  events.push({ type: "CARD_REMOVED", player, uid: z.uid, cardId: z.cardId });
}

/** Instruction « Capacité de marqueur » d'une Unisson ([+X] / [-X], 13-4). */
export const markerCostOf = (ability: Json): number | undefined =>
  typeof ability["marker_cost"] === "number" ? ability["marker_cost"] : undefined;
