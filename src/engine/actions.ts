// applyAction est l'unique porte d'entrée pour modifier une partie : il vérifie que le coup
// est autorisé, puis renvoie le NOUVEL état (l'ancien n'est jamais modifié) et la liste des
// événements survenus (pour l'affichage, l'historique, les animations).

import type { Action, GameContext, GameEvent } from "./protocol";
import { activateAwaken } from "./rules/awaken";
import { combo, comboToZEnergy, declareAttack, declareBlocker, endStep, takeLife } from "./rules/battle";
import { chooseAuto } from "./rules/autos";
import { answerChoice, answerLife } from "./rules/effects";
import { checkDefeat } from "./rules/defeat";
import { playBattleCard } from "./rules/play";
import { chooseFirstPlayer, mulligan } from "./rules/setup";
import { chargeEnergy, endMainPhase } from "./rules/turn";
import { opponentOf, type GameState, type PendingDecision } from "./state/types";

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };

/** Actions qui répondent à chaque type de décision attendue. */
const ANSWERS: Record<PendingDecision["type"], readonly Action["type"][]> = {
  CHOOSE_FIRST_PLAYER: ["CHOOSE_FIRST_PLAYER"],
  MULLIGAN: ["MULLIGAN"],
  CHARGE: ["CHARGE_ENERGY"],
  // 1-5-4-1 : [Activation : Principale/Combat] (dont [Éveil]) pendant la phase principale et
  // l'étape d'Attaque du joueur actif, et pendant l'étape de Défense du joueur non actif.
  MAIN: ["PLAY_CARD", "ATTACK", "AWAKEN", "END_MAIN_PHASE"],
  BLOCKER: ["DECLARE_BLOCKER"],
  OFFENSE: ["COMBO", "AWAKEN", "END_STEP"],
  DEFENSE: ["COMBO", "AWAKEN", "END_STEP"],
  TAKE_DAMAGE: ["TAKE_LIFE"],
  COMBO_TO_Z: ["COMBO_TO_Z_ENERGY"],
  CHOOSE_CARDS: ["CHOOSE_CARDS"],
  CHOOSE_LIFE: ["CHOOSE_LIFE"],
  CHOOSE_AUTO: ["CHOOSE_AUTO"],
};

/** Vérifie que l'action répond bien à la décision attendue. Renvoie un message d'erreur sinon. */
function checkPending(s: GameState, action: Action): string | null {
  const pending = s.pending;
  if (!pending) return `aucune décision n'est attendue pour l'action ${action.type}`;
  if (!ANSWERS[pending.type].includes(action.type)) {
    return `décision attendue : ${pending.type} (reçu : ${action.type})`;
  }
  if (pending.player !== action.player) return `c'est à ${pending.player} de décider, pas à ${action.player}`;
  return null;
}

export function applyAction(state: GameState, action: Action, ctx: GameContext): ApplyResult {
  if (state.result) return { ok: false, error: "la partie est terminée" };

  // On travaille sur une copie : l'état reçu reste intact, même si le coup est refusé.
  const next = structuredClone(state);
  const events: GameEvent[] = [];
  const fail = (error: string): ApplyResult => ({ ok: false, error });

  if (action.type === "CONCEDE") {
    // 0-1-3-4 : un joueur peut concéder à n'importe quel moment et perd immédiatement.
    next.result = { kind: "win", winner: opponentOf(action.player), reason: "0-1-3-4 : abandon" };
    next.phase = "game_over";
    next.pending = null;
    events.push({ type: "GAME_OVER", result: next.result });
    return { ok: true, state: next, events };
  }

  const pendingError = checkPending(next, action);
  if (pendingError) return fail(pendingError);

  let error: string | null = null;
  switch (action.type) {
    case "CHOOSE_FIRST_PLAYER":
      chooseFirstPlayer(next, action, events);
      break;
    case "MULLIGAN":
      mulligan(next, action, events);
      break;
    case "CHARGE_ENERGY":
      error = chargeEnergy(next, action, ctx, events);
      break;
    case "PLAY_CARD":
      // 7-3-4-1 : jouer des cartes pendant le timing libre de la phase principale.
      error = playBattleCard(next, action, ctx, events);
      break;
    case "END_MAIN_PHASE":
      endMainPhase(next, events);
      break;
    case "ATTACK":
      // 7-3-4-4 : attaquer pendant le timing libre de la phase principale.
      error = declareAttack(next, action, ctx, events);
      break;
    case "DECLARE_BLOCKER":
      error = declareBlocker(next, action, ctx, events);
      break;
    case "COMBO":
      error = combo(next, action, ctx, events);
      break;
    case "END_STEP":
      endStep(next, ctx, events);
      break;
    case "TAKE_LIFE":
      error = takeLife(next, action, events);
      break;
    case "COMBO_TO_Z_ENERGY":
      error = comboToZEnergy(next, action, events);
      break;
    case "AWAKEN":
      error = activateAwaken(next, action, ctx, events);
      break;
    case "CHOOSE_CARDS":
      error = answerChoice(next, action, ctx, events);
      break;
    case "CHOOSE_LIFE":
      error = answerLife(next, action, ctx, events);
      break;
    case "CHOOSE_AUTO":
      error = chooseAuto(next, action, ctx, events);
      break;
    default: {
      const unknown: never = action;
      return fail(`action inconnue : ${JSON.stringify(unknown)}`);
    }
  }
  if (error) return fail(error);

  // Filet de sécurité : la défaite est aussi vérifiée après chaque coup (21-2).
  checkDefeat(next, events);
  return { ok: true, state: next, events };
}
