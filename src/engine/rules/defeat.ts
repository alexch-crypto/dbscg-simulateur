// Application de l'évaluation de défaite (21-2) : application INTERRUPTIVE de règle,
// c'est-à-dire vérifiée immédiatement, même au milieu d'une autre action (21-1-2-1).
// Toute règle qui retire des cartes du deck ou de la Zone de Vie doit l'appeler juste après,
// puis s'arrêter si la partie est terminée (s.result).

import type { GameEvent } from "../protocol";
import { opponentOf, PLAYER_IDS, type GameState, type PlayerId } from "../state/types";

/** Renvoie le motif de défaite d'un joueur, ou null. */
function defeatReason(s: GameState, player: PlayerId): string | null {
  const p = s.players[player];
  if (p.life.length === 0) return "21-2-2-1 : plus de carte dans la Zone de Vie";
  if (p.deck.length === 0) return "21-2-2-2 : plus de carte dans le deck";
  return null;
}

/** Vérifie les conditions de défaite ; termine la partie si besoin. Renvoie true si la partie est finie. */
export function checkDefeat(s: GameState, events: GameEvent[]): boolean {
  if (s.result) return true;
  // Pendant la mise en place, la Zone de Vie est encore vide : la partie n'a pas commencé.
  if (s.phase === "setup") return false;

  const losers = PLAYER_IDS.map((p) => ({ p, reason: defeatReason(s, p) })).filter((l) => l.reason !== null);
  if (losers.length === 0) return false;

  if (losers.length === 2) {
    // 0-1-3-3 : les deux joueurs remplissent une condition de défaite en même temps.
    s.result = { kind: "draw", reason: `0-1-3-3 : défaite simultanée (${losers.map((l) => `${l.p} : ${l.reason}`).join(" ; ")})` };
  } else {
    const loser = losers[0]!;
    s.result = { kind: "win", winner: opponentOf(loser.p), reason: `${loser.p} perd — ${loser.reason}` };
  }
  s.phase = "game_over";
  s.pending = null;
  events.push({ type: "GAME_OVER", result: s.result });
  return true;
}
