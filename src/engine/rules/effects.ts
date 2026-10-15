// Résolution des effets de Capacités (manuel, section 9), instruction par instruction.
// Le format des instructions est celui du fichier de cartes (docs/LISEZMOI-cartes.md).
//
// Une résolution peut s'interrompre pour demander un choix au joueur (5-2-2 : on choisit
// au moment de la résolution), puis reprendre là où elle s'était arrêtée.
//
// Instructions gérées :
//   draw          piocher `count` cartes (obligatoire)
//   life_to_hand  rajouter à sa main `count` / jusqu'à `up_to` cartes de Vie (pas des dégâts, 1-13-2)
//   set_rest      passer des cartes en mode Inertie
//   set_active    passer des cartes en mode Action
//   ko            mettre KO des cartes de Combat
//   power_mod     +X / -X de puissance pour tout le tour ou tout le combat
//   flip_leader   (interne) retourner le Leader, 22-2-4
// Toute autre instruction est ignorée et signalée dans le journal (décision du joueur : on
// résout ce qui est géré et on prévient pour le reste).

import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type CardInstance, type Continuation, type EffectStep, type GameState, type PendingDecision, type PlayerId } from "../state/types";
import { continueWith } from "./autos";
import { drawCards } from "./basic";
import { matchesFilter } from "./conditions";
import { checkDefeat } from "./defeat";
import { koBattleCard } from "./zones";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lance la résolution d'une liste d'instructions. */
export function startResolution(
  s: GameState,
  ctx: GameContext,
  player: PlayerId,
  source: { uid: string; cardId: string },
  steps: EffectStep[],
  then: Continuation,
  events: GameEvent[],
): void {
  s.resolving = { player, source, steps, index: 0, then };
  s.pending = null;
  continueResolution(s, ctx, events);
}

/** Exécute les instructions jusqu'à la fin, ou jusqu'à ce qu'un choix soit nécessaire. */
function continueResolution(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const r = s.resolving!;
  // 21-2 : une défaite en pleine résolution (deck ou Vie vide) arrête tout.
  const defeated = () => {
    if (!checkDefeat(s, events)) return false;
    s.resolving = null;
    s.autoQueue = [];
    s.checkpointThen = null;
    return true;
  };
  if (defeated()) return;
  while (r.index < r.steps.length) {
    const waiting = runStep(s, ctx, r.steps[r.index]!, events);
    if (defeated()) return;
    if (waiting) return; // on attend un choix du joueur (answerChoice / answerLife reprendront)
    r.index++;
  }
  s.resolving = null;
  continueWith(s, ctx, r.then, events);
}

function notImplemented(s: GameState, what: string, events: GameEvent[]): void {
  const r = s.resolving!;
  events.push({ type: "NOT_IMPLEMENTED", player: r.player, cardId: r.source.cardId, what });
}

// ---------------------------------------------------------------------------
// Cibles
// ---------------------------------------------------------------------------

/** Une carte « en jeu » qu'un effet peut choisir : Leader, carte de Combat ou Énergie. */
interface Candidate {
  uid: string;
  player: PlayerId;
  zone: "leader" | "battle" | "energy";
  card?: CardInstance;
}

/** Cartes qui correspondent à une description de cible ; null si la description n'est pas gérée. */
function candidates(s: GameState, ctx: GameContext, target: Json): Candidate[] | null {
  const r = s.resolving!;
  const owners: PlayerId[] =
    target["owner"] === "opponent" ? [opponentOf(r.player)] : target["owner"] === "any" ? [r.player, opponentOf(r.player)] : [r.player];
  const zones = (Array.isArray(target["zone"]) ? target["zone"] : [target["zone"]]) as string[];
  const result: Candidate[] = [];
  for (const player of owners) {
    const p = s.players[player];
    for (const zone of zones) {
      if (zone === "leader") result.push({ uid: p.leader.uid, player, zone: "leader" });
      else if (zone === "battle" || zone === "energy") {
        for (const card of p[zone]) {
          const ok = matchesFilter(card, target["filter"], ctx.cards);
          if (ok === null) return null;
          if (ok) result.push({ uid: card.uid, player, zone, card });
        }
      } else if (zone === "unison") {
        // Pas encore de Zone Unisson : aucune cible.
      } else return null;
    }
  }
  return result;
}

