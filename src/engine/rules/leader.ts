// Le Leader « tel qu'il est en jeu » : face avant, face arrière (après [Éveil]), ou Leader Z
// posé par-dessus ([Éveil Z], 15-1-4-1 : on lit alors les informations du Leader Z).

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { CardDatabase, CardFace } from "../cards/types";
import type { LeaderState } from "../state/types";

/** Informations actuelles du Leader (nom, couleurs, puissance, mots-clés, Capacités). */
export function leaderFace(leader: LeaderState, db: CardDatabase): CardFace | undefined {
  if (leader.z) return db.get(leader.z.cardId);
  const def = db.get(leader.cardId);
  return leader.side === "front" ? def?.front : def?.back;
}

/** Capacités actuelles du Leader (avec les raccourcis « same_as » résolus). */
export function leaderAbilities(leader: LeaderState, db: CardDatabase): RawAbility[] {
  if (leader.z) return abilitiesOf(db, db.get(leader.z.cardId));
  return abilitiesOf(db, db.get(leader.cardId), leader.side);
}

/** Numéro de la carte qui porte les Capacités actuelles du Leader. */
export const leaderCardId = (leader: LeaderState): string => leader.z?.cardId ?? leader.cardId;
