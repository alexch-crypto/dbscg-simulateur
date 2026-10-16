// Coûts d'Énergie et paiement (manuel 1-2, 1-14, 5-3, 20-21).
//
// Tout paiement en énergie se décrit de la même façon : des orbes de couleur obligatoires
// + un nombre d'énergies de n'importe quelle couleur. Ce modèle sert à jouer une carte
// normalement, mais servira aussi aux coûts de Capacité (Successeur « (vert)(jaune)(1) »,
// Activation « (vert) »...) et aux coûts de Combo (que des énergies sans couleur).

import type { CardDatabase, Color, EnergyCost } from "../cards/types";
import type { GameState, PlayerId } from "../state/types";
import { leaderFace } from "./leader";

export interface EnergyPayment {
  /** Orbes de couleur obligatoires. */
  colors: Partial<Record<Color, number>>;
  /** Énergies de n'importe quelle couleur. */
  generic: number;
}

/** Modification de coût par un effet (réduction ou augmentation). */
export type CostModifier =
  /** « Réduisez / augmentez de X le coût » : ne touche que le coût total (1-2-3, Piccolo Daimaô). */
  | { kind: "total"; amount: number }
  /** « Réduisez / augmentez de (jaune)(jaune) » : change les orbes ET le coût total (20-21). */
  | { kind: "colors"; colors: Partial<Record<Color, number>> };

const sum = (colors: Partial<Record<Color, number>>): number =>
  Object.values(colors).reduce((a, b) => a + (b ?? 0), 0);

/** Applique les modificateurs à un coût imprimé. Un coût "X" vaut `x` (1-2-2-2). */
export function applyCostModifiers(cost: EnergyCost, modifiers: readonly CostModifier[], x = 0): EnergyCost {
  let total = cost.total === "X" ? x : cost.total;
  const colors: Partial<Record<Color, number>> = { ...cost.specified };
  for (const m of modifiers) {
    if (m.kind === "total") {
      total += m.amount;
    } else {
      for (const [c, n] of Object.entries(m.colors) as [Color, number][]) {
        const current = colors[c] ?? 0;
        // 20-21-2-1 : on ne peut pas retirer plus d'orbes qu'il n'y en a ; le coût total
        // baisse seulement de ce qui a vraiment été retiré.
        const change = n < 0 ? -Math.min(current, -n) : n;
        colors[c] = current + change;
        total += change;
      }
    }
  }
  for (const c of Object.keys(colors) as Color[]) if (colors[c] === 0) delete colors[c];
  // 0-2-11 : un coût négatif est traité comme 0 (une fois toutes les modifications appliquées).
  return { total: Math.max(0, total), specified: colors };
}

/**
 * Ce qu'il faut payer pour un coût d'Énergie (5-3-1). Les orbes de couleur restent toujours
 * dus ; si le coût de couleur dépasse le coût total, on paie le coût de couleur (5-3-1-1).
 */
export function paymentForCost(cost: EnergyCost, x = 0): EnergyPayment {
  const total = cost.total === "X" ? x : cost.total;
  const colors = { ...cost.specified };
  return { colors, generic: Math.max(0, total - sum(colors)) };
}

export const paymentSize = (p: EnergyPayment): number => sum(p.colors) + p.generic;

/** Une source d'énergie : une carte de la Zone d'Énergie, ou un marqueur Énergie. */
export interface EnergySource {
  /** uid de la carte, ou "marker" pour un marqueur Énergie. */
  id: string;
  /** Couleurs qu'elle peut payer (une seule à la fois, au choix). */
  colors: readonly Color[];
}

/**
 * Cherche une façon d'attribuer chaque orbe de couleur à une source différente
 * (algorithme d'appariement : une carte multicolore peut couvrir une de ses couleurs au choix).
 * Renvoie, pour chaque orbe, l'index de la source utilisée ; null si impossible.
 */
function matchColors(sources: readonly EnergySource[], colors: Partial<Record<Color, number>>): number[] | null {
  const slots: Color[] = (Object.entries(colors) as [Color, number][]).flatMap(([c, n]) => Array<Color>(n).fill(c));
  const ownerOfSource = new Array<number>(sources.length).fill(-1);
  const tryAssign = (slot: number, seen: boolean[]): boolean => {
    for (let s = 0; s < sources.length; s++) {
      if (seen[s] || !sources[s]!.colors.includes(slots[slot]!)) continue;
      seen[s] = true;
      if (ownerOfSource[s] === -1 || tryAssign(ownerOfSource[s]!, seen)) {
        ownerOfSource[s] = slot;
        return true;
      }
    }
    return false;
  };
  for (let slot = 0; slot < slots.length; slot++) {
    if (!tryAssign(slot, new Array<boolean>(sources.length).fill(false))) return null;
  }
  const result = new Array<number>(slots.length);
  ownerOfSource.forEach((slot, s) => {
    if (slot >= 0) result[slot] = s;
  });
  return result;
}

/**
 * Vérifie qu'un ensemble de sources choisies par le joueur paie EXACTEMENT le coût (5-3-1).
 * Renvoie un message d'erreur, ou null si le paiement est valide.
 */
export function checkPayment(chosen: readonly EnergySource[], payment: EnergyPayment): string | null {
  const needed = paymentSize(payment);
  if (chosen.length !== needed) {
    return `5-3-1 : il faut passer exactement ${needed} Énergie(s) en mode Inertie (${chosen.length} choisie(s))`;
  }
  if (!matchColors(chosen, payment.colors)) {
    return `5-3-1 : les Énergies choisies ne couvrent pas le coût de couleur ${JSON.stringify(payment.colors)}`;
  }
  return null;
}

/**
 * Propose un paiement valide parmi les sources disponibles, ou null si c'est impossible (5-3-3).
 * Préférence : garder les marqueurs Énergie et les cartes multicolores pour la fin.
 */
export function findPayment(available: readonly EnergySource[], payment: EnergyPayment): EnergySource[] | null {
  if (available.length < paymentSize(payment)) return null;
  const flexibility = (s: EnergySource) => (s.id === "marker" ? 100 : s.colors.length);
  const sorted = [...available].sort((a, b) => flexibility(a) - flexibility(b));
  const assigned = matchColors(sorted, payment.colors);
  if (!assigned) return null;
  const used = new Set(assigned);
  const chosen = assigned.map((i) => sorted[i]!);
  for (let i = 0; i < sorted.length && chosen.length < paymentSize(payment); i++) {
    if (!used.has(i)) chosen.push(sorted[i]!);
  }
  return chosen;
}

/** Couleurs du Leader d'un joueur, selon la face visible. */
export function leaderColors(s: GameState, player: PlayerId, db: CardDatabase): Color[] {
  return leaderFace(s.players[player].leader, db)?.colors ?? [];
}

/**
 * Sources d'énergie utilisables par un joueur : ses Énergies en mode Action (5-3-3) et ses
 * marqueurs Énergie, qui ont les couleurs de son Leader (1-14-2, multicolore si le Leader l'est).
 */
export function availableEnergySources(s: GameState, player: PlayerId, db: CardDatabase): EnergySource[] {
  const p = s.players[player];
  const sources: EnergySource[] = p.energy
    .filter((c) => c.mode === "active")
    .map((c) => ({ id: c.uid, colors: db.get(c.cardId)?.colors ?? [] }));
  const markerColors = leaderColors(s, player, db);
  for (let i = 0; i < p.energyMarkers; i++) sources.push({ id: "marker", colors: markerColors });
  return sources;
}
