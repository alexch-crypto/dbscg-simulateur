// Résolution des effets de Capacités (manuel, section 9), instruction par instruction.
// Le format des instructions est celui du fichier de cartes (docs/LISEZMOI-cartes.md).
//
// Une résolution peut s'interrompre pour demander un choix au joueur (5-2-2 : on choisit
// au moment de la résolution), puis reprendre là où elle s'était arrêtée.
//
// Instructions gérées :
//   draw                      piocher `count` cartes (obligatoire)
//   life_to_hand              rajouter à sa main des cartes de Vie (pas des dégâts, 1-13-2)
//   set_rest / set_active     passer des cartes en mode Inertie / Action
//   ko                        mettre KO des cartes de Combat
//   power_mod                 +X / -X de puissance pour tout le tour ou tout le combat
//   lock_active               « ne peut pas passer en mode Action » (durées diverses)
//   negate_skills             « annulez ses Capacités » pour tout le tour
//   negate_one_keyword        « annulez une de ses Capacités-clefs » pour tout le tour
//   grant_keywords            « acquiert [X] » pour tout le tour
//   discard                   défausser des cartes de sa main (20-7)
//   opponent_discards         l'adversaire choisit des cartes de sa main et les défausse
//   discard_from_opponent_hand  choisir à l'aveugle dans la main adverse et défausser
//   move_from_hand            placer une carte de sa main dans une zone (Dimension parallèle)
//   move_to_drop              placer des cartes (ex. de la Zone de Combo) dans la Dispersion
//   look_top_deck             regarder le dessus de son deck, en prendre, puis mélanger (20-12)
//   play_self                 jouer cette carte (depuis la main / la Dispersion), 5-5-3
//   optional                  « Vous pouvez [coût]. Si vous le faites, [effet] » (20-16)
//   if                        « De plus, si la carte choisie est... »
//   remove_markers            (pas encore de Zone Unisson : aucune cible)
//   flip_leader               (interne) retourner le Leader, 22-2-4
// Toute autre instruction est ignorée et signalée dans le journal (décision du joueur).

import type { Action, GameContext, GameEvent } from "../protocol";
import {
  opponentOf,
  type CardInstance,
  type ContinuousEffect,
  type Continuation,
  type EffectStep,
  type GameState,
  type PendingDecision,
  type PlayerId,
} from "../state/types";
import { continueWith } from "./autos";
import { drawCards, shuffleDeck } from "./basic";
import { energyCostOf, matchesFilter } from "./conditions";
import { openCounterWindow } from "./counters";
import { checkDefeat } from "./defeat";
import { keywordsOf, readyBlockedByEffect } from "./keywords";
import { enterBattleArea } from "./play";
import { forgetCard, koBattleCard } from "./zones";

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
  x?: number,
): void {
  // Un effet déjà en cours (interrompu par celui-ci) est mis de côté et reprendra ensuite.
  if (s.resolving) s.suspended.push(s.resolving);
  s.resolving = { player, source, steps: [...steps], index: 0, then, saved: {}, memo: [], ...(x !== undefined ? { x } : {}) };
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
    s.suspended = [];
    s.autoQueue = [];
    s.checkpointThen = null;
    return true;
  };
  if (defeated()) return;
  while (r.index < r.steps.length) {
    const waiting = runStep(s, ctx, r.steps[r.index]!, events);
    if (defeated()) return;
    if (waiting) return; // on attend un choix du joueur (les fonctions answer* reprendront)
    r.index++;
  }
  // L'effet interrompu (s'il y en a un) redevient l'effet en cours.
  s.resolving = s.suspended.pop() ?? null;
  continueWith(s, ctx, r.then, events);
}

/** Reprend la résolution en cours après une fenêtre de contre ouverte au milieu de l'effet. */
export function resumeResolution(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  if (!s.resolving) return;
  nextStep(s, ctx, events);
}

/** Passe à l'instruction suivante après un choix du joueur. */
function nextStep(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const r = s.resolving!;
  r.index++;
  r.memo = [];
  s.pending = null;
  continueResolution(s, ctx, events);
}

