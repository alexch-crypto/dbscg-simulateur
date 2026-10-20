// Capacités [Activation] (manuel 9-4 et 1-5-4) des Leaders et des cartes de Combat.
//
// Où :  Leader (face visible) et Zone de Combat ; main si la Capacité « joue cette carte
//       depuis votre main » ; Dispersion / Zone de Combo si la carte l'indique (`activates_from`).
// Quand : [Activation : Principale] => timing libre de la phase principale du joueur actif ;
//         [Activation : Combat] => étape d'Attaque (joueur actif) ou de Défense (non actif).
// Coûts gérés : (couleur)(X) en énergie, rajouter des cartes de Vie à sa main, défausser.
// Les Capacités dont le coût ou une condition n'est pas encore géré ne sont pas proposées.
// Non géré pour l'instant : fenêtres de contre (9-4-4 / 9-4-6), [Éveil] (voir awaken.ts).

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import type { CardInstance, EffectStep, GameState, PlayerId } from "../state/types";
import { abilityConditions, checkConditions, matchesFilter } from "./conditions";
import { startResolution } from "./effects";
import { availableEnergySources, findPayment, paymentForCost, type EnergyPayment } from "./energy";
import { isNegated } from "./keywords";
import { leaderAbilities, leaderCardId } from "./leader";
import { payEnergy } from "./play";
import { markerCostOf } from "./zdeck";
import { removeMarkers } from "./zones";

type Json = Record<string, unknown>;

export interface Activatable {
  uid: string;
  cardId: string;
  index: number;
  ability: RawAbility;
  /** Paiement d'énergie exigé par le coût de Capacité (null s'il n'y en a pas). */
  energy: EnergyPayment | null;
  /** Autres parties du coût, résolues comme des instructions avant l'effet. */
  otherCosts: EffectStep[];
  /** « Déclarez un nombre » (20-5) : valeurs possibles de X. */
  declare?: { min: number; max: number };
  /** 12-2 : Extra activée depuis la main (elle va dans la Dispersion, son coût d'énergie est payé). */
  extraFromHand?: boolean;
}

/** Timings d'[Activation] autorisés dans la décision en cours (1-5-4-1). */
function allowedTimings(s: GameState, player: PlayerId): string[] {
  const p = s.pending;
  if (!p || p.player !== player) return [];
  if (p.type === "MAIN") return ["main", "main_battle"];
  if (p.type === "OFFENSE" || p.type === "DEFENSE") return ["battle", "main_battle"];
  return [];
}

/** Zone depuis laquelle une Capacité s'active (12-2 : une Extra s'active depuis la main). */
function activationZone(ability: RawAbility, type?: string): "board" | "hand" | "drop" | "combo" {
  const from = ability["activates_from"];
  if (from === "drop" || from === "combo" || from === "hand") return from;
  if (type === "extra") return "hand";
  const effect = (ability["effect"] ?? []) as Json[];
  if (effect.some((e) => e["do"] === "play_self" && e["from"] === "hand")) return "hand";
  return "board";
}

