// Jouer des cartes (manuel 5-5).
// Ici : jouer une carte de Combat depuis la main en payant son coût (5-5-2).
// À venir : jouer via une Capacité sans payer le coût imprimé (5-5-3 : Successeur,
// Espace-temps, « jouez cette carte depuis votre main »...), Extras, Unissons, cartes Z.

import type { CardDefinition } from "../cards/types";
import { leaveUnison } from "./zones";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import type { CardInstance, GameState, PlayerId } from "../state/types";
import {
  applyCostModifiers,
  checkPayment,
  leaderColors,
  paymentForCost,
  paymentSize,
  type CostModifier,
  type EnergyPayment,
  type EnergySource,
} from "./energy";
import { checkpoint, queueTriggers } from "./autos";
import { openCounterWindow } from "./counters";
import { uniqueBlocks } from "./keywords";
import { handCostChange } from "./permanents";

/**
 * Modificateurs de coût actifs sur une carte de la main : ses propres [Permanent] (ex. Piccolo
 * Daimaô : -1 par carte verte autre que « Saiyan » parmi vos Énergies Z et votre Dispersion).
 * 1-2-3 : ils ne touchent que le coût total, les orbes de couleur restent dus.
 */
export function costModifiersFor(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext): CostModifier[] {
  const change = handCostChange(s, player, card, ctx);
  return change === 0 ? [] : [{ kind: "total", amount: change }];
}

/**
 * Paiement exigé pour jouer normalement une carte depuis la main (coût imprimé + modificateurs).
 * `x` : coût X choisi pour une Unisson (1-2-2-2).
 */
export function normalPlayPayment(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext, x = 0): EnergyPayment | null {
  const def = ctx.cards.get(card.cardId);
  if (!def?.cost) return null;
  return paymentForCost(applyCostModifiers(def.cost, costModifiersFor(s, player, card, ctx), x), x);
}