/** Nombre de cibles : « jusqu'à N » => 0..N (5-2-4) ; « N » => autant que possible jusqu'à N (5-2-3). */
function targetCount(target: Json, available: number): { min: number; max: number } {
  if (typeof target["up_to"] === "number") return { min: 0, max: Math.min(target["up_to"], available) };
  const n = typeof target["count"] === "number" ? target["count"] : 1;
  const max = Math.min(n, available);
  return { min: max, max };
}

const PROMPTS: Record<string, string> = {
  set_rest: "à passer en mode Inertie",
  set_active: "à passer en mode Action",
  ko: "à mettre KO",
  power_mod: "qui gagne de la puissance",
};

/**
 * Prépare le choix des cibles d'une instruction. Applique directement si le choix est forcé.
 * Renvoie true si on attend le joueur.
 */
function chooseTargets(s: GameState, ctx: GameContext, step: EffectStep, pool: Candidate[], events: GameEvent[]): boolean {
  const target = step["target"] as Json;
  const { min, max } = targetCount(target, pool.length);
  // 5-2-6 : aucune cible possible => l'instruction est ignorée.
  if (max === 0) return false;
  // Choix forcé (il faut prendre toutes les cibles possibles) : pas besoin de demander.
  if (min === max && max === pool.length) {
    applyToTargets(s, ctx, step, pool.map((c) => c.uid), events);
    return false;
  }
  const r = s.resolving!;
  s.pending = {
    type: "CHOOSE_CARDS",
    player: r.player,
    min,
    max,
    options: pool.map((c) => c.uid),
    prompt: `${min === 0 ? `Choisissez jusqu'à ${max}` : `Choisissez ${max}`} carte(s) ${PROMPTS[step.do] ?? ""}`.trim(),
  };
  return true;
}

function findCandidate(s: GameState, uid: string): Candidate | null {
  for (const player of ["P1", "P2"] as const) {
    const p = s.players[player];
    if (p.leader.uid === uid) return { uid, player, zone: "leader" };
    for (const zone of ["battle", "energy"] as const) {
      const card = p[zone].find((c) => c.uid === uid);
      if (card) return { uid, player, zone, card };
    }
  }
  return null;
}

function setMode(s: GameState, c: Candidate, mode: "active" | "rest"): boolean {
  const current = c.zone === "leader" ? s.players[c.player].leader : c.card!;
  // 0-2-4-1 : déjà dans l'état demandé => rien ne se passe.
  if (current.mode === mode) return false;
  current.mode = mode;
  return true;
}