/** Analyse le coût de Capacité. Renvoie null si une partie n'est pas encore gérée. */
export function parseCost(
  cost: unknown,
): { energy: EnergyPayment | null; others: EffectStep[]; declare?: { min: number; max: number } } | null {
  if (cost === undefined) return { energy: null, others: [] };
  if (!Array.isArray(cost)) return null;
  let energy: EnergyPayment | null = null;
  let declare: { min: number; max: number } | undefined;
  const others: EffectStep[] = [];
  for (const c of cost as Json[]) {
    if (c["do"] === "declare_number" && typeof c["min"] === "number" && typeof c["max"] === "number") {
      declare = { min: c["min"], max: c["max"] };
    } else if (c["do"] === "pay_energy") {
      energy = { colors: (c["specified"] ?? {}) as EnergyPayment["colors"], generic: (c["generic"] as number) ?? 0 };
    } else if (c["do"] === "life_to_hand" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else if (c["do"] === "discard" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else if (c["do"] === "spirit_boost" && typeof c["markers"] === "number") {
      // 22-43 [Boost d'Esprit X] : retirer X marqueurs de son Unisson.
      others.push(c as EffectStep);
    } else if (c["do"] === "remove_from_game" && c["target"] === "this") {
      // « Retirez cette carte de la partie » (ex. Extra Z).
      others.push(c as EffectStep);
    } else if (c["do"] === "move_to_drop" && typeof c["target"] === "object") {
      // « Placez une de vos cartes ... de votre Zone de Combat dans votre Dispersion ».
      others.push(c as EffectStep);
    } else if (c["do"] === "z_energy_to_drop" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else if (c["do"] === "hand_to_z_energy" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else if (c["do"] === "self_restriction") {
      // « Vous ne pouvez pas ... pour toute la durée du tour » : toujours payable.
      others.push(c as EffectStep);
    } else if (c["do"] === "move_self" && c["from"] === "combo" && c["to"] === "drop") {
      // « Placez cette carte dans la Dispersion de son propriétaire depuis votre Zone de Combo ».
      others.push(c as EffectStep);
    } else {
      return null;
    }
  }
  return { energy, others, ...(declare ? { declare } : {}) };
}

/** Somme de deux paiements d'énergie (ex. coût d'une Extra + coût de sa Capacité). */
function addPayments(a: EnergyPayment, b: EnergyPayment | null): EnergyPayment {
  if (!b) return a;
  const colors = { ...a.colors };
  for (const [c, n] of Object.entries(b.colors)) colors[c as keyof typeof colors] = (colors[c as keyof typeof colors] ?? 0) + (n ?? 0);
  return { colors, generic: a.generic + b.generic };
}

/** Les autres coûts (Vie, défausse) peuvent-ils être payés ? */
export function otherCostsPayable(s: GameState, player: PlayerId, others: EffectStep[], self: string, ctx: GameContext): boolean {
  const p = s.players[player];
  for (const c of others) {
    const n = c["count"] as number;
    if (c.do === "life_to_hand" && p.life.length < n) return false;
    if (c.do === "spirit_boost" && (p.unison[0]?.markers ?? 0) < (c["markers"] as number)) return false;
    if (c.do === "discard" || c.do === "hand_to_z_energy") {
      const ok = p.hand.filter((card) => card.uid !== self && matchesFilter(card, c["filter"], ctx.cards) === true);
      if (ok.length < n) return false;
    }
    if (c.do === "z_energy_to_drop" && p.zEnergy.length < n) return false;
    if (c.do === "move_to_drop") {
      const target = c["target"] as Json;
      const ok = p.battle.filter((card) => matchesFilter(card, target["filter"], ctx.cards, s) === true);
      if (ok.length < ((target["count"] as number) ?? 1)) return false;
    }
  }
  return true;
}

const usageKeys = (player: PlayerId, uid: string, cardId: string, index: number) => ({
  once: `once:${uid}:${cardId}#${index}`,
  limit: `limit:${player}:${cardId}#${index}`,
});

/** Liste des Capacités [Activation] que `player` peut activer maintenant. */
export function activatableAbilities(s: GameState, player: PlayerId, ctx: GameContext): Activatable[] {
  const timings = allowedTimings(s, player);
  if (timings.length === 0) return [];
  const p = s.players[player];
  const sources: { card: { uid: string; cardId: string }; abilities: RawAbility[]; zone: "board" | "hand" | "drop" | "combo" }[] = [];
  if (!isNegated(s, p.leader.uid)) {
    sources.push({ card: { uid: p.leader.uid, cardId: leaderCardId(p.leader) }, abilities: leaderAbilities(p.leader, ctx.cards), zone: "board" });
  }
  const add = (cards: CardInstance[], zone: "board" | "hand" | "drop" | "combo") => {
    for (const c of cards) {
      if (zone === "board" && isNegated(s, c.uid)) continue;
      sources.push({ card: c, abilities: abilitiesOf(ctx.cards, ctx.cards.get(c.cardId)), zone });
    }
  };
  add(p.battle, "board");
  add(p.unison, "board");
  add(p.hand, "hand");
  add(p.drop, "drop");
  add(p.combo, "combo");

  const sourcesOfEnergy = availableEnergySources(s, player, ctx.cards);
  const result: Activatable[] = [];
  const handIds = new Set(p.hand.map((c) => c.uid));
  // « Vous ne pouvez pas activer les Capacités d'exemplaires de cette carte » (pendant ce tour).
  const forbidden = new Set(
    s.restrictions
      .filter((r) => r.player === player && r.rule === "no_activate_copies" && r.fromTurn <= s.turnNumber && s.turnNumber <= r.untilTurn)
      .map((r) => r.cardId),
  );
  for (const { card, abilities, zone } of sources) {
    if (forbidden.has(card.cardId)) continue;
    abilities.forEach((ability, index) => {
      if (ability["kind"] !== "activate") return;
      if (!timings.includes(ability["timing"] as string)) return;
      const type = ctx.cards.get(card.cardId)?.type;
      if (activationZone(ability, zone === "hand" ? type : undefined) !== zone) return;
      const extraFromHand = type === "extra" && handIds.has(card.uid);
      // Limites : [Une fois par tour] (22-11), [Limite X] (22-44).
      const limits = (ability["limits"] ?? {}) as Json;
      const keys = usageKeys(player, card.uid, card.cardId, index);
      if (limits["once_per_turn"] && (s.turnUsage[keys.once] ?? 0) >= 1) return;
      if (typeof limits["limit"] === "number" && (s.turnUsage[keys.limit] ?? 0) >= limits["limit"]) return;
      // 13-4 : coût de marqueurs [+X] / [-X] — seulement dans la Zone Unisson, une fois par tour et
      // par carte pour toutes ses Capacités de marqueur, et pas plus de marqueurs qu'elle n'en a.
      const markerCost = markerCostOf(ability);
      let markerDeclare: { min: number; max: number } | undefined;
      if (markerCost !== undefined || ability["marker_cost"] === "-X") {
        const unison = p.unison.find((u) => u.uid === card.uid);
        if (!unison || s.turnUsage[`markers:${card.uid}`]) return;
        if (markerCost !== undefined && markerCost < 0 && (unison.markers ?? 0) < -markerCost) return;
        // [-X] : retirer X marqueurs, X au choix (au moins 1, au plus le nombre de marqueurs).
        if (ability["marker_cost"] === "-X") {
          if ((unison.markers ?? 0) < 1) return;
          markerDeclare = { min: 1, max: unison.markers ?? 0 };
        }
      }
      // Conditions (non gérées => non proposée).
      if (checkConditions(s, player, abilityConditions(ability), ctx.cards, card.uid) !== true) return;
      // Coût : géré et payable (9-2-3).
      const cost = parseCost(ability["cost"]);
      if (!cost) return;
      // 12-2-2-2 : une Extra activée depuis la main paie son coût d'énergie, en plus du coût de Capacité.
      const def = ctx.cards.get(card.cardId);
      const energy = extraFromHand && def?.cost ? addPayments(paymentForCost(def.cost), cost.energy) : cost.energy;
      if (energy && !findPayment(sourcesOfEnergy, energy)) return;
      if (!otherCostsPayable(s, player, cost.others, card.uid, ctx)) return;
      const declare = cost.declare ?? markerDeclare;
      result.push({
        uid: card.uid,
        cardId: card.cardId,
        index,
        ability,
        energy,
        otherCosts: cost.others,
        ...(declare ? { declare } : {}),
        ...(extraFromHand ? { extraFromHand: true } : {}),
      });
    });
  }
  return result;
}

/** Paiement suggéré pour le coût d'énergie d'une Capacité. */
export function suggestActivationPayment(s: GameState, player: PlayerId, a: Activatable, ctx: GameContext): PaymentChoice {
  if (!a.energy) return { energy: [], markers: 0 };
  const chosen = findPayment(availableEnergySources(s, player, ctx.cards), a.energy) ?? [];
  return {
    energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
    markers: chosen.filter((src) => src.id === "marker").length,
  };
}

/** 9-4 : activer une Capacité [Activation]. */
export function activateAbility(
  s: GameState,
  action: Extract<Action, { type: "ACTIVATE" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const a = activatableAbilities(s, action.player, ctx).find((x) => x.uid === action.uid && x.index === action.index);
  if (!a) return "9-4 : cette Capacité ne peut pas être activée maintenant (moment, condition, limite ou coût)";
  const resume = s.pending!;
  // 20-5 : « déclarez un nombre » fait partie du coût.
  if (a.declare) {
    const x = action.x;
    if (x === undefined || !Number.isInteger(x) || x < a.declare.min || x > a.declare.max) {
      return `20-5 : déclarez un nombre entre ${a.declare.min} et ${a.declare.max}`;
    }
  }
  // 9-4-2-1 : payer entièrement le coût. D'abord l'énergie (choix du joueur)...
  if (a.energy) {
    const error = payEnergy(s, action.player, a.energy, action.payment, ctx);
    if (error) return error;
  } else if (action.payment.energy.length > 0 || action.payment.markers > 0) {
    return "cette Capacité n'a pas de coût d'énergie";
  }
  // 9-4-2 : la carte est révélée si elle est en main. 12-2-2-2 : une Extra va dans la Dispersion.
  const hand = s.players[action.player].hand;
  const inHand = hand.find((c) => c.uid === a.uid);
  if (inHand) inHand.faceUp = true;
  if (inHand && a.extraFromHand) {
    hand.splice(hand.indexOf(inHand), 1);
    inHand.mode = "active";
    s.players[inHand.owner].drop.push(inHand);
  }
  events.push({
    type: "ABILITY_ACTIVATED",
    player: action.player,
    uid: a.uid,
    cardId: a.cardId,
    index: a.index,
    text: String(a.ability["text"] ?? ""),
  });
  // 13-4-1 : coût de marqueurs (ajout immédiat, ou retrait ; à 0 l'Unisson quitte la zone, 21-9).
  const markerCost = markerCostOf(a.ability);
  if (a.ability["marker_cost"] === "-X") {
    s.turnUsage[`markers:${a.uid}`] = 1;
    const unison = s.players[action.player].unison.find((u) => u.uid === a.uid)!;
    removeMarkers(s, ctx, action.player, unison, action.x ?? 0, events);
  } else if (markerCost !== undefined) {
    s.turnUsage[`markers:${a.uid}`] = 1;
    const unison = s.players[action.player].unison.find((u) => u.uid === a.uid)!;
    if (markerCost > 0) {
      unison.markers = (unison.markers ?? 0) + markerCost;
      events.push({ type: "MARKERS_CHANGED", player: action.player, uid: unison.uid, cardId: unison.cardId, markers: unison.markers });
    } else if (markerCost < 0) {
      removeMarkers(s, ctx, action.player, unison, -markerCost, events);
    }
  }
  const limits = (a.ability["limits"] ?? {}) as Json;
  const keys = usageKeys(action.player, a.uid, a.cardId, a.index);
  if (limits["once_per_turn"]) s.turnUsage[keys.once] = (s.turnUsage[keys.once] ?? 0) + 1;
  if (typeof limits["limit"] === "number") s.turnUsage[keys.limit] = (s.turnUsage[keys.limit] ?? 0) + 1;
  // ... puis les autres parties du coût (choix de cartes de Vie, défausse), puis l'effet (9-4-5).
  const effect = (a.ability["effect"] ?? []) as EffectStep[];
  // 22-10-3-1 : une Capacité dont l'effet joue une carte ouvre une fenêtre de [Contre : Mise en
  // jeu] pour l'adversaire, une fois les coûts payés et avant la résolution (9-4-4).
  const playsACard = effect.some((e) => e.do === "play_self" || e.do === "play_from");
  const steps = [...a.otherCosts, ...(playsACard ? [{ do: "counter_window_play" }] : []), ...effect];
  startResolution(s, ctx, action.player, { uid: a.uid, cardId: a.cardId }, steps, { kind: "restore", pending: resume }, events, action.x);
  return null;
}