function notImplemented(s: GameState, what: string, events: GameEvent[]): void {
  const r = s.resolving!;
  events.push({ type: "NOT_IMPLEMENTED", player: r.player, cardId: r.source.cardId, what });
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
// Durées
// ---------------------------------------------------------------------------

/** Dernier tour pendant lequel un effet d'une durée donnée reste actif (ou null si non gérée). */
function untilTurnFor(s: GameState, duration: unknown): { untilTurn: number; battleOnly?: boolean; chargeOnly?: boolean } | null {
  const me = s.resolving!.player;
  const myTurn = s.turnPlayer === me;
  switch (duration) {
    case "turn":
      return { untilTurn: s.turnNumber };
    case "battle":
      return { untilTurn: s.turnNumber, battleOnly: true };
    case "until_end_of_opponent_turn":
      return { untilTurn: myTurn ? s.turnNumber + 1 : s.turnNumber };
    case "opponent_next_charge_phase":
      return { untilTurn: myTurn ? s.turnNumber + 1 : s.turnNumber + 2, chargeOnly: true };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cibles en jeu (Leader, Zone de Combat, Énergie, Zone de Combo)
// ---------------------------------------------------------------------------

type BoardZone = "leader" | "battle" | "energy" | "combo";

/** Une carte en jeu qu'un effet peut choisir. */
interface Candidate {
  uid: string;
  player: PlayerId;
  zone: BoardZone;
  card?: CardInstance;
}

function modeHolder(s: GameState, c: Candidate): { mode: "active" | "rest" } {
  return c.zone === "leader" ? s.players[c.player].leader : c.card!;
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
      if (zone === "leader") {
        result.push({ uid: p.leader.uid, player, zone: "leader" });
      } else if (zone === "battle" || zone === "energy" || zone === "combo") {
        for (const card of p[zone]) {
          const ok = matchesFilter(card, target["filter"], ctx.cards, s);
          if (ok === null) return null;
          if (ok) result.push({ uid: card.uid, player, zone, card });
        }
      } else if (zone !== "unison") {
        // Pas encore de Zone Unisson : aucune cible. Toute autre zone n'est pas gérée.
        return null;
      }
    }
  }
  return result;
}

function findCandidate(s: GameState, uid: string): Candidate | null {
  for (const player of ["P1", "P2"] as const) {
    const p = s.players[player];
    if (p.leader.uid === uid) return { uid, player, zone: "leader" };
    for (const zone of ["battle", "energy", "combo"] as const) {
      const card = p[zone].find((c) => c.uid === uid);
      if (card) return { uid, player, zone, card };
    }
  }
  return null;
}

/** Nombre de cibles : « jusqu'à N » => 0..N (5-2-4) ; « N » => autant que possible jusqu'à N (5-2-3). */
function targetCount(spec: Json, available: number): { min: number; max: number } {
  // « Choisissez n'importe quel nombre de cartes » : de 0 à toutes.
  if (spec["any_number"] === true) return { min: 0, max: available };
  if (typeof spec["up_to"] === "number") return { min: 0, max: Math.min(spec["up_to"], available) };
  const n = typeof spec["count"] === "number" ? spec["count"] : 1;
  const max = Math.min(n, available);
  return { min: max, max };
}

const PROMPTS: Record<string, string> = {
  set_rest: "à passer en mode Inertie",
  set_active: "à passer en mode Action",
  ko: "à mettre KO",
  power_mod: "qui gagne de la puissance",
  lock_active: "qui ne pourra pas passer en mode Action",
  negate_skills: "dont les Capacités sont annulées",
  negate_one_keyword: "dont une Capacité-clef est annulée",
  move_to_drop: "à placer dans la Dispersion",
  discard: "de votre main à défausser",
  opponent_discards: "de votre main à défausser",
  move_from_hand: "de votre main à déplacer",
};

/**
 * Demande au joueur de choisir parmi `options`, ou applique directement si le choix est forcé.
 * Renvoie true si on attend le joueur.
 */
function askOrApply(
  s: GameState,
  ctx: GameContext,
  step: EffectStep,
  chooser: PlayerId,
  options: string[],
  count: { min: number; max: number },
  events: GameEvent[],
  looked?: { uid: string; cardId: string }[],
  maxTotalCost?: number,
): boolean {
  // 5-2-6 : aucune cible possible => l'instruction est ignorée.
  if (count.max === 0 && !looked) return false;
  // Choix forcé (il faut prendre toutes les cibles possibles) : pas besoin de demander.
  if (!looked && maxTotalCost === undefined && count.min === count.max && count.max === options.length) {
    return applyChoice(s, ctx, step, options, events);
  }
  const what = count.min === 0 ? `Choisissez jusqu'à ${count.max}` : `Choisissez ${count.max}`;
  s.pending = {
    type: "CHOOSE_CARDS",
    player: chooser,
    min: count.min,
    max: count.max,
    options,
    prompt: `${what} carte(s) ${PROMPTS[step.do] ?? ""}${
      maxTotalCost !== undefined ? ` (total des coûts d'énergie : ${maxTotalCost} ou moins)` : ""
    }`.trim(),
    ...(looked ? { looked } : {}),
    ...(maxTotalCost !== undefined ? { maxTotalCost } : {}),
  };
  return true;
}

/** Ajoute un effet continu à chaque carte choisie. */
function addEffects(s: GameState, uids: string[], effect: (uid: string) => ContinuousEffect): void {
  for (const uid of uids) s.effects.push(effect(uid));
}

/** Retire une carte de la main d'un joueur. */
function takeFromHand(s: GameState, player: PlayerId, uid: string): CardInstance | null {
  const hand = s.players[player].hand;
  const i = hand.findIndex((c) => c.uid === uid);
  return i < 0 ? null : hand.splice(i, 1)[0]!;
}

function toDrop(s: GameState, card: CardInstance): void {
  card.mode = "active";
  card.faceUp = true;
  s.players[card.owner].drop.push(card);
}

/**
 * Applique l'instruction en cours aux cartes choisies. Renvoie true si un second choix est
 * nécessaire (ex. quel mot-clé annuler).
 */
function applyChoice(s: GameState, ctx: GameContext, step: EffectStep, uids: string[], events: GameEvent[]): boolean {
  const r = s.resolving!;
  if (typeof step["save_as"] === "string") r.saved[step["save_as"]] = [...uids];
  const chosen = uids.map((uid) => findCandidate(s, uid)).filter((c): c is Candidate => c !== null);
  switch (step.do) {
    case "set_rest":
    case "set_active": {
      const mode = step.do === "set_rest" ? "rest" : "active";
      const changed = chosen
        .filter((c) => {
          const holder = modeHolder(s, c);
          // 0-2-4-1 : déjà dans l'état demandé => rien ne se passe.
          if (holder.mode === mode) return false;
          if (mode === "active" && readyBlockedByEffect(s, c.uid)) return false;
          holder.mode = mode;
          return true;
        })
        .map((c) => c.uid);
      if (changed.length > 0) events.push({ type: "CARDS_MODE_CHANGED", uids: changed, mode });
      return false;
    }
    case "ko":
      for (const c of chosen) if (c.zone === "battle") koBattleCard(s, ctx, c.player, c.card!, events);
      return false;
    case "power_mod": {
      const until = step["duration"] as "turn" | "battle";
      for (const c of chosen) {
        s.powerMods.push({ uid: c.uid, amount: step["amount"] as number, until });
        events.push({ type: "POWER_MODIFIED", uid: c.uid, amount: step["amount"] as number, until });
      }
      return false;
    }
    case "lock_active": {
      const d = untilTurnFor(s, step["duration"])!;
      addEffects(s, uids, (uid) => ({ uid, kind: "lock_active", chargeOnly: d.chargeOnly ?? false, untilTurn: d.untilTurn }));
      if (uids.length > 0) events.push({ type: "CARDS_LOCKED", uids: [...uids] });
      return false;
    }
    case "negate_skills": {
      const d = untilTurnFor(s, step["duration"])!;
      addEffects(s, uids, (uid) => ({ uid, kind: "negate_all", untilTurn: d.untilTurn, ...(d.battleOnly ? { battleOnly: true } : {}) }));
      if (uids.length > 0) events.push({ type: "SKILLS_NEGATED", uids: [...uids] });
      return false;
    }
    case "negate_one_keyword": {
      // Second choix : quel mot-clé annuler (pour chaque carte choisie, une à la fois).
      r.memo = [...uids];
      return askKeyword(s, ctx, step, events);
    }
    case "grant_keywords": {
      const d = untilTurnFor(s, step["duration"])!;
      for (const keyword of step["keywords"] as string[]) {
        addEffects(s, uids, (uid) => ({ uid, kind: "grant_keyword", keyword, untilTurn: d.untilTurn }));
      }
      if (uids.length > 0) events.push({ type: "KEYWORDS_GRANTED", uids: [...uids], keywords: [...(step["keywords"] as string[])] });
      return false;
    }
    case "modify_energy_cost": {
      // « Augmentez / réduisez de X le coût d'énergie de cette carte pour tout le tour. »
      // « +X » : le nombre déclaré en coût de Capacité (20-5).
      const raw = step["amount"];
      const amount = raw === "+X" ? (r.x ?? 0) : raw === "-X" ? -(r.x ?? 0) : typeof raw === "number" ? raw : 0;
      if (amount === 0) return false;
      const d = untilTurnFor(s, step["duration"])!;
      addEffects(s, uids, (uid) => ({ uid, kind: "cost_mod", amount, untilTurn: d.untilTurn }));
      events.push({ type: "COST_MODIFIED", uids: [...uids], amount });
      return false;
    }
    case "move_to_drop": {
      for (const c of chosen) {
        if (!c.card || c.zone === "leader") continue;
        const zone = s.players[c.player][c.zone as "battle" | "energy" | "combo"];
        zone.splice(zone.indexOf(c.card), 1);
        if (c.zone === "battle") forgetCard(s, c.uid);
        toDrop(s, c.card);
        events.push({ type: "CARD_TO_DROP", player: c.player, uid: c.uid, cardId: c.card.cardId, from: c.zone });
      }
      return false;
    }
    case "discard":
    case "opponent_discards": {
      // 20-7-1 : défausser = placer une carte de la main dans la Dispersion de son propriétaire.
      const owner = step.do === "discard" ? r.player : opponentOf(r.player);
      const cards = uids.map((uid) => takeFromHand(s, owner, uid)).filter((c): c is CardInstance => c !== null);
      for (const c of cards) toDrop(s, c);
      if (cards.length > 0) events.push({ type: "CARDS_DISCARDED", player: owner, cardIds: cards.map((c) => c.cardId) });
      return false;
    }
    case "move_from_hand": {
      // 20-8-1 : la Dimension parallèle est une zone publique, cartes de côté face.
      const cards = uids.map((uid) => takeFromHand(s, r.player, uid)).filter((c): c is CardInstance => c !== null);
      for (const c of cards) {
        c.faceUp = true;
        c.mode = "active";
        s.players[c.owner].warp.push(c);
      }
      if (cards.length > 0) events.push({ type: "CARDS_TO_WARP", player: r.player, cardIds: cards.map((c) => c.cardId) });
      return false;
    }
    case "look_top_deck": {
      // Les cartes choisies vont en main (révélées si demandé), puis le deck est mélangé.
      const p = s.players[r.player];
      const pick = step["pick"] as Json;
      const taken = uids.map((uid) => p.deck.splice(p.deck.findIndex((c) => c.uid === uid), 1)[0]!);
      p.hand.push(...taken);
      if (taken.length > 0) {
        events.push({
          type: "CARDS_TO_HAND",
          player: r.player,
          from: "deck",
          cardIds: pick["reveal"] ? taken.map((c) => c.cardId) : taken.map(() => null),
        });
      }
      // 20-12-3 : les cartes regardées et non prises restent dans le deck, qui est mélangé.
      if (step["then"] === "shuffle_deck") shuffleDeck(s, r.player, events);
      return false;
    }
  }
  return false;
}

/** negate_one_keyword : demande quel mot-clé annuler pour la prochaine carte mémorisée. */
function askKeyword(s: GameState, ctx: GameContext, step: EffectStep, events: GameEvent[]): boolean {
  const r = s.resolving!;
  while (r.memo.length > 0) {
    const uid = r.memo[0]!;
    const c = findCandidate(s, uid);
    const keywords = c ? keywordsOf(s, { player: c.player, uid }, ctx.cards).map((k) => k.id) : [];
    if (keywords.length === 0) {
      r.memo.shift();
      continue;
    }
    if (keywords.length === 1) {
      negateKeyword(s, step, uid, keywords[0]!, events);
      r.memo.shift();
      continue;
    }
    s.pending = {
      type: "CHOOSE_OPTION",
      player: r.player,
      prompt: "Choisissez la Capacité-clef à annuler",
      options: [...new Set(keywords)].map((k) => ({ id: k, label: k })),
    };
    return true;
  }
  return false;
}

function negateKeyword(s: GameState, step: EffectStep, uid: string, keyword: string, events: GameEvent[]): void {
  const d = untilTurnFor(s, step["duration"])!;
  s.effects.push({ uid, kind: "negate_keyword", keyword, untilTurn: d.untilTurn });
  events.push({ type: "KEYWORD_NEGATED", uid, keyword });
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/** Instructions qui choisissent des cartes en jeu (cible « this », « chosen » ou description). */
const BOARD_STEPS = new Set([
  "set_rest",
  "set_active",
  "ko",
  "power_mod",
  "lock_active",
  "negate_skills",
  "negate_one_keyword",
  "grant_keywords",
  "move_to_drop",
  "remove_markers",
  "modify_energy_cost",
]);

/** Cartes de la main d'un joueur correspondant à un filtre (null si filtre non géré). */
function handOptions(s: GameState, ctx: GameContext, player: PlayerId, filter: unknown): string[] | null {
  const result: string[] = [];
  for (const card of s.players[player].hand) {
    const ok = matchesFilter(card, filter, ctx.cards);
    if (ok === null) return null;
    if (ok) result.push(card.uid);
  }
  return result;
}

/** Exécute une instruction. Renvoie true si on attend un choix du joueur. */
function runStep(s: GameState, ctx: GameContext, step: EffectStep, events: GameEvent[]): boolean {
  const r = s.resolving!;
  const p = s.players[r.player];
  const opp = opponentOf(r.player);

  if (BOARD_STEPS.has(step.do)) {
    // Durées gérées ?
    if (["power_mod"].includes(step.do) && !["turn", "battle"].includes(step["duration"] as string)) {
      notImplemented(s, describeStep(step), events);
      return false;
    }
    if (
      ["lock_active", "negate_skills", "negate_one_keyword", "grant_keywords", "modify_energy_cost"].includes(step.do) &&
      !untilTurnFor(s, step["duration"])
    ) {
      notImplemented(s, describeStep(step), events);
      return false;
    }
    const target = step["target"];
    // « Cette carte » : la source, si elle est toujours en jeu (9-6-11 : sinon l'effet échoue).
    if (target === "this") {
      const self = findCandidate(s, r.source.uid);
      return self && self.zone !== "energy" ? applyChoice(s, ctx, step, [self.uid], events) : false;
    }
    // « La carte de Combat jouée » : celle dont la mise en jeu a ouvert la fenêtre de contre.
    if (target === "played_battle_card") {
      const event = s.counterWindow?.event;
      return event?.on === "play" ? applyChoice(s, ctx, step, [event.cardUid], events) : false;
    }
    // « La carte choisie » : mémorisée par une instruction précédente (`save_as`).
    if (typeof target === "string" && r.saved[target]) {
      const still = r.saved[target]!.filter((uid) => findCandidate(s, uid));
      return applyChoice(s, ctx, step, still, events);
    }
    if (!isObject(target)) {
      notImplemented(s, describeStep(step), events);
      return false;
    }
    // remove_markers : pas encore de Zone Unisson, donc aucune cible (5-2-6).
    if (step.do === "remove_markers") return false;
    let pool = candidates(s, ctx, target);
    if (pool === null) {
      notImplemented(s, describeStep(step), events);
      return false;
    }
    // On ne propose que les cartes que l'instruction change vraiment (0-2-4-1).
    if (step.do === "set_rest") pool = pool.filter((c) => modeHolder(s, c).mode === "active");
    if (step.do === "set_active") pool = pool.filter((c) => modeHolder(s, c).mode === "rest" && !readyBlockedByEffect(s, c.uid));
    if (step.do === "ko") pool = pool.filter((c) => c.zone === "battle");
    // 20-6 : « dont le total des coûts d'énergie est de X ou moins ».
    const maxTotal = typeof target["total_cost_at_most"] === "number" ? target["total_cost_at_most"] : undefined;
    if (maxTotal !== undefined) pool = pool.filter((c) => energyCostOf(ctx.cards.get(c.card?.cardId ?? "")) <= maxTotal);
    return askOrApply(s, ctx, step, r.player, pool.map((c) => c.uid), targetCount(target, pool.length), events, undefined, maxTotal);
  }

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

    case "discard":
    case "move_from_hand": {
      if (step.do === "move_from_hand" && step["to"] !== "warp") break;
      const options = handOptions(s, ctx, r.player, step["filter"]);
      if (options === null) break;
      return askOrApply(s, ctx, step, r.player, options, targetCount(step, options.length), events);
    }

    case "opponent_discards": {
      // L'adversaire choisit lui-même dans sa main.
      const options = handOptions(s, ctx, opp, step["filter"]);
      if (options === null) break;
      return askOrApply(s, ctx, step, opp, options, targetCount(step, options.length), events);
    }

    case "discard_from_opponent_hand": {
      // Vous choisissez à l'aveugle (positions) dans la main adverse.
      const { min, max } = targetCount(step, s.players[opp].hand.length);
      if (max === 0) return false;
      s.pending = {
        type: "CHOOSE_BLIND",
        player: r.player,
        owner: opp,
        min,
        max,
        prompt: `Choisissez ${min === 0 ? "jusqu'à " : ""}${max} carte(s) dans la main adverse (à l'aveugle) à défausser`,
      };
      return true;
    }

    case "look_top_deck": {
      // 20-12 : le joueur regarde les X cartes du dessus (lui seul), puis choisit selon `pick`.
      const pick = step["pick"];
      if (typeof step["count"] !== "number" || !isObject(pick) || pick["to"] !== "hand") break;
      const looked = p.deck.slice(0, step["count"]);
      const options: string[] = [];
      for (const card of looked) {
        const ok = matchesFilter(card, pick["filter"], ctx.cards);
        if (ok === null) {
          notImplemented(s, describeStep(step), events);
          return false;
        }
        if (ok) options.push(card.uid);
      }
      events.push({ type: "DECK_LOOKED", player: r.player, count: looked.length });
      const count = targetCount(pick, options.length);
      return askOrApply(s, ctx, step, r.player, options, count, events, looked.map((c) => ({ uid: c.uid, cardId: c.cardId })));
    }

    case "play_self": {
      // 5-5-3 : jouée via une Capacité, sans payer son coût d'Énergie.
      if (step["to"] !== undefined) break; // jouer chez l'adversaire : pas encore géré
      const from = step["from"] as "hand" | "drop";
      if (from !== "hand" && from !== "drop") break;
      const zone = s.players[r.player][from];
      const i = zone.findIndex((c) => c.uid === r.source.uid);
      if (i < 0) return false; // la carte n'est plus là : l'effet échoue (9-6-11)
      const card = zone[i]!;
      const via = typeof step["via"] === "string" ? step["via"] : undefined;
      const error = enterBattleArea(s, ctx, r.player, card, from, (step["mode"] as "rest" | undefined) ?? "active", events, via);
      if (error) events.push({ type: "NOT_IMPLEMENTED", player: r.player, cardId: card.cardId, what: error });
      return false;
    }

    case "optional": {
      // 20-16 : « Vous pouvez [coût]. Si vous le faites, [effet] » / sinon [else].
      const cost = (step["cost"] ?? []) as EffectStep[];
      if (!canPay(s, ctx, r.player, cost)) {
        insertSteps(s, (step["else"] ?? []) as EffectStep[]);
        return false;
      }
      s.pending = {
        type: "CHOOSE_OPTION",
        player: r.player,
        prompt: `Vous pouvez : ${cost.map(describeStep).join(", ")}`,
        options: [
          { id: "yes", label: "Oui" },
          { id: "no", label: "Non" },
        ],
      };
      return true;
    }

    case "if": {
      const check = step["check"];
      if (!isObject(check) || typeof check["card"] !== "string") break;
      const uids = r.saved[check["card"]] ?? [];
      const ok = uids.some((uid) => {
        const def = ctx.cards.get(cardIdOf(s, uid) ?? "");
        if (typeof check["has_trait"] === "string") return def?.traits.includes(check["has_trait"]) ?? false;
        return false;
      });
      if (ok) insertSteps(s, (step["then"] ?? []) as EffectStep[]);
      return false;
    }

    case "next_successor_discount": {
      // « La prochaine fois que vous activez la Capacité Successeur d'un <...> de votre main,
      // réduisez de (jaune)(1) son coût de Capacité » (pour ce tour).
      const reduce = (step["reduce"] ?? {}) as Json;
      s.successorDiscounts.push({
        player: r.player,
        filter: (step["filter"] ?? {}) as Json,
        colors: (reduce["specified"] ?? {}) as Record<string, number>,
        generic: (reduce["generic"] as number) ?? 0,
        untilTurn: s.turnNumber,
      });
      events.push({ type: "SUCCESSOR_DISCOUNT", player: r.player });
      return false;
    }

    case "negate_attack": {
      // 8-1-6-1 : l'attaque est annulée, le combat passe directement à sa fin.
      if (s.battle && !s.battle.negated) {
        s.battle.negated = true;
        events.push({ type: "ATTACK_NEGATED" });
      }
      return false;
    }

    case "limit_opponent_attacks": {
      // « Votre adversaire ne peut plus attaquer (avec ses cartes de Combat) que X fois ce tour. »
      if (step["duration"] !== "turn" || typeof step["remaining"] !== "number") break;
      const battleCardsOnly = step["with"] === "battle_cards";
      s.attackLimits.push({ player: opp, remaining: step["remaining"], battleCardsOnly, untilTurn: s.turnNumber });
      events.push({ type: "ATTACKS_LIMITED", player: opp, remaining: step["remaining"], battleCardsOnly });
      return false;
    }

    case "counter_window_play": {
      // Instruction interne : 22-10-3-1 — une Capacité qui joue une carte ouvre une fenêtre de
      // [Contre : Mise en jeu] avant de se résoudre.
      openCounterWindow(
        s,
        ctx,
        { on: "play", player: r.player, cardUid: r.source.uid, cardId: r.source.cardId },
        { kind: "run_resolution" },
        events,
      );
      return true;
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

/** Numéro de carte d'un uid, où qu'il soit. */
function cardIdOf(s: GameState, uid: string): string | undefined {
  for (const player of ["P1", "P2"] as const) {
    const p = s.players[player];
    if (p.leader.uid === uid) return p.leader.cardId;
    for (const zone of ["deck", "hand", "life", "energy", "battle", "combo", "drop", "zEnergy", "warp", "removed"] as const) {
      const card = p[zone].find((c) => c.uid === uid);
      if (card) return card.cardId;
    }
  }
  return undefined;
}

/** Insère des instructions juste après l'instruction en cours. */
function insertSteps(s: GameState, steps: EffectStep[]): void {
  const r = s.resolving!;
  r.steps.splice(r.index + 1, 0, ...steps);
}

/** Le joueur peut-il payer ce coût (« vous pouvez défausser une carte verte... ») ? */
function canPay(s: GameState, ctx: GameContext, player: PlayerId, cost: EffectStep[]): boolean {
  for (const c of cost) {
    if (c.do === "discard") {
      const options = handOptions(s, ctx, player, c["filter"]);
      if (!options || options.length < ((c["count"] as number) ?? 1)) return false;
    } else if (c.do === "life_to_hand") {
      if (s.players[player].life.length < ((c["count"] as number) ?? 1)) return false;
    }
  }
  return true;
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
  if (pending.maxTotalCost !== undefined) {
    const total = chosen.reduce((sum, uid) => sum + energyCostOf(ctx.cards.get(cardIdOf(s, uid) ?? "")), 0);
    if (total > pending.maxTotalCost) {
      return `20-6 : le total des coûts d'énergie choisis (${total}) dépasse ${pending.maxTotalCost}`;
    }
  }
  s.pending = null;
  const waiting = applyChoice(s, ctx, r.steps[r.index]!, chosen, events);
  if (waiting) return null;
  nextStep(s, ctx, events);
  return null;
}

/** Choisir des positions de cartes de Vie (CHOOSE_LIFE) ou de la main adverse (CHOOSE_BLIND). */
export function answerPositions(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_LIFE" | "CHOOSE_BLIND" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const pending = s.pending as Extract<PendingDecision, { type: "CHOOSE_LIFE" | "CHOOSE_BLIND" }>;
  const r = s.resolving;
  if (!r) return "aucun effet en cours de résolution";
  const owner = pending.type === "CHOOSE_BLIND" ? pending.owner : action.player;
  const zone = pending.type === "CHOOSE_BLIND" ? s.players[owner].hand : s.players[owner].life;
  const label = pending.type === "CHOOSE_BLIND" ? "carte de la main adverse" : "carte de Vie";
  const indices = action.indices;
  if (indices.length < pending.min || indices.length > pending.max) {
    return `choisissez entre ${pending.min} et ${pending.max} ${label}(s)`;
  }
  if (new Set(indices).size !== indices.length) return `une même ${label} est choisie deux fois`;
  if (!indices.every((i) => Number.isInteger(i) && i >= 0 && i < zone.length)) return `position de ${label} invalide`;
  const sorted = [...indices].sort((a, b) => a - b);
  const taken = [...sorted].reverse().map((i) => zone.splice(i, 1)[0]!).reverse();
  if (pending.type === "CHOOSE_LIFE") {
    const cardIds = taken.map((c) => (c.faceUp ? c.cardId : null));
    for (const c of taken) c.faceUp = false;
    s.players[owner].hand.push(...taken);
    if (taken.length > 0) events.push({ type: "LIFE_TO_HAND", player: owner, indices: sorted, cardIds });
  } else {
    // Défaussées : la Dispersion est publique, les cartes sont révélées.
    for (const c of taken) toDrop(s, c);
    if (taken.length > 0) events.push({ type: "CARDS_DISCARDED", player: owner, cardIds: taken.map((c) => c.cardId) });
  }
  nextStep(s, ctx, events);
  return null;
}

/** Choisir une option (CHOOSE_OPTION) : oui/non d'un « Vous pouvez », mot-clé à annuler... */
export function answerOption(
  s: GameState,
  action: Extract<Action, { type: "CHOOSE_OPTION" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const pending = s.pending as Extract<PendingDecision, { type: "CHOOSE_OPTION" }>;
  const r = s.resolving;
  if (!r) return "aucun effet en cours de résolution";
  if (!pending.options.some((o) => o.id === action.id)) return "cette option n'est pas proposée";
  const step = r.steps[r.index]!;
  s.pending = null;
  if (step.do === "optional") {
    const chosen = action.id === "yes" ? [...((step["cost"] ?? []) as EffectStep[]), ...((step["then"] ?? []) as EffectStep[])] : ((step["else"] ?? []) as EffectStep[]);
    insertSteps(s, chosen);
  } else if (step.do === "negate_one_keyword") {
    negateKeyword(s, step, r.memo.shift()!, action.id, events);
    if (askKeyword(s, ctx, step, events)) return null;
  }
  nextStep(s, ctx, events);
  return null;
}
