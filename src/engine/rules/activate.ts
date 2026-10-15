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
import { checkConditions, matchesFilter } from "./conditions";
import { startResolution } from "./effects";
import { availableEnergySources, findPayment, type EnergyPayment } from "./energy";
import { isNegated } from "./keywords";
import { payEnergy } from "./play";

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
}

/** Timings d'[Activation] autorisés dans la décision en cours (1-5-4-1). */
function allowedTimings(s: GameState, player: PlayerId): string[] {
  const p = s.pending;
  if (!p || p.player !== player) return [];
  if (p.type === "MAIN") return ["main", "main_battle"];
  if (p.type === "OFFENSE" || p.type === "DEFENSE") return ["battle", "main_battle"];
  return [];
}

/** Zone depuis laquelle une Capacité s'active. */
function activationZone(ability: RawAbility): "board" | "hand" | "drop" | "combo" {
  const from = ability["activates_from"];
  if (from === "drop" || from === "combo" || from === "hand") return from;
  const effect = (ability["effect"] ?? []) as Json[];
  if (effect.some((e) => e["do"] === "play_self" && e["from"] === "hand")) return "hand";
  return "board";
}

/** Analyse le coût de Capacité. Renvoie null si une partie n'est pas encore gérée. */
function parseCost(cost: unknown): { energy: EnergyPayment | null; others: EffectStep[] } | null {
  if (cost === undefined) return { energy: null, others: [] };
  if (!Array.isArray(cost)) return null;
  let energy: EnergyPayment | null = null;
  const others: EffectStep[] = [];
  for (const c of cost as Json[]) {
    if (c["do"] === "pay_energy") {
      energy = { colors: (c["specified"] ?? {}) as EnergyPayment["colors"], generic: (c["generic"] as number) ?? 0 };
    } else if (c["do"] === "life_to_hand" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else if (c["do"] === "discard" && typeof c["count"] === "number") {
      others.push(c as EffectStep);
    } else {
      return null;
    }
  }
  return { energy, others };
}

/** Les autres coûts (Vie, défausse) peuvent-ils être payés ? */
function otherCostsPayable(s: GameState, player: PlayerId, others: EffectStep[], self: string, ctx: GameContext): boolean {
  const p = s.players[player];
  for (const c of others) {
    const n = c["count"] as number;
    if (c.do === "life_to_hand" && p.life.length < n) return false;
    if (c.do === "discard") {
      const ok = p.hand.filter((card) => card.uid !== self && matchesFilter(card, c["filter"], ctx.cards) === true);
      if (ok.length < n) return false;
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
    sources.push({ card: p.leader, abilities: abilitiesOf(ctx.cards, ctx.cards.get(p.leader.cardId), p.leader.side), zone: "board" });
  }
  const add = (cards: CardInstance[], zone: "board" | "hand" | "drop" | "combo") => {
    for (const c of cards) {
      if (zone === "board" && isNegated(s, c.uid)) continue;
      sources.push({ card: c, abilities: abilitiesOf(ctx.cards, ctx.cards.get(c.cardId)), zone });
    }
  };
  add(p.battle, "board");
  add(p.hand, "hand");
  add(p.drop, "drop");
  add(p.combo, "combo");

  const sourcesOfEnergy = availableEnergySources(s, player, ctx.cards);
  const result: Activatable[] = [];
  for (const { card, abilities, zone } of sources) {
    abilities.forEach((ability, index) => {
      if (ability["kind"] !== "activate") return;
      if (!timings.includes(ability["timing"] as string)) return;
      if (activationZone(ability) !== zone) return;
      // Limites : [Une fois par tour] (22-11), [Limite X] (22-44).
      const limits = (ability["limits"] ?? {}) as Json;
      const keys = usageKeys(player, card.uid, card.cardId, index);
      if (limits["once_per_turn"] && (s.turnUsage[keys.once] ?? 0) >= 1) return;
      if (typeof limits["limit"] === "number" && (s.turnUsage[keys.limit] ?? 0) >= limits["limit"]) return;
      // Conditions (non gérées => non proposée).
      if (checkConditions(s, player, ability["condition"], ctx.cards) !== true) return;
      // Coût : géré et payable (9-2-3).
      const cost = parseCost(ability["cost"]);
      if (!cost) return;
      if (cost.energy && !findPayment(sourcesOfEnergy, cost.energy)) return;
      if (!otherCostsPayable(s, player, cost.others, card.uid, ctx)) return;
      result.push({ uid: card.uid, cardId: card.cardId, index, ability, energy: cost.energy, otherCosts: cost.others });
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
  // 9-4-2-1 : payer entièrement le coût. D'abord l'énergie (choix du joueur)...
  if (a.energy) {
    const error = payEnergy(s, action.player, a.energy, action.payment, ctx);
    if (error) return error;
  } else if (action.payment.energy.length > 0 || action.payment.markers > 0) {
    return "cette Capacité n'a pas de coût d'énergie";
  }
  // 9-4-2 : la carte est révélée si elle est en main.
  events.push({
    type: "ABILITY_ACTIVATED",
    player: action.player,
    uid: a.uid,
    cardId: a.cardId,
    index: a.index,
    text: String(a.ability["text"] ?? ""),
  });
  const limits = (a.ability["limits"] ?? {}) as Json;
  const keys = usageKeys(action.player, a.uid, a.cardId, a.index);
  if (limits["once_per_turn"]) s.turnUsage[keys.once] = (s.turnUsage[keys.once] ?? 0) + 1;
  if (typeof limits["limit"] === "number") s.turnUsage[keys.limit] = (s.turnUsage[keys.limit] ?? 0) + 1;
  // ... puis les autres parties du coût (choix de cartes de Vie, défausse), puis l'effet (9-4-5).
  const steps = [...a.otherCosts, ...((a.ability["effect"] ?? []) as EffectStep[])];
  startResolution(s, ctx, action.player, { uid: a.uid, cardId: a.cardId }, steps, { kind: "restore", pending: resume }, events);
  return null;
}
