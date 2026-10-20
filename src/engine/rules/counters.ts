// Fenêtres de contre et Capacités [Contre] (manuel 4-3, 9-7, 22-10), activation des Extras (12-2).
//
// Déroulement (9-7-3) :
//   1. Un événement (mise en jeu, attaque) ouvre une fenêtre de contre pour l'autre joueur.
//   2. Il passe, ou déclare un [Contre] de sa main (coût payé tout de suite ; une Extra va
//      dans la Dispersion, 12-2-2-2). Cette motion de Contre est ajoutée à la chaîne.
//   3. L'adversaire reçoit alors une fenêtre pour un [Contre : Contre] (22-10-3-4), etc.
//   4. Quand un joueur passe, la chaîne se résout de la dernière motion à la première (9-7-3-5),
//      sans point de contrôle au milieu (9-7-3-5-2), puis l'action d'origine continue (9-7-4).
//
// Réglage du joueur (`settings.counterPrompt`) : avec « only_if_playable », la fenêtre se ferme
// toute seule s'il n'a aucun contre jouable ; avec « always » (par défaut), on lui demande
// toujours, pour ne rien révéler à l'adversaire.
//
// Non géré pour l'instant : fenêtres de contre après l'activation / la résolution de n'importe
// quelle Capacité (4-3-2-3 / 4-3-2-4) — seules celles qui jouent une carte en ouvrent une.

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import {
  opponentOf,
  type CardInstance,
  type Continuation,
  type CounterEvent,
  type CounterOn,
  type EffectStep,
  type GameState,
  type PlayerId,
} from "../state/types";
import { otherCostsPayable, parseCost } from "./activate";
import { continueWith, queueTriggers } from "./autos";
import { abilityConditions, checkConditions } from "./conditions";
import { startResolution } from "./effects";
import { availableEnergySources, findPayment, paymentForCost, type EnergyPayment } from "./energy";
import { cardHasKeyword } from "./keywords";
import { normalPlayPayment, payEnergy } from "./play";

type Json = Record<string, unknown>;

/** Une façon de déclarer un [Contre] depuis sa main. */
export interface CounterOption {
  uid: string;
  cardId: string;
  ability: RawAbility;
  /** true : coût alternatif (ex. « en rajoutant une carte de vos points de vie au lieu de payer son coût d'énergie »). */
  alt: boolean;
  energy: EnergyPayment | null;
  otherCosts: EffectStep[];
}

/** Type de [Contre] attendu par la fenêtre en cours, pour le joueur qui répond. */
function windowOn(s: GameState): CounterOn | null {
  return s.pending?.type === "COUNTER_WINDOW" ? s.pending.on : null;
}

/** Ce [Contre] répond-il à cet événement ? (22-10-3) */
function matches(ability: RawAbility, on: CounterOn, event: CounterEvent, ctx: GameContext): boolean {
  const kind = ability["counter_on"];
  if (on === "counter") return kind === "counter";
  if (on === "attack" && event.on === "attack") {
    return kind === "attack" || (kind === "battle_card_attack" && event.byBattleCard);
  }
  if (on === "play" && event.on === "play") {
    // 22-20 [Déflexion] : la carte jouée n'est pas affectée par les [Contre : Mise en jeu] adverses.
    if (cardHasKeyword(ctx.cards.get(event.cardId), "deflect")) return false;
    return kind === "play";
  }
  return false;
}

