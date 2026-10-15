// Résolution des effets de Capacités (manuel, section 9), instruction par instruction.
// Le format des instructions est celui du fichier de cartes (docs/LISEZMOI-cartes.md).
//
// Une résolution peut s'interrompre pour demander un choix au joueur (5-2-2 : on choisit
// au moment de la résolution), puis reprendre là où elle s'était arrêtée.
//
// Instructions gérées pour l'instant (les autres arriveront à l'étape des effets) :
//   draw        : piocher `count` cartes (obligatoire)
//   set_active  : passer jusqu'à `up_to` de vos Énergies en mode Action
//   flip_leader : instruction interne, retourner le Leader (22-2-4)

import type { Action, GameContext, GameEvent } from "../protocol";
import type { EffectStep, GameState, PendingDecision, PlayerId } from "../state/types";
import { drawCards } from "./basic";
import { checkDefeat } from "./defeat";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Vérifie qu'une instruction est comprise par le moteur. */
function isSupported(step: EffectStep): boolean {
  switch (step.do) {
    case "draw":
      return typeof step["count"] === "number";
    case "set_active": {
      const t = step["target"];
      return isObject(t) && t["zone"] === "energy" && t["owner"] === "self" && typeof t["up_to"] === "number";
    }
    case "flip_leader":
      return true;
    default:
      return false;
  }
}

export const allSupported = (steps: readonly EffectStep[]): boolean => steps.every(isSupported);

/** Lance la résolution d'une liste d'instructions. */
export function startResolution(
  s: GameState,
  player: PlayerId,
  source: string,
  steps: EffectStep[],
  resume: PendingDecision,
  events: GameEvent[],
): void {
  s.resolving = { player, source, steps, index: 0, resume };
  s.pending = null;
  continueResolution(s, events);
}

/** Exécute les instructions jusqu'à la fin, ou jusqu'à ce qu'un choix soit nécessaire. */
function continueResolution(s: GameState, events: GameEvent[]): void {
  const r = s.resolving!;
  while (r.index < r.steps.length) {
    const step = r.steps[r.index]!;
    const p = s.players[r.player];
    switch (step.do) {
      case "draw":
        drawCards(s, r.player, step["count"] as number, events);
        // 21-2 : piocher sa dernière carte fait perdre immédiatement, même en pleine résolution.
        if (checkDefeat(s, events)) {
          s.resolving = null;
          return;
        }
        break;
      case "set_active": {
        // 0-2-4-1 : passer en mode Action une carte déjà en mode Action ne fait rien : on ne
        // propose que les Énergies en mode Inertie.
        const options = p.energy.filter((c) => c.mode === "rest").map((c) => c.uid);
        const upTo = (step["target"] as Record<string, unknown>)["up_to"] as number;
        if (options.length > 0 && upTo > 0) {
          // 5-2-4 : « jusqu'à » => le joueur choisit entre 0 et `up_to` cibles.
          s.pending = {
            type: "CHOOSE_CARDS",
            player: r.player,
            min: 0,
            max: Math.min(upTo, options.length),
            options,
            prompt: `Choisissez jusqu'à ${upTo} Énergie(s) à passer en mode Action`,
          };
          return; // on attend le choix (answerChoice reprendra)
        }
        // 5-2-6 : aucune cible possible, l'instruction est ignorée.
        break;
      }
      case "flip_leader": {
        // 22-2-4 / 21-10-2 : le Leader garde son mode et reste en combat s'il y était.
        const leader = p.leader;
        leader.side = leader.side === "front" ? "back" : "front";
        events.push({ type: "LEADER_FLIPPED", player: r.player, side: leader.side });
        break;
      }
    }
    r.index++;
  }
  // Fin de la résolution : retour au timing d'où la Capacité a été activée.
  s.pending = r.resume;
  s.resolving = null;
}

/** Le joueur répond à une demande de choix (CHOOSE_CARDS) pendant une résolution. */
export function answerChoice(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_CARDS" }>,
  _ctx: GameContext,
  events: GameEvent[],
): string | null {
  const pending = s.pending as Extract<PendingDecision, { type: "CHOOSE_CARDS" }>;
  const r = s.resolving;
  if (!r) return "aucun effet en cours de résolution";
  const chosen = action.uids;
  if (new Set(chosen).size !== chosen.length) return "5-2 : une même carte est choisie deux fois";
  if (chosen.length < pending.min || chosen.length > pending.max) {
    return `5-2 : choisissez entre ${pending.min} et ${pending.max} carte(s)`;
  }
  if (!chosen.every((uid) => pending.options.includes(uid))) return "5-2 : cette carte ne peut pas être choisie";

  const step = r.steps[r.index]!;
  if (step.do === "set_active") {
    const p = s.players[r.player];
    for (const uid of chosen) p.energy.find((c) => c.uid === uid)!.mode = "active";
    if (chosen.length > 0) events.push({ type: "ENERGY_SET_ACTIVE", player: r.player, uids: [...chosen] });
  }
  r.index++;
  s.pending = null;
  continueResolution(s, events);
  return null;
}
