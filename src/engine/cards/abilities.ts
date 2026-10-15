// Lecture des Capacités d'une carte, telles qu'écrites dans le fichier de cartes.
// Gère le raccourci { "same_as": "BT24-105", "ability_index": 1 } (capacité identique à
// celle d'une autre carte, éventuellement d'une face de Leader avec "face").

import type { CardDatabase, CardDefinition } from "./types";

export type RawAbility = Record<string, unknown>;

/** Capacités d'une carte (pour un Leader : celles de la face indiquée). */
export function abilitiesOf(db: CardDatabase, card: CardDefinition | undefined, side?: "front" | "back"): RawAbility[] {
  if (!card) return [];
  const own = card.type === "leader" ? (side === "back" ? card.back : card.front)?.abilities ?? [] : card.abilities;
  return own.map((a) => resolveSameAs(db, a, 0));
}

function resolveSameAs(db: CardDatabase, ability: RawAbility, depth: number): RawAbility {
  const ref = ability["same_as"];
  if (typeof ref !== "string" || depth > 5) return ability;
  const other = db.get(ref);
  const face = ability["face"] === "back" ? "back" : ability["face"] === "front" ? "front" : undefined;
  const list = other?.type === "leader" ? (face === "back" ? other.back : other.front)?.abilities : other?.abilities;
  const target = list?.[Number(ability["ability_index"] ?? 0)];
  return target ? resolveSameAs(db, target, depth + 1) : ability;
}
