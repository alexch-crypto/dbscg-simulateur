// Jouer des cartes (manuel 5-5).
// Ici : jouer une carte de Combat depuis la main en payant son coût (5-5-2).
// À venir : jouer via une Capacité sans payer le coût imprimé (5-5-3 : Successeur,
// Espace-temps, « jouez cette carte depuis votre main »...), Extras, Unissons, cartes Z.

import type { CardDefinition } from "../cards/types";
import type { Action, GameContext, GameEvent, PaymentChoice } from "../protocol";
import type { GameState, PlayerId } from "../state/types";
import {
  applyCostModifiers,
  checkPayment,
  leaderColors,
  paymentForCost,
  type CostModifier,
  type EnergyPayment,
  type EnergySource,
} from "./energy";
import { uniqueBlocks } from "./keywords";

/**
 * Modificateurs de coût actifs sur une carte (Piccolo Daimaô, Freezer BT24-105...).
 * Vide tant que les capacités ne sont pas gérées : c'est ici qu'elles se brancheront.
 */
export function costModifiersFor(_s: GameState, _player: PlayerId, _card: CardDefinition): CostModifier[] {
  return [];
}

/** Paiement exigé pour jouer normalement une carte depuis la main (coût imprimé + modificateurs). */
export function normalPlayPayment(s: GameState, player: PlayerId, card: CardDefinition): EnergyPayment | null {
  if (!card.cost) return null;
  return paymentForCost(applyCostModifiers(card.cost, costModifiersFor(s, player, card)));
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
  if (card.type !== "battle") return `5-5-2 : seules les cartes de Combat se jouent ainsi (pas encore géré : ${card.type})`;
  const uniqueError = uniqueBlocks(s, instance, ctx.cards);
  if (uniqueError) return uniqueError;

  // 5-5-2-1 : révéler la carte, passer en mode Inertie les Énergies du coût, déclarer et jouer.
  // Si le coût ne peut pas être payé, la carte ne peut pas être déclarée (5-3-3).
  const payment = normalPlayPayment(s, action.player, card)!;
  const error = payEnergy(s, action.player, payment, action.payment, ctx);
  if (error) return error;

  // 5-5-2-2 : fenêtre de contre (Capacités [Contre : Mise en jeu], pas encore gérées).
  // 5-5-2-3 : la carte de Combat est jouée dans la Zone de Combat, en mode Action
  // (les effets qui la jouent en mode Inertie le précisent, ex. BT24-068).
  p.hand.splice(index, 1);
  instance.mode = "active";
  instance.faceUp = true;
  p.battle.push(instance);
  events.push({
    type: "CARD_PLAYED",
    player: action.player,
    uid: instance.uid,
    cardId: instance.cardId,
    energyRested: [...action.payment.energy],
    markersUsed: action.payment.markers,
  });
  // Point de contrôle suivant : capacités « Quand cette carte est jouée » (pas encore gérées).
  return null;
}
