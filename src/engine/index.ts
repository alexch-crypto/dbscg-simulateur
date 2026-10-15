// Point d'entrée du moteur de règles.
// Règle d'or : ce dossier ne doit JAMAIS dépendre de l'interface (pas de HTML, pas de DOM).
// Ainsi le même moteur pourra tourner dans le navigateur de l'hôte (pair-à-pair)
// ou sur un serveur arbitre, sans réécriture.

export const ENGINE_VERSION = "0.1.0";

export * from "./cards/types";
export { parseCardFile, buildCardDatabase, type CardFileResult } from "./cards/loader";
export { validateDeck, MAIN_DECK_MIN, MAIN_DECK_MAX, MAX_COPIES, Z_DECK_MAX } from "./cards/validate-deck";
export * from "./state/types";
export { createGame, type NewGameInput, type CreateGameResult } from "./state/create";
export type { Action, GameEvent, GameContext, PaymentChoice } from "./protocol";
export {
  applyCostModifiers,
  paymentForCost,
  checkPayment,
  findPayment,
  type EnergyPayment,
  type EnergySource,
  type CostModifier,
} from "./rules/energy";
export { applyAction, type ApplyResult } from "./actions";
export { getLegalActions } from "./legal";
export * from "./view";
export { newRecord, replayGame, RECORD_FORMAT, RECORD_VERSION, type GameRecord, type ReplayResult } from "./replay";
