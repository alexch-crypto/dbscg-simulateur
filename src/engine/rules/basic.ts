// Actions de base (manuel, section 5), utilisées par toutes les autres règles.

import type { GameEvent } from "../protocol";
import { shuffleInPlace } from "../rng";
import type { GameState, PlayerId } from "../state/types";

/**
 * 5-1 : piocher X cartes (carte du dessus du deck vers la main, sans la révéler).
 * 0-2-4 : s'il n'y a plus assez de cartes, on pioche autant que possible.
 * 5-1-5 : piocher plusieurs cartes compte comme une seule action (un seul événement).
 */
export function drawCards(s: GameState, player: PlayerId, count: number, events: GameEvent[]): void {
  if (count <= 0) return; // 5-1-3 : X = 0, il ne se passe rien.
  const p = s.players[player];
  const drawn = p.deck.splice(0, count);
  for (const c of drawn) c.faceUp = false;
  p.hand.push(...drawn);
  if (drawn.length > 0) events.push({ type: "CARDS_DRAWN", player, count: drawn.length });
}

/** 5-11 : mélanger le deck d'un joueur. */
export function shuffleDeck(s: GameState, player: PlayerId, events: GameEvent[]): void {
  const p = s.players[player];
  for (const c of p.deck) c.faceUp = false;
  shuffleInPlace(s, p.deck);
  events.push({ type: "DECK_SHUFFLED", player });
}
