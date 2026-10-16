// Conditions de Capacités (« Si votre Leader est vert... ») et filtres de cibles
// (« une carte de Combat adverse avec un coût d'énergie de 7 ou moins »).
// Format : celui du fichier de cartes (docs/LISEZMOI-cartes.md).

import type { CardDatabase, CardDefinition, CardFace } from "../cards/types";
import { opponentOf, type CardInstance, type GameState, type PlayerId } from "../state/types";

type Json = Record<string, unknown>;

export function leaderFaceOf(s: GameState, player: PlayerId, db: CardDatabase): CardFace | undefined {
  const leader = s.players[player].leader;
  const def = db.get(leader.cardId);
  return leader.side === "front" ? def?.front : def?.back;
}

/**
 * Vérifie une condition. Renvoie true / false, ou null si la condition n'est pas encore
 * gérée par le moteur.
 */
export function checkCondition(s: GameState, player: PlayerId, c: Json, db: CardDatabase): boolean | null {
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
    case "leader_character_and_color": {
      if (c["leader_face"] === "back" && s.players[player].leader.side !== "back") return false;
      return (leader?.character.includes(c["character"] as string) ?? false) && (leader?.colors.includes(c["color"] as never) ?? false);
    }
    case "energy_count_with_color":
      return me.energy.filter((e) => db.get(e.cardId)?.colors.includes(c["color"] as never)).length >= num("min");
    case "any_of": {
      const results = (c["of"] as Json[]).map((sub) => checkCondition(s, player, sub, db));
      if (results.some((r) => r === true)) return true;
      return results.some((r) => r === null) ? null : false;
    }
    default:
      return null;
  }
}

/** Vérifie toutes les conditions. Renvoie true / false, ou le nom de la première condition non gérée. */
export function checkConditions(s: GameState, player: PlayerId, conditions: unknown, db: CardDatabase): boolean | string {
  if (!Array.isArray(conditions)) return true;
  for (const c of conditions as Json[]) {
    const r = checkCondition(s, player, c, db);
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

/** Une carte correspond-elle au filtre ? Renvoie null si un critère n'est pas géré. */
export function matchesFilter(card: CardInstance, filter: unknown, db: CardDatabase): boolean | null {
  if (!filter) return true;
  const def = db.get(card.cardId);
  for (const [key, value] of Object.entries(filter as Json)) {
    switch (key) {
      case "cost_at_most":
        if (energyCostOf(def) > (value as number)) return false;
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
        if (!def?.traits.includes(value as string)) return false;
        break;
      case "colors_any":
        if (!(value as string[]).some((c) => def?.colors.includes(c as never))) return false;
        break;
      default:
        return null;
    }
  }
  return true;
}
