// Mots-clés / Capacités-clefs simples (manuel, section 22).
// Les identifiants sont ceux du fichier de cartes (docs/LISEZMOI-cartes.md).
//
// Plus tard, les effets qui donnent ou annulent des mots-clés (« acquiert [Réplique] »,
// « annulez ses Capacités ») se brancheront dans `keywordsOf`.

import type { CardDatabase, CardDefinition, Keyword } from "../cards/types";
import type { CardInstance, CardRef, GameState } from "../state/types";

export const KW = {
  blocker: "blocker", // 22-4
  critical: "critical", // 22-6
  doubleStrike: "double_strike", // 22-7
  tripleStrike: "triple_strike", // 22-7
  quadrupleStrike: "quadruple_strike", // 22-7
  dualAttack: "dual_attack", // 22-8 [Réplique]
  triAttack: "tri_attack", // 22-8 [Tri-offensive]
  ultimate: "ultimate", // 22-14
  superCombo: "super_combo", // 22-17
  energyExhaust: "energy_exhaust", // 22-31 [Fuite d'énergie]
  unique: "unique", // 22-39
} as const;

export const cardHasKeyword = (card: CardDefinition | undefined, id: string): boolean =>
  card?.keywords.some((k) => k.id === id) ?? false;

/** La carte ne peut pas passer en mode Action via un effet (« jusqu'à la fin du tour adverse »...). */
export const readyBlockedByEffect = (s: GameState, uid: string): boolean =>
  s.effects.some((e) => e.uid === uid && e.kind === "lock_active" && !e.chargeOnly);

/** 9-1 : les Capacités de cette carte sont-elles annulées par un effet en cours ? */
export const isNegated = (s: GameState, uid: string): boolean =>
  s.effects.some((e) => e.uid === uid && e.kind === "negate_all");

/**
 * Mots-clés actuels d'un Leader (selon sa face visible) ou d'une carte de Combat en jeu,
 * avec les effets en cours : mots-clés acquis, annulés, ou toutes les Capacités annulées.
 */
export function keywordsOf(s: GameState, ref: CardRef, db: CardDatabase): Keyword[] {
  const p = s.players[ref.player];
  let printed: Keyword[];
  if (p.leader.uid === ref.uid) {
    const def = db.get(p.leader.cardId);
    printed = (p.leader.side === "front" ? def?.front?.keywords : def?.back?.keywords) ?? [];
  } else {
    const card = p.battle.find((c) => c.uid === ref.uid);
    if (!card) return [];
    printed = db.get(card.cardId)?.keywords ?? [];
  }
  // 9-1-5 : une carte dont les Capacités sont annulées ne peut pas en acquérir de nouvelles.
  if (isNegated(s, ref.uid)) return [];
  const mine = s.effects.filter((e) => e.uid === ref.uid);
  const negated = new Set(mine.flatMap((e) => (e.kind === "negate_keyword" ? [e.keyword] : [])));
  const granted = mine.flatMap((e) => (e.kind === "grant_keyword" ? [{ id: e.keyword }] : []));
  return [...printed, ...granted].filter((k) => !negated.has(k.id));
}

export const hasKeyword = (s: GameState, ref: CardRef, id: string, db: CardDatabase): boolean =>
  keywordsOf(s, ref, db).some((k) => k.id === id);

/** 22-7 : nombre de dégâts infligés en attaquant ([Double/Triple/Quadruple Frappe], sinon 1). */
export function strikeDamage(s: GameState, ref: CardRef, db: CardDatabase): number {
  const ids = new Set(keywordsOf(s, ref, db).map((k) => k.id));
  if (ids.has(KW.quadrupleStrike)) return 4;
  if (ids.has(KW.tripleStrike)) return 3;
  if (ids.has(KW.doubleStrike)) return 2;
  return 1;
}

/** 22-8 : nombre de fois par tour où la carte repasse en mode Action après un combat. */
export function readyAfterBattleCount(s: GameState, ref: CardRef, db: CardDatabase): number {
  const ids = new Set(keywordsOf(s, ref, db).map((k) => k.id));
  if (ids.has(KW.triAttack)) return 2; // X = 3, s'active X-1 fois
  if (ids.has(KW.dualAttack)) return 1; // X = 2
  return 0;
}

/**
 * 22-14-3 : une carte quitte la Zone de Combat. Une carte [Ultimate] est retirée de la partie
 * au lieu d'aller dans sa zone de destination. Renvoie true si elle a été retirée.
 */
export function removeIfUltimate(s: GameState, card: CardInstance, db: CardDatabase): boolean {
  if (!cardHasKeyword(db.get(card.cardId), KW.ultimate)) return false;
  card.mode = "active";
  card.faceUp = true;
  s.players[card.owner].removed.push(card);
  return true;
}

/**
 * 22-39-2 / 22-39-3 : si une carte [Unique] est déjà dans la Zone de Combat de son
 * propriétaire, il ne peut pas y jouer une autre carte du même nom.
 */
export function uniqueBlocks(s: GameState, card: CardInstance, db: CardDatabase): string | null {
  const name = db.get(card.cardId)?.name;
  const clash = s.players[card.owner].battle.find((c) => {
    const def = db.get(c.cardId);
    return def?.name === name && cardHasKeyword(def, KW.unique);
  });
  return clash ? `22-39 : une carte [Unique] « ${name} » est déjà dans votre Zone de Combat` : null;
}
