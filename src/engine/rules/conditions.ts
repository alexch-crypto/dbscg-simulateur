// Conditions de Capacités (« Si votre Leader est vert... ») et filtres de cibles
// (« une carte de Combat adverse avec un coût d'énergie de 7 ou moins »).
// Format : celui du fichier de cartes (docs/LISEZMOI-cartes.md).

import type { CardDatabase, CardDefinition, CardFace } from "../cards/types";
import { leaderFace } from "./leader";
import { opponentOf, type CardInstance, type GameState, type PlayerId } from "../state/types";

type Json = Record<string, unknown>;

export function leaderFaceOf(s: GameState, player: PlayerId, db: CardDatabase): CardFace | undefined {
  return leaderFace(s.players[player].leader, db);
}

/**
 * Vérifie une condition. Renvoie true / false, ou null si la condition n'est pas encore
 * gérée par le moteur.
 */
export function checkCondition(s: GameState, player: PlayerId, c: Json, db: CardDatabase, self?: string): boolean | null {
  const me = s.players[player];
  const opp = s.players[opponentOf(player)];
  const leader = leaderFaceOf(s, player, db);
  const num = (key: string) => c[key] as number;
  switch (c["check"]) {
    case "life_at_most":
      return me.life.length <= num("value");
    case "energy_count":
      // 1-14-3 : les marqueurs Énergie ne sont pas des Énergies.
      return me.energy.length >= num("min");
    case "opponent_energy_count":
      return opp.energy.length >= num("min");
    case "opponent_hand_count":
      return opp.hand.length >= num("min");
    case "opponent_battle_card_count":
      return opp.battle.length === num("value");
    case "leader_color":
      return leader?.colors.includes(c["value"] as never) ?? false;
    case "leader_color_any":
      return (c["values"] as string[]).some((v) => leader?.colors.includes(v as never));
    case "leader_mono_color":
      return leader?.colors.length === 1 && leader.colors[0] === c["value"];
    case "leader_has_trait":
      return leader?.traits.includes(c["value"] as string) ?? false;
    case "leader_not_trait":
      return !(leader?.traits.includes(c["value"] as string) ?? false);
    case "leader_back_character_and_color": {
      // « Si votre Leader de côté dos est un <X> vert » : on lit le VERSO de la carte Leader, qu'il
      // soit retourné ou non (décision du joueur).
      const def = db.get(s.players[player].leader.cardId);
      const back = def?.back;
      return (back?.character.includes(c["character"] as string) ?? false) && (back?.colors.includes(c["color"] as never) ?? false);
    }
    case "leader_character_and_color": {
      if (c["leader_face"] === "back" && s.players[player].leader.side !== "back") return false;
      return (leader?.character.includes(c["character"] as string) ?? false) && (leader?.colors.includes(c["color"] as never) ?? false);
    }
    case "energy_has_card":
      // « S'il y a une carte ... parmi vos Énergies »
      return me.energy.some((e) => matchesFilter(e, c["filter"], db, s) === true);
    case "energy_has_other_card":
      // « ... parmi vos Énergies autre que cette carte »
      return me.energy.some((e) => e.uid !== self && matchesFilter(e, c["filter"], db, s) === true);
    case "control_unison":
    case "control_z_unison": {
      // « Si vous avez une Unisson (Z) verte (avec un coût de couleur de 2 / X marqueurs ou plus) en jeu ».
      const filter = (c["filter"] ?? {}) as Json;
      const { min_markers: minMarkers, ...rest } = filter;
      return me.unison.some(
        (u) =>
          (c["check"] !== "control_z_unison" || db.get(u.cardId)?.type === "z_unison") &&
          matchesFilter(u, rest, db, s) === true &&
          (typeof minMarkers !== "number" || (u.markers ?? 0) >= minMarkers),
      );
    }
    case "opponent_rest_card_count": {
      // « Si votre adversaire a X cartes ou plus en mode Inertie » : Leader, Combat, Unisson, Énergie.
      const cards = [opp.leader, ...opp.battle, ...opp.unison, ...opp.energy];
      return cards.filter((x) => x.mode === "rest").length >= num("min");
    }
    case "energy_count_with_color":
      return me.energy.filter((e) => db.get(e.cardId)?.colors.includes(c["color"] as never)).length >= num("min");
    case "own_card_in_battle_attacking_battle_card": {
      // « Qu'un de vos <...> est dans un combat durant lequel il attaque une carte de Combat. »
      const battle = s.battle;
      if (!battle || battle.attacker.player !== player) return false;
      const attacker = me.battle.find((x) => x.uid === battle.attacker.uid);
      const defender = opp.battle.find((x) => x.uid === battle.defender.uid);
      return attacker !== undefined && defender !== undefined && matchesFilter(attacker, c["filter"], db, s) === true;
    }
    case "any_of": {
      const results = (c["of"] as Json[]).map((sub) => checkCondition(s, player, sub, db, self));
      if (results.some((r) => r === true)) return true;
      return results.some((r) => r === null) ? null : false;
    }
    case "all_of": {
      const results = (c["of"] as Json[]).map((sub) => checkCondition(s, player, sub, db, self));
      if (results.some((r) => r === false)) return false;
      return results.some((r) => r === null) ? null : true;
    }
    case "your_turn":
      return s.turnPlayer === player;
    case "opponent_life_at_least":
      return opp.life.length >= num("value");
    case "this_in_battle":
      // « Si cette carte est en combat » (attaquante ou carte de défense).
      return !!s.battle && (s.battle.attacker.uid === self || s.battle.defender.uid === self);
    case "leader_character_contains":
      // « Si votre Leader inclut <GT> dans son nom de personnage ».
      return leader?.character.some((ch) => ch.includes(c["value"] as string)) ?? false;
    case "all_energy_sources_color": {
      // « Si toutes vos sources d'énergie sont vertes » : Énergies et Énergies Z.
      const color = c["value"] as string;
      return [...me.energy, ...me.zEnergy].every((e) => db.get(e.cardId)?.colors.includes(color as never) ?? false);
    }
    case "link": {
      // 22-21 [Lien X] : X cartes de Combat (ou de la carte indiquée) ou plus dans votre Zone de Combat.
      const cards = me.battle.filter((b) => db.get(b.cardId)?.type === "battle" || db.get(b.cardId)?.type === "z_battle");
      return cards.filter((b) => matchesFilter(b, c["filter"], db, s) === true).length >= num("value");
    }
    case "spark":
      // 22-26 [Étincelle X] : X cartes ou plus dans votre Dispersion.
      return me.drop.length >= num("value");
    default:
      return null;
  }
}