/** Les [Contre] que `player` peut déclarer maintenant (22-10-4 / 22-10-5 : depuis la main). */
export function counterOptions(s: GameState, player: PlayerId, on: CounterOn, ctx: GameContext): CounterOption[] {
  const window = s.counterWindow;
  if (!window) return [];
  const sources = availableEnergySources(s, player, ctx.cards);
  const result: CounterOption[] = [];
  // « Vous ne pouvez pas activer les Capacités [Contre : Mise en jeu] des autres cartes ce tour. »
  const onlyPlayCounterOf = s.restrictions
    .filter((r) => r.player === player && r.rule === "no_other_counter_play" && r.fromTurn <= s.turnNumber && s.turnNumber <= r.untilTurn)
    .map((r) => r.uid);
  for (const card of s.players[player].hand) {
    const def = ctx.cards.get(card.cardId);
    const abilities = abilitiesOf(ctx.cards, def);
    for (const ability of abilities) {
      if (ability["kind"] !== "counter" || !matches(ability, on, window.event, ctx)) continue;
      // 22-44 [Limite X] : partagée entre tous les exemplaires du même numéro de carte.
      const limit = ((ability["limits"] ?? {}) as Json)["limit"];
      if (typeof limit === "number" && (s.turnUsage[counterLimitKey(player, card.cardId)] ?? 0) >= limit) continue;
      if (ability["counter_on"] === "play" && onlyPlayCounterOf.some((uid) => uid !== card.uid)) continue;
      if (checkConditions(s, player, abilityConditions(ability), ctx.cards) !== true) continue;
      const cost = parseCost(ability["cost"]);
      if (!cost) continue;
      // Coût d'énergie : celui de l'Extra (12-2-2-2), ou celui de la carte de Combat si le
      // [Contre] la joue en payant son coût (« pays_energy_cost_of_card »).
      const payCard = def?.type === "extra" || ability["pays_energy_cost_of_card"] === true;
      // Une carte de Combat jouée par son [Contre] paie son coût actuel en main (réductions comprises).
      const cardCost = payCard && def?.cost ? (def.type === "extra" ? paymentForCost(def.cost) : normalPlayPayment(s, player, card, ctx)) : null;
      const energy = cost.energy ?? cardCost;
      const base = { uid: card.uid, cardId: card.cardId, ability };
      if ((!energy || findPayment(sources, energy)) && otherCostsPayable(s, player, cost.others, card.uid, ctx)) {
        result.push({ ...base, alt: false, energy, otherCosts: cost.others });
      }
      // Coûts alternatifs donnés par les [Permanent] de la carte elle-même.
      for (const permanent of abilities) {
        if (permanent["kind"] !== "permanent") continue;
        if (checkConditions(s, player, abilityConditions(permanent), ctx.cards) !== true) continue;
        for (const e of (permanent["effect"] ?? []) as Json[]) {
          const alt =
            e["do"] === "counter_without_energy_cost"
              ? []
              : e["do"] === "counter_alt_cost"
                ? ((e["replace_energy_cost_with"] ?? []) as EffectStep[])
                : null;
          if (alt === null) continue;
          const others = [...cost.others, ...alt];
          if (otherCostsPayable(s, player, others, card.uid, ctx)) {
            result.push({ ...base, alt: true, energy: cost.energy, otherCosts: others });
          }
        }
      }
    }
  }
  return result;
}

const counterLimitKey = (player: PlayerId, cardId: string) => `limit:${player}:${cardId}#counter`;

/** Paiement suggéré pour un [Contre]. */
export function suggestCounterPayment(s: GameState, player: PlayerId, option: CounterOption, ctx: GameContext): PaymentChoice {
  if (!option.energy) return { energy: [], markers: 0 };
  const chosen = findPayment(availableEnergySources(s, player, ctx.cards), option.energy) ?? [];
  return {
    energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
    markers: chosen.filter((src) => src.id === "marker").length,
  };
}

// ---------------------------------------------------------------------------
// Ouverture, passe, déclaration
// ---------------------------------------------------------------------------

/**
 * 9-7-3-1 : un événement ouvre une fenêtre de contre pour `responder`. `then` : ce qui reprend
 * une fois la fenêtre (et sa chaîne) terminée.
 */
export function openCounterWindow(
  s: GameState,
  ctx: GameContext,
  event: CounterEvent,
  then: Continuation,
  events: GameEvent[],
): void {
  // 4-3-2-7 : pas de nouvelle fenêtre pendant une fenêtre déjà en cours.
  if (s.counterWindow) {
    continueWith(s, ctx, then, events);
    return;
  }
  s.counterWindow = { event, chain: [], resolving: null, payingCosts: false, then };
  events.push({ type: "COUNTER_WINDOW_OPENED", on: event.on, player: opponentOf(event.player) });
  askWindow(s, ctx, opponentOf(event.player), event.on, events);
}

/** Donne la main au joueur pour la fenêtre, ou la ferme d'office selon son réglage. */
function askWindow(s: GameState, ctx: GameContext, player: PlayerId, on: CounterOn, events: GameEvent[]): void {
  s.pending = { type: "COUNTER_WINDOW", player, on };
  if (s.settings.counterPrompt[player] === "only_if_playable" && counterOptions(s, player, on, ctx).length === 0) {
    s.pending = null;
    windowPassed(s, ctx, events);
  }
}

/** 9-7-3-2 : le joueur ne déclare rien. */
export function passCounter(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  s.pending = null;
  windowPassed(s, ctx, events);
}

function windowPassed(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const window = s.counterWindow!;
  if (window.chain.length === 0) closeWindow(s, ctx, events);
  else resolveNextLink(s, ctx, events);
}

