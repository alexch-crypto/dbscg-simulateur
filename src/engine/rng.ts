// Générateur de hasard « à graine » (algorithme mulberry32).
// Même graine => mêmes tirages, ce qui permet de rejouer une partie à l'identique
// et à l'arbitre (hôte ou serveur) d'être le seul à connaître le hasard.
// Son état est un simple nombre stocké dans l'état de la partie.

export interface RngHolder {
  rng: number;
}

/** Renvoie un nombre dans [0, 1) et fait avancer le générateur. */
export function nextRandom(holder: RngHolder): number {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Mélange une liste sur place (algorithme de Fisher-Yates). */
export function shuffleInPlace<T>(holder: RngHolder, list: T[]): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(holder) * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
}