/**
 * Conditions portées par une Capacité : sa liste `condition`, et les mots-clés [Lien X]
 * (`link`, `link_filter`) et [Étincelle X] (`spark`).
 */
export function abilityConditions(ability: Json): unknown {
  const list = Array.isArray(ability["condition"]) ? [...(ability["condition"] as Json[])] : [];
  if (typeof ability["link"] === "number") list.push({ check: "link", value: ability["link"], filter: ability["link_filter"] });
  if (typeof ability["spark"] === "number") list.push({ check: "spark", value: ability["spark"] });
  return list;
}

/** Vérifie toutes les conditions. Renvoie true / false, ou le nom de la première condition non gérée. */
export function checkConditions(
  s: GameState,
  player: PlayerId,
  conditions: unknown,
  db: CardDatabase,
  self?: string,
): boolean | string {
  if (!Array.isArray(conditions)) return true;
  for (const c of conditions as Json[]) {
    const r = checkCondition(s, player, c, db, self);
    if (r === null) return String(c["check"]);
    if (!r) return false;
  }
  return true;
}

/** Coût d'énergie d'une carte pour les filtres (1-2-5 : coût total, ou coût de couleur s'il est plus grand). */
export function energyCostOf(def: CardDefinition | undefined): number {
  if (!def?.cost) return 0;
  const total = def.cost.total === "X" ? 0 : def.cost.total;
  const colors = Object.values(def.cost.specified).reduce((a, b) => a + (b ?? 0), 0);
  return Math.max(total, colors);
}

/**
 * Coût d'énergie ACTUEL d'une carte en jeu : coût imprimé + augmentations / réductions en cours
 * (ex. Freezer BT24-105 « augmentez du nombre déclaré le coût de cette carte »).
 */
export function currentEnergyCost(s: GameState | undefined, card: CardInstance, db: CardDatabase): number {
  const base = energyCostOf(db.get(card.cardId));
  if (!s) return base;
  const change = s.effects.reduce((sum, e) => sum + (e.uid === card.uid && e.kind === "cost_mod" ? e.amount : 0), 0);
  return Math.max(0, base + change);
}