/** 9-7-3-2 / 9-7-3-4 : déclarer un [Contre] depuis sa main. */
export function declareCounter(
  s: GameState,
  action: Extract<Action, { type: "DECLARE_COUNTER" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const on = windowOn(s)!;
  const option = counterOptions(s, action.player, on, ctx).find((o) => o.uid === action.uid && o.alt === action.alt);
  if (!option) return "22-10 : ce [Contre] ne peut pas être déclaré maintenant (type, condition ou coût)";
  // Coût d'énergie (choix du joueur).
  if (option.energy) {
    const error = payEnergy(s, action.player, option.energy, action.payment, ctx);
    if (error) return error;
  } else if (action.payment.energy.length > 0 || action.payment.markers > 0) {
    return "ce [Contre] ne demande pas d'énergie";
  }
  const p = s.players[action.player];
  const card = p.hand.find((c) => c.uid === option.uid)!;
  events.push({
    type: "COUNTER_DECLARED",
    player: action.player,
    uid: card.uid,
    cardId: card.cardId,
    text: String(option.ability["text"] ?? ""),
  });
  // 12-2-2-2 : une Extra est placée dans la Dispersion dès son activation.
  if (ctx.cards.get(card.cardId)?.type === "extra") {
    p.hand.splice(p.hand.indexOf(card), 1);
    card.faceUp = true;
    card.mode = "active";
    s.players[card.owner].drop.push(card);
  } else {
    // 9-4-2 : la carte est révélée (elle reste en main jusqu'à la résolution).
    card.faceUp = true;
  }
  const window = s.counterWindow!;
  if (typeof ((option.ability["limits"] ?? {}) as Json)["limit"] === "number") {
    const key = counterLimitKey(action.player, card.cardId);
    s.turnUsage[key] = (s.turnUsage[key] ?? 0) + 1;
  }
  // « Quand votre adversaire active une Capacité Contre » (résolue au prochain point de contrôle).
  queueTriggers(s, { event: "counter_activated", player: action.player }, ctx, events);
  // Les autres parties du coût (Vie, défausse...) sont payées tout de suite, comme une petite
  // résolution qui revient ensuite à la fenêtre de l'adversaire.
  const link = { player: action.player, uid: card.uid, cardId: card.cardId, ability: option.ability };
  window.chain.push(link);
  s.pending = null;
  if (option.otherCosts.length > 0) {
    // On paie les coûts, puis on ouvre la fenêtre [Contre : Contre] de l'adversaire.
    window.resolving = link;
    window.payingCosts = true;
    startResolution(s, ctx, action.player, { uid: card.uid, cardId: card.cardId }, option.otherCosts, { kind: "counter_chain" }, events);
    return null;
  }
  askWindow(s, ctx, opponentOf(action.player), "counter", events);
  return null;
}

/** 9-7-3-5 : résoudre la dernière motion de Contre non résolue. */
function resolveNextLink(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const window = s.counterWindow!;
  const link = window.chain.pop()!;
  window.resolving = link;
  const steps = (link.ability["effect"] ?? []) as EffectStep[];
  events.push({ type: "COUNTER_RESOLVING", player: link.player, cardId: link.cardId });
  startResolution(s, ctx, link.player, { uid: link.uid, cardId: link.cardId }, steps, { kind: "counter_chain" }, events);
}

/** Un maillon (ou le paiement des coûts d'un maillon) vient d'être résolu. */
export function afterCounterLink(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const window = s.counterWindow!;
  const link = window.resolving!;
  window.resolving = null;
  if (window.payingCosts) {
    window.payingCosts = false;
    // Les coûts du contre déclaré sont payés : fenêtre [Contre : Contre] pour l'adversaire.
    askWindow(s, ctx, opponentOf(link.player), "counter", events);
    return;
  }
  // 22-10-7 : la carte dont le [Contre] a été activé va dans la Dispersion, si elle est restée en main.
  const p = s.players[link.player];
  const card = p.hand.find((c) => c.uid === link.uid);
  if (card) moveHandToDrop(s, link.player, card);
  if (window.chain.length > 0) resolveNextLink(s, ctx, events);
  else closeWindow(s, ctx, events);
}

function moveHandToDrop(s: GameState, player: PlayerId, card: CardInstance): void {
  const hand = s.players[player].hand;
  hand.splice(hand.indexOf(card), 1);
  card.faceUp = true;
  card.mode = "active";
  s.players[card.owner].drop.push(card);
}

/**
 * 9-7-4 : la fenêtre se termine et l'action d'origine reprend tout de suite. Les [Auto.]
 * déclenchées pendant la chaîne attendent le point de contrôle suivant (9-7-3-5-2).
 */
function closeWindow(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const then = s.counterWindow!.then;
  s.counterWindow = null;
  events.push({ type: "COUNTER_WINDOW_CLOSED" });
  continueWith(s, ctx, then, events);
}