/** Applique une instruction aux cibles choisies. */
function applyToTargets(s: GameState, ctx: GameContext, step: EffectStep, uids: string[], events: GameEvent[]): void {
  const chosen = uids.map((uid) => findCandidate(s, uid)).filter((c): c is Candidate => c !== null);
  switch (step.do) {
    case "set_rest":
    case "set_active": {
      const mode = step.do === "set_rest" ? "rest" : "active";
      const changed = chosen.filter((c) => setMode(s, c, mode)).map((c) => c.uid);
      if (changed.length > 0) events.push({ type: "CARDS_MODE_CHANGED", uids: changed, mode });
      break;
    }
    case "ko":
      for (const c of chosen) if (c.zone === "battle") koBattleCard(s, ctx, c.player, c.card!, events);
      break;
    case "power_mod": {
      const until = step["duration"] as "turn" | "battle";
      for (const c of chosen) {
        s.powerMods.push({ uid: c.uid, amount: step["amount"] as number, until });
        events.push({ type: "POWER_MODIFIED", uid: c.uid, amount: step["amount"] as number, until });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/** Exécute une instruction. Renvoie true si on attend un choix du joueur. */
function runStep(s: GameState, ctx: GameContext, step: EffectStep, events: GameEvent[]): boolean {
  const r = s.resolving!;
  const p = s.players[r.player];
  switch (step.do) {
    case "draw":
      if (typeof step["count"] !== "number") break;
      drawCards(s, r.player, step["count"], events);
      return false;

    case "life_to_hand": {
      // 1-13-2 : ce n'est pas un dégât. 3-9-2 : on choisit des positions, à l'aveugle.
      const { min, max } = targetCount(step, p.life.length);
      if (max === 0) return false;
      s.pending = {
        type: "CHOOSE_LIFE",
        player: r.player,
        min,
        max,
        prompt: `${min === 0 ? `Rajoutez à votre main jusqu'à ${max}` : `Rajoutez à votre main ${max}`} carte(s) de vos points de vie`,
      };
      return true;
    }

    case "set_rest":
    case "set_active":
    case "ko":
    case "power_mod": {
      if (step.do === "power_mod" && !["turn", "battle"].includes(step["duration"] as string)) break;
      const target = step["target"];
      if (target === "this") {
        // « Cette carte » : la source, si elle est toujours en jeu (9-6-11 : sinon l'effet échoue).
        const self = findCandidate(s, r.source.uid);
        if (self && self.zone !== "energy") applyToTargets(s, ctx, step, [self.uid], events);
        return false;
      }
      if (!isObject(target)) break;
      let pool = candidates(s, ctx, target);
      if (pool === null) break;
      // On ne propose que les cartes que l'instruction change vraiment (0-2-4-1).
      if (step.do === "set_rest") pool = pool.filter((c) => (c.zone === "leader" ? s.players[c.player].leader : c.card!).mode === "active");
      if (step.do === "set_active") pool = pool.filter((c) => (c.zone === "leader" ? s.players[c.player].leader : c.card!).mode === "rest");
      if (step.do === "ko") pool = pool.filter((c) => c.zone === "battle");
      return chooseTargets(s, ctx, step, pool, events);
    }

    case "flip_leader": {
      // 22-2-4 / 21-10-2 : le Leader garde son mode et reste en combat s'il y était.
      const leader = p.leader;
      leader.side = leader.side === "front" ? "back" : "front";
      events.push({ type: "LEADER_FLIPPED", player: r.player, side: leader.side });
      return false;
    }
  }
  notImplemented(s, describeStep(step), events);
  return false;
}

/** Description courte d'une instruction non gérée, pour le journal. */
function describeStep(step: EffectStep): string {
  const details = Object.entries(step)
    .filter(([key]) => key !== "do")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return details ? `${step.do} (${details})` : step.do;
}

// ---------------------------------------------------------------------------
// Réponses du joueur
// ---------------------------------------------------------------------------

/** Le joueur répond à une demande de choix de cartes (CHOOSE_CARDS) pendant une résolution. */
export function answerChoice(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_CARDS" }>,
  ctx: GameContext,
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
  s.pending = null;
  applyToTargets(s, ctx, r.steps[r.index]!, chosen, events);
  r.index++;
  continueResolution(s, ctx, events);
  return null;
}

/** Le joueur choisit les positions de Vie à rajouter à sa main (CHOOSE_LIFE). */
export function answerLife(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_LIFE" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const pending = s.pending as Extract<PendingDecision, { type: "CHOOSE_LIFE" }>;
  const r = s.resolving;
  if (!r) return "aucun effet en cours de résolution";
  const p = s.players[action.player];
  const indices = action.indices;
  if (indices.length < pending.min || indices.length > pending.max) {
    return `choisissez entre ${pending.min} et ${pending.max} carte(s) de Vie`;
  }
  if (new Set(indices).size !== indices.length) return "une même carte de Vie est choisie deux fois";
  if (!indices.every((i) => Number.isInteger(i) && i >= 0 && i < p.life.length)) return "position de Vie invalide";
  const sorted = [...indices].sort((a, b) => a - b);
  const taken = [...sorted].reverse().map((i) => p.life.splice(i, 1)[0]!).reverse();
  const cardIds = taken.map((c) => (c.faceUp ? c.cardId : null));
  for (const c of taken) c.faceUp = false;
  p.hand.push(...taken);
  if (taken.length > 0) events.push({ type: "LIFE_TO_HAND", player: action.player, indices: sorted, cardIds });
  s.pending = null;
  r.index++;
  continueResolution(s, ctx, events);
  return null;
}