/**
 * Origines (traits) d'une carte, avec celles qu'elle s'attribue elle-même dans toutes les zones
 * (« acquiert «Shenron» dans toutes les zones », Oolong, Désir immédiat).
 */
export function traitsOf(def: CardDefinition | undefined): string[] {
  if (!def) return [];
  const extra: string[] = [];
  for (const ability of def.abilities) {
    if (ability["kind"] !== "permanent" || ability["condition"]) continue;
    for (const e of (ability["effect"] ?? []) as Json[]) {
      if (e["do"] === "grant_trait" && e["target"] === "this" && e["zones"] === "all" && typeof e["trait"] === "string") extra.push(e["trait"]);
    }
  }
  return extra.length > 0 ? [...def.traits, ...extra] : def.traits;
}

const sameColors = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c) => b.includes(c));

/** Coût de couleur d'une carte : nombre total de ses orbes (1-2-3). */
export const colorCostOf = (def: CardDefinition | undefined): number =>
  Object.values(def?.cost?.specified ?? {}).reduce((a, b) => a + (b ?? 0), 0);

/**
 * Une carte correspond-elle à une description `{ filter }` ou `{ filter_any: [...] }` (« ... ou ... ») ?
 * Renvoie null si un critère n'est pas géré.
 */
export function matchesSpec(card: CardInstance, spec: Json, db: CardDatabase, s?: GameState): boolean | null {
  const any = spec["filter_any"];
  if (Array.isArray(any)) {
    const results = any.map((f) => matchesFilter(card, f, db, s));
    if (results.some((r) => r === true)) return matchesFilter(card, spec["filter"], db, s);
    return results.some((r) => r === null) ? null : false;
  }
  return matchesFilter(card, spec["filter"], db, s);
}

/**
 * Une carte correspond-elle au filtre ? Renvoie null si un critère n'est pas géré.
 * Avec `s`, les coûts comparés sont les coûts actuels (augmentations comprises).
 */
export function matchesFilter(card: CardInstance, filter: unknown, db: CardDatabase, s?: GameState): boolean | null {
  if (!filter) return true;
  const def = db.get(card.cardId);
  for (const [key, value] of Object.entries(filter as Json)) {
    switch (key) {
      // 19-1-6-1 : un jeton sans coût d'énergie ne peut pas être choisi par un critère de coût.
      case "cost_at_most":
        if (!def?.cost || currentEnergyCost(s, card, db) > (value as number)) return false;
        break;
      case "cost":
        if (!def?.cost || currentEnergyCost(s, card, db) !== value) return false;
        break;
      case "combo_cost":
        if (def?.combo?.cost !== value) return false;
        break;
      case "power":
        if (def?.power !== value) return false;
        break;
      case "not_trait":
        if (traitsOf(def).includes(value as string)) return false;
        break;
      case "mono_color":
        if (!sameColors(def?.colors ?? [], [value as string])) return false;
        break;
      case "multicolor_exact":
        // « carte multicolore vert-jaune » : exactement ces couleurs.
        if (!sameColors(def?.colors ?? [], value as string[])) return false;
        break;
      case "not_token":
        if (value === true && def?.token) return false;
        break;
      case "mode":
        if (card.mode !== value) return false;
        break;
      case "type":
        if (def?.type !== value) return false;
        break;
      case "character":
        if (!def?.character.includes(value as string)) return false;
        break;
      case "trait":
        if (!traitsOf(def).includes(value as string)) return false;
        break;
      case "colors_any":
        if (!(value as string[]).some((c) => def?.colors.includes(c as never))) return false;
        break;
      case "color_cost":
        if (colorCostOf(def) !== value) return false;
        break;
      case "name":
        if (def?.name !== value) return false;
        break;
      case "character_contains":
        if (!def?.character.some((ch) => ch.includes(value as string))) return false;
        break;
      case "character_only":
        // « une carte exclusivement <X> » : ce seul nom de personnage.
        if (def?.character.length !== 1 || def.character[0] !== value) return false;
        break;
      case "not_keyword":
        if (def?.keywords.some((k) => k.id === value)) return false;
        break;
      case "token_name":
        // « vos jetons Terrien » : aucun jeton de ce nom n'est créé par les cartes connues.
        if (!def?.token || def.name !== `Jeton ${value as string}`) return false;
        break;
      default:
        return null;
    }
  }
  return true;
}