/** Valeurs de X possibles pour jouer une Unisson : au moins son coût de couleur (1-2-2-1), au plus les sources d'énergie. */
export function unisonXValues(def: CardDefinition, sources: number): number[] {
  const colorSum = Object.values(def.cost?.specified ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const values: number[] = [];
  for (let x = Math.max(colorSum, 1); x <= sources; x++) values.push(x);
  return values;
}

/**
 * Transforme le choix du joueur (uids d'Énergies + nombre de marqueurs) en sources d'énergie,
 * en vérifiant qu'elles existent et sont utilisables (5-3-3).
 */
function sourcesFromChoice(
  s: GameState,
  player: PlayerId,
  choice: PaymentChoice,
  ctx: GameContext,
): EnergySource[] | string {
  const p = s.players[player];
  if (new Set(choice.energy).size !== choice.energy.length) return "5-3-1 : une même Énergie est choisie deux fois";
  const sources: EnergySource[] = [];
  for (const uid of choice.energy) {
    const card = p.energy.find((c) => c.uid === uid);
    if (!card) return `5-3-1 : ${uid} n'est pas dans votre Zone d'Énergie`;
    if (card.mode !== "active") return `5-3-3 : ${uid} est déjà en mode Inertie`;
    sources.push({ id: uid, colors: ctx.cards.get(card.cardId)?.colors ?? [] });
  }
  if (!Number.isInteger(choice.markers) || choice.markers < 0 || choice.markers > p.energyMarkers) {
    return `1-14 : vous avez ${p.energyMarkers} marqueur(s) Énergie (${choice.markers} demandé(s))`;
  }
  const markerColors = leaderColors(s, player, ctx.cards);
  for (let i = 0; i < choice.markers; i++) sources.push({ id: "marker", colors: markerColors });
  return sources;
}

/** Vérifie un paiement choisi puis l'effectue. Renvoie un message d'erreur, ou null. */
export function payEnergy(
  s: GameState,
  player: PlayerId,
  payment: EnergyPayment,
  choice: PaymentChoice,
  ctx: GameContext,
): string | null {
  const sources = sourcesFromChoice(s, player, choice, ctx);
  if (typeof sources === "string") return sources;
  const error = checkPayment(sources, payment);
  if (error) return error;
  const p = s.players[player];
  for (const uid of choice.energy) p.energy.find((c) => c.uid === uid)!.mode = "rest";
  // 1-14-2 : un marqueur Énergie utilisé est retiré du jeu.
  p.energyMarkers -= choice.markers;
  return null;
}

/**
 * 5-5-3 : jouer une carte de Combat via une Capacité (sans payer son coût d'Énergie), depuis
 * la main ou la Dispersion. Déclenche « Quand cette carte est jouée » (9-6-9-4) ; le point de
 * contrôle a lieu à la fin de la résolution en cours. Renvoie un message si c'est impossible.
 */
export function enterBattleArea(
  s: GameState,
  ctx: GameContext,
  player: PlayerId,
  card: CardInstance,
  from: "hand" | "drop" | "deck",
  mode: "active" | "rest",
  events: GameEvent[],
  via?: string,
  /** Joueur dans la Zone de Combat duquel la carte est jouée (par défaut, `player`). */
  into: PlayerId = player,
): string | null {
  const def = ctx.cards.get(card.cardId);
  if (def?.type !== "battle") return "seules les cartes de Combat peuvent être jouées ainsi pour l'instant";
  const uniqueError = uniqueBlocks(s, card, ctx.cards);
  if (uniqueError) return uniqueError;
  const zone = s.players[player][from];
  zone.splice(zone.indexOf(card), 1);
  card.mode = mode;
  card.faceUp = true;
  s.players[into].battle.push(card);
  s.playedFrom[card.uid] = from;
  events.push({ type: "CARD_PLAYED_BY_SKILL", player, uid: card.uid, cardId: card.cardId, from, mode, ...(into !== player ? { into } : {}) });
  // 22-15-6 : jouée via [Espace-temps] => en Dimension parallèle à la fin du tour.
  if (via === "over_realm") s.effects.push({ uid: card.uid, kind: "warp_at_end_of_turn", untilTurn: s.turnNumber });
  queueTriggers(s, { event: "played", card, ...(via ? { via } : {}) }, ctx, events);
  return null;
}

/** 5-5-2 : jouer une carte de Combat depuis sa main en payant son coût d'Énergie. */
export function playBattleCard(
  s: GameState,
  action: Extract<Action, { type: "PLAY_CARD" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const p = s.players[action.player];
  const index = p.hand.findIndex((c) => c.uid === action.uid);
  if (index < 0) return "5-5-2 : la carte doit venir de votre main";
  const instance = p.hand[index]!;
  const card = ctx.cards.get(instance.cardId);
  if (!card) return `carte inconnue ${instance.cardId}`;
  if (card.type !== "battle" && card.type !== "unison") return `5-5-2 : seules les cartes de Combat et les Unissons se jouent ainsi (pas : ${card.type})`;
  const uniqueError = uniqueBlocks(s, instance, ctx.cards);
  if (uniqueError) return uniqueError;
  // 13-2 : une Unisson se joue pour X Énergies (X choisi, au moins son coût de couleur).
  const isUnison = card.type === "unison";
  const minX = Math.max(1, Object.values(card.cost?.specified ?? {}).reduce((x, y) => x + (y ?? 0), 0));
  if (isUnison && (action.x === undefined || !Number.isInteger(action.x) || action.x < minX)) {
    return "1-2-2-2 : choisissez la valeur de X (au moins le coût de couleur de l'Unisson)";
  }

  // 5-5-2-1 : révéler la carte, passer en mode Inertie les Énergies du coût, déclarer et jouer.
  // Si le coût ne peut pas être payé, la carte ne peut pas être déclarée (5-3-3).
  const payment = normalPlayPayment(s, action.player, instance, ctx, isUnison ? action.x : 0)!;
  const error = payEnergy(s, action.player, payment, action.payment, ctx);
  if (error) return error;

  // 5-5-2-1 : la carte est révélée et sa mise en jeu déclarée.
  instance.faceUp = true;
  events.push({
    type: "PLAY_DECLARED",
    player: action.player,
    uid: instance.uid,
    cardId: instance.cardId,
    energyRested: [...action.payment.energy],
    markersUsed: action.payment.markers,
  });
  // 5-5-2-2 : fenêtre de contre ([Contre : Mise en jeu]), puis 5-5-2-3 (finishPlay).
  s.pending = null;
  openCounterWindow(
    s,
    ctx,
    { on: "play", player: action.player, cardUid: instance.uid, cardId: instance.cardId },
    // 13-2 : l'Unisson arrive avec autant de marqueurs que d'Énergies passées en mode Inertie.
    { kind: "finish_play", player: action.player, uid: instance.uid, ...(isUnison ? { markers: paymentSize(payment) } : {}) },
    events,
  );
  return null;
}

/**
 * 5-5-2-3 : la carte de Combat est jouée dans la Zone de Combat, en mode Action (les effets qui
 * la jouent en mode Inertie le précisent). Puis « Quand cette carte est jouée » et point de contrôle.
 */
export function finishPlay(s: GameState, ctx: GameContext, player: PlayerId, uid: string, events: GameEvent[], markers?: number): void {
  const p = s.players[player];
  const index = p.hand.findIndex((c) => c.uid === uid);
  if (index >= 0 && markers !== undefined) {
    // Unisson : une seule à la fois (3-11-4) ; l'ancienne quitte la Zone Unisson (Dispersion).
    const instance = p.hand.splice(index, 1)[0]!;
    for (const other of [...p.unison]) leaveUnison(s, ctx, player, other, events);
    instance.mode = "active";
    instance.faceUp = true;
    instance.markers = markers;
    p.unison.push(instance);
    s.playedFrom[instance.uid] = "hand";
    events.push({ type: "UNISON_PLAYED", player, uid: instance.uid, cardId: instance.cardId, markers });
    queueTriggers(s, { event: "played", card: instance }, ctx, events);
  } else if (index >= 0) {
    const instance = p.hand.splice(index, 1)[0]!;
    instance.mode = "active";
    instance.faceUp = true;
    p.battle.push(instance);
    s.playedFrom[instance.uid] = "hand";
    events.push({ type: "CARD_PLAYED", player, uid: instance.uid, cardId: instance.cardId });
    // 9-6-9-4 : « Quand cette carte est jouée » se met en suspens.
    queueTriggers(s, { event: "played", card: instance }, ctx, events);
  }
  checkpoint(s, ctx, { kind: "restore", pending: { type: "MAIN", player } }, events);
}
