// Règles de construction de deck (manuel, section 6-1), avec les mots-clés qui les modifient
// (6-1-5-2) : [Ultimate] (22-14-2) et [Super Combo] (22-17-2).
// Non encore géré : [Dragon Ball] (22-28, jusqu'à 7 exemplaires).

import { OFFICIAL_RULES, type GameRules } from "../state/types";
import type { CardDatabase, CardType, DeckList } from "./types";

export const MAIN_DECK_MIN = 50; // 6-1-3
export const MAIN_DECK_MAX = 60; // 6-1-3
export const Z_DECK_MAX = 10; // 6-1-4
export const MAX_COPIES = 4; // 6-1-5-1
export const MAX_ULTIMATE = 1; // 22-14-2
export const MAX_SUPER_COMBO = 4; // 22-17-2

/** 6-1-3 : le deck contient des cartes de Combat, des Extras et des Unissons. */
const MAIN_DECK_TYPES: readonly CardType[] = ["battle", "extra", "unison"];
/** 6-1-4 : le deck Z ne contient que des cartes Z. */
const Z_DECK_TYPES: readonly CardType[] = ["z_leader", "z_battle", "z_extra", "z_unison"];

/** `rules` : règles de la partie (taille du deck, exemplaires, cartes bannies ou limitées). */
export function validateDeck(deck: DeckList, db: CardDatabase, rules: GameRules = OFFICIAL_RULES): string[] {
  const errors: string[] = [];

  const leader = db.get(deck.leader);
  if (!leader) errors.push(`6-1-2 : Leader ${deck.leader} introuvable dans la base de cartes`);
  else if (leader.type !== "leader") errors.push(`6-1-2 : ${deck.leader} n'est pas un Leader`);
  else if (leader.banned && !rules.allowBanned) errors.push(`${leader.name} (${deck.leader}) est bannie`);

  const checkPart = (
    counts: Record<string, number>,
    allowed: readonly CardType[],
    rule: string,
    label: string,
  ): number => {
    let total = 0;
    for (const [id, n] of Object.entries(counts)) {
      total += n;
      const card = db.get(id);
      if (!card) {
        errors.push(`${label} : carte ${id} introuvable dans la base de cartes`);
        continue;
      }
      if (!allowed.includes(card.type)) {
        errors.push(`${rule} : ${id} (${card.type}) ne peut pas être dans le ${label}`);
      }
      if (n > rules.maxCopies) {
        errors.push(`6-1-5-1 : ${id} en ${n} exemplaires (maximum ${rules.maxCopies})`);
      }
      if (card.banned && !rules.allowBanned) errors.push(`${card.name} (${id}) est bannie`);
      if (card.limit !== undefined && !rules.ignoreLimited && n > card.limit) {
        errors.push(`${card.name} (${id}) est limitée à ${card.limit} exemplaire(s)`);
      }
    }
    return total;
  };

  const mainCount = checkPart(deck.main, MAIN_DECK_TYPES, "6-1-3", "deck");
  if (mainCount < rules.deckMin || mainCount > rules.deckMax) {
    errors.push(`6-1-3 : le deck contient ${mainCount} cartes (il en faut entre ${rules.deckMin} et ${rules.deckMax})`);
  }

  // Limites liées aux mots-clés, comptées sur tout le deck (deck principal et deck Z).
  const countWithKeyword = (keyword: string): number =>
    [...Object.entries(deck.main), ...Object.entries(deck.zDeck)].reduce(
      (total, [id, n]) => total + (db.get(id)?.keywords.some((k) => k.id === keyword) ? n : 0),
      0,
    );
  // Partie personnalisée « limites ignorées » : ces limites-là sont ignorées aussi.
  const ultimates = countWithKeyword("ultimate");
  if (ultimates > MAX_ULTIMATE && !rules.ignoreLimited) {
    errors.push(`22-14-2 : ${ultimates} cartes [Ultimate] dans le deck (maximum ${MAX_ULTIMATE})`);
  }
  const superCombos = countWithKeyword("super_combo");
  if (superCombos > MAX_SUPER_COMBO && !rules.ignoreLimited) {
    errors.push(`22-17-2 : ${superCombos} cartes [Super Combo] dans le deck (maximum ${MAX_SUPER_COMBO})`);
  }

  const zCount = checkPart(deck.zDeck, Z_DECK_TYPES, "6-1-4", "deck Z");
  if (zCount > rules.zDeckMax) {
    errors.push(`6-1-4 : le deck Z contient ${zCount} cartes (maximum ${rules.zDeckMax})`);
  }

  return errors;
}
