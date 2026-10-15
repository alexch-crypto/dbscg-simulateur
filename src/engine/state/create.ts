import type { CardDatabase, DeckList } from "../cards/types";
import { validateDeck } from "../cards/validate-deck";
import type { GameEvent } from "../protocol";
import { shuffleInPlace, type RngHolder } from "../rng";
import { startSetup } from "../rules/setup";
import { PLAYER_IDS, type CardInstance, type GameState, type PlayerId, type PlayerState } from "./types";

export interface NewGameInput {
  decks: Record<PlayerId, DeckList>;
  /** Graine du hasard. Même graine + mêmes actions => même partie. */
  seed: number;
}

export type CreateGameResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; errors: string[] };

/**
 * Crée l'état initial : chaque Leader est posé côté face (6-2-1-2), chaque deck est prêt
 * dans sa Zone du Deck, puis le hasard désigne qui choisira le premier joueur (6-2-1-4).
 * La suite de la mise en place se joue ensuite par des actions.
 */
export function createGame(input: NewGameInput, db: CardDatabase): CreateGameResult {
  const errors: string[] = [];
  for (const p of PLAYER_IDS) {
    for (const e of validateDeck(input.decks[p], db)) errors.push(`${p} : ${e}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const holder: RngHolder = { rng: input.seed | 0 };
  const makePlayer = (id: PlayerId): PlayerState => {
    const deck = input.decks[id];
    const cardIds = Object.entries(deck.main).flatMap(([cardId, n]) => Array<string>(n).fill(cardId));
    // Les identifiants uniques sont distribués dans un ordre aléatoire : ainsi un
    // identifiant ne permet pas de deviner de quelle carte il s'agit.
    shuffleInPlace(holder, cardIds);
    const cards: CardInstance[] = cardIds.map((cardId, i) => ({
      uid: `${id}-${i + 1}`,
      cardId,
      owner: id,
      mode: "active",
      faceUp: false,
    }));
    return {
      id,
      leader: { uid: `${id}-L`, cardId: deck.leader, side: "front", mode: "active" },
      energyMarkers: 0,
      deck: cards,
      hand: [],
      life: [],
      energy: [],
      battle: [],
      combo: [],
      drop: [],
      zEnergy: [],
      warp: [],
      removed: [],
    };
  };

  const players = { P1: makePlayer("P1"), P2: makePlayer("P2") };
  const state: GameState = {
    rng: holder.rng,
    players,
    firstPlayer: null,
    turnPlayer: "P1",
    turnNumber: 0,
    phase: "setup",
    pending: null,
    battle: null,
    resolving: null,
    turnUsage: {},
    result: null,
  };
  const events: GameEvent[] = [];
  startSetup(state, events);
  return { ok: true, state, events };
}
