// [Éveil] (manuel 22-2) : Capacité-clef [Activation : Principale/Combat] des Leaders.
//
// La possibilité de s'éveiller vient des Capacités de la face VISIBLE du Leader : la face
// avant de Freezer a [Éveil], la face arrière non. On ne code donc pas « une seule fois »,
// ce qui laissera la place à l'[Éveil Z] (deck Z) qui, lui, demande un Leader déjà éveillé.
// Non géré pour l'instant : [Éveil : Afflux], coûts de Capacité, fenêtres de contre (12-2-2-5).

import type { CardFace } from "../cards/types";
import type { Action, GameContext, GameEvent } from "../protocol";
import type { EffectStep, GameState, PlayerId } from "../state/types";
import { allSupported, startResolution } from "./effects";

/** Face visible du Leader d'un joueur. */
export function leaderFace(s: GameState, player: PlayerId, ctx: GameContext): CardFace | undefined {
  const leader = s.players[player].leader;
  const card = ctx.cards.get(leader.cardId);
  return leader.side === "front" ? card?.front : card?.back;
}

interface AwakenAbility {
  condition: Record<string, unknown>[];
  cost: unknown[];
  effect: EffectStep[];
}

function awakenAbility(s: GameState, player: PlayerId, ctx: GameContext): AwakenAbility | undefined {
  const raw = leaderFace(s, player, ctx)?.abilities.find((a) => a["kind"] === "awaken");
  if (!raw) return undefined;
  return {
    condition: (raw["condition"] as Record<string, unknown>[] | undefined) ?? [],
    cost: (raw["cost"] as unknown[] | undefined) ?? [],
    effect: (raw["effect"] as EffectStep[] | undefined) ?? [],
  };
}

/** Évalue une condition de Capacité. Renvoie un message si elle n'est pas remplie (ou pas gérée). */
function checkCondition(s: GameState, player: PlayerId, condition: Record<string, unknown>): string | null {
  switch (condition["check"]) {
    case "life_at_most": {
      // 1-12-1 : les points de vie sont les cartes de la Zone de Vie.
      const max = condition["value"] as number;
      const life = s.players[player].life.length;
      return life <= max ? null : `condition non remplie : ${life} points de vie (il faut ${max} ou moins)`;
    }
    default:
      return `condition pas encore gérée : ${String(condition["check"])}`;
  }
}

/** Pourquoi le joueur ne peut pas s'éveiller maintenant (null = il peut). */
export function awakenBlocker(s: GameState, player: PlayerId, ctx: GameContext): string | null {
  const ability = awakenAbility(s, player, ctx);
  if (!ability) return "22-2 : la face visible de votre Leader n'a pas de Capacité [Éveil]";
  for (const c of ability.condition) {
    const error = checkCondition(s, player, c);
    if (error) return `22-2-3 : ${error}`;
  }
  if (ability.cost.length > 0) return "22-2-3 : coût de Capacité pas encore géré";
  if (!allSupported(ability.effect)) return "effet d'[Éveil] pas encore géré par le moteur";
  return null;
}

/** 22-2-3 / 22-2-4 : activer [Éveil], résoudre ses effets, puis retourner le Leader côté dos. */
export function activateAwaken(
  s: GameState,
  action: Extract<Action, { type: "AWAKEN" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const blocker = awakenBlocker(s, action.player, ctx);
  if (blocker) return blocker;
  const ability = awakenAbility(s, action.player, ctx)!;
  const leader = s.players[action.player].leader;
  events.push({ type: "AWAKEN_ACTIVATED", player: action.player });
  // 22-2-4 : effectuez les effets indiqués ; si la carte est de côté face, tournez-la côté dos.
  const steps: EffectStep[] = [...ability.effect, ...(leader.side === "front" ? [{ do: "flip_leader" }] : [])];
  startResolution(s, action.player, leader.uid, steps, s.pending!, events);
  return null;
}
