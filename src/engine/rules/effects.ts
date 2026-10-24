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
//   remove_markers            retirer des marqueurs d'une Unisson (21-9)
//   choose / set_power        « choisissez une carte » ; « la puissance de cette carte devient X »
//   set_revealed              passer une carte en mode Révélé (21-16)
//   combo_from                « utilisez une carte ... pour une Combo » (5-7-3-1 : sans coût de Combo)
//   create_token              créer des jetons (19)
//   if_previous_succeeded     « Si vous avez joué une carte ainsi, ... »
//   opponent_attack_tax       « votre adversaire ne peut pas attaquer à moins de ... à chaque fois »
//   self_restriction          « vous ne pouvez pas ... » (restriction en cours)
//   delayed                   effet retardé « quand une carte de Combat adverse est mise KO via le combat »
//   optional_at_battle_end    « vous pouvez [coût] à la fin du combat. Si vous le faites, ... »
//   replacement               pioches adverses remplacées (Oolong, Désir immédiat)
//   move_under                placer sous une carte nommée (rien si la carte n'est pas en jeu)
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
import { continueWith, queueTriggers } from "./autos";
import { drawCards, shuffleDeck } from "./basic";
import { checkCondition, energyCostOf, matchesFilter, matchesSpec } from "./conditions";
import { openCounterWindow } from "./counters";
import { checkDefeat } from "./defeat";
import { hasBarrier, keywordsOf, readyBlockedByEffect, removeIfUltimate } from "./keywords";
import { leaderFace } from "./leader";
import { enterBattleArea } from "./play";
import { powerOf } from "./battle";
import { removeLeaderZ } from "./zdeck";
import { forgetCard, koBattleCard, leaveUnison, removeMarkers } from "./zones";
import { abilitiesOf } from "../cards/abilities";

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
    case "opponent_next_turn":
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

type BoardZone = "leader" | "battle" | "energy" | "combo" | "unison";

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

/**
 * Cartes qui correspondent à une description de cible ; null si la description n'est pas gérée.
 * 22-16 [Barrière] : une carte adverse avec Barrière ne peut pas être choisie, sauf « en ignorant
 * la Capacité Barrière ». `any_of` : « parmi ... , ... et ... » (plusieurs descriptions réunies).
 */
function candidates(s: GameState, ctx: GameContext, target: Json): Candidate[] | null {
  const r = s.resolving!;
  if (Array.isArray(target["any_of"])) {
    const all: Candidate[] = [];
    for (const sub of target["any_of"] as Json[]) {
      const found = candidates(s, ctx, sub);
      if (found === null) return null;
      for (const c of found) if (!all.some((x) => x.uid === c.uid)) all.push(c);
    }
    return all;
  }
  const owners: PlayerId[] =
    target["owner"] === "opponent" ? [opponentOf(r.player)] : target["owner"] === "any" ? [r.player, opponentOf(r.player)] : [r.player];
  const zones = (Array.isArray(target["zone"]) ? target["zone"] : [target["zone"]]) as string[];
  const result: Candidate[] = [];
  const blocked = (player: PlayerId, uid: string) => player !== r.player && target["ignore_barrier"] !== true && hasBarrier(s, uid, ctx.cards);
  for (const player of owners) {
    const p = s.players[player];
    for (const zone of zones) {
      if (zone === "leader") {
        const ok = leaderMatches(s, player, target, ctx);
        if (ok === null) return null;
        if (ok && !blocked(player, p.leader.uid)) result.push({ uid: p.leader.uid, player, zone: "leader" });
      } else if (zone === "battle" || zone === "energy" || zone === "combo" || zone === "unison") {
        for (const card of p[zone]) {
          // « carte de Combat » : pas les Extras Z posées dans la Zone de Combat.
          if (zone === "battle" && !["battle", "z_battle"].includes(ctx.cards.get(card.cardId)?.type ?? "")) continue;
          const ok = matchesSpec(card, target, ctx.cards, s);
          if (ok === null) return null;
          if (ok && !blocked(player, card.uid)) result.push({ uid: card.uid, player, zone, card });
        }
      } else {
        return null;
      }
    }
  }
  return result;
}

/** Le Leader (sa face visible, ou le Leader Z) correspond-il à la description ? */
function leaderMatches(s: GameState, player: PlayerId, target: Json, ctx: GameContext): boolean | null {
  if (!target["filter"] && !target["filter_any"]) return true;
  const leader = s.players[player].leader;
  const id = leader.z?.cardId ?? leader.cardId;
  const def = ctx.cards.get(id);
  const face = leaderFace(leader, ctx.cards);
  if (!def || !face) return false;
  const db = new Map([[id, { ...def, ...face }]]);
  return matchesSpec({ uid: leader.uid, cardId: id, owner: player, mode: leader.mode, faceUp: true }, target, db, s);
}

function findCandidate(s: GameState, uid: string): Candidate | null {
  for (const player of ["P1", "P2"] as const) {
    const p = s.players[player];
    if (p.leader.uid === uid) return { uid, player, zone: "leader" };
    for (const zone of ["battle", "energy", "combo", "unison"] as const) {
      const card = p[zone].find((c) => c.uid === uid);
      if (card) return { uid, player, zone, card };
    }
  }
  return null;
}

/** Nombre de cibles : « jusqu'à N » => 0..N (5-2-4) ; « N » => autant que possible jusqu'à N (5-2-3). */
function targetCount(spec: Json, available: number): { min: number; max: number } {
  // « Choisissez n'importe quel nombre de cartes » : de 0 à toutes. « Choisissez toutes les ... ».
  if (spec["any_number"] === true) return { min: 0, max: available };
  if (spec["all"] === true) return { min: available, max: available };
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
  choose: "",
  combo_from: "à utiliser pour une Combo (Capacités annulées pour le tour)",
  move_to_deck_top: "de la Dispersion adverse à placer sur le dessus de son deck",
};

/** « à jouer depuis votre Dispersion : <Vegeta (GT)> » : dit quelle carte est attendue. */
function playFromPrompt(step: EffectStep): string {
  if (step.do !== "play_from") return "";
  const zones: Record<string, string> = { drop: "votre Dispersion", deck: "votre deck", hand: "votre main" };
  const filter = (step["filter"] ?? {}) as Json;
  const character = typeof filter["character"] === "string" ? ` : <${filter["character"]}>` : "";
  return `à jouer depuis ${zones[String(step["zone"])] ?? ""}${character}`;
}

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
  // 5-2-6 : aucune cible possible => l'instruction est ignorée (et « la carte choisie » n'existe pas).
  if (count.max === 0 && !looked) {
    if (typeof step["save_as"] === "string") s.resolving!.saved[step["save_as"]] = [];
    return false;
  }
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
    prompt: `${what} carte(s) ${PROMPTS[step.do] ?? playFromPrompt(step)}${
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
      for (const c of chosen) if (c.zone === "battle") koBattleCard(s, ctx, c.player, c.card!, events, r.player);
      return false;
    case "power_mod": {
      const until = step["duration"] as "turn" | "battle";
      for (const c of chosen) {
        s.powerMods.push({ uid: c.uid, amount: step["amount"] as number, until, by: r.player });
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
    case "remove_markers": {
      // 21-9 : retirer des marqueurs d'une Unisson (à 0, elle quitte la Zone Unisson).
      const n = typeof step["count"] === "number" ? step["count"] : step["count"] === "X" ? (r.x ?? 0) : 1;
      for (const c of chosen) if (c.zone === "unison") removeMarkers(s, ctx, c.player, c.card!, n, events);
      return false;
    }
    case "z_energy_to_drop": {
      // Placer des Énergies Z dans sa Dispersion (coût ou effet).
      const p = s.players[r.player];
      const cards = uids.map((uid) => p.zEnergy.find((c) => c.uid === uid)).filter((c): c is CardInstance => c !== undefined);
      for (const c of cards) {
        p.zEnergy.splice(p.zEnergy.indexOf(c), 1);
        s.players[c.owner].drop.push(c);
      }
      if (cards.length > 0) events.push({ type: "Z_ENERGY_PAID", player: r.player, cardIds: cards.map((c) => c.cardId) });
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
        forgetCard(s, c.uid);
        events.push({ type: "CARD_TO_DROP", player: c.player, uid: c.uid, cardId: c.card.cardId, from: c.zone });
        // 14-1-4 / 22-14-3 / 19-1-7 : carte Z, [Ultimate] ou jeton => retiré de la partie à la place.
        if (c.zone !== "energy" && removeIfUltimate(s, c.card, ctx.cards)) {
          events.push({ type: "CARD_REMOVED", player: c.player, uid: c.uid, cardId: c.card.cardId });
        } else {
          toDrop(s, c.card);
        }
        if (c.zone === "battle") queueTriggers(s, { event: "leaves_battle", card: c.card, bySkillOf: r.player, toDrop: true }, ctx, events);
      }
      return false;
    }
    case "choose":
      // « Choisissez une carte » : seulement mémorisée (save_as) pour les instructions suivantes.
      return false;
    case "play_from": {
      const p = s.players[r.player];
      const from = step["zone"] as "drop" | "deck" | "hand";
      for (const uid of uids) {
        const card = p[from].find((c) => c.uid === uid);
        if (!card) continue;
        const mode = (step["mode"] as "rest" | undefined) ?? "active";
        // « jouez-les avec leurs Capacités annulées pour tout le tour » : annulées avant leur arrivée,
        // donc leurs [Auto.] « quand cette carte est jouée » ne se déclenchent pas.
        if (step["negate_skills"] === "turn") {
          s.effects.push({ uid, kind: "negate_all", untilTurn: s.turnNumber });
          events.push({ type: "SKILLS_NEGATED", uids: [uid] });
        }
        if (ctx.cards.get(card.cardId)?.type === "unison") {
          // Unisson jouée par un effet : avec le nombre de marqueurs indiqué (une seule à la fois, 3-11-4).
          p[from].splice(p[from].indexOf(card), 1);
          for (const other of [...p.unison]) leaveUnison(s, ctx, r.player, other, events);
          card.faceUp = true;
          card.mode = mode;
          card.markers = (step["markers"] as number) ?? 0;
          p.unison.push(card);
          s.playedFrom[card.uid] = from;
          events.push({ type: "UNISON_PLAYED", player: r.player, uid: card.uid, cardId: card.cardId, markers: card.markers });
          queueTriggers(s, { event: "played", card }, ctx, events);
        } else {
          const error = enterBattleArea(s, ctx, r.player, card, from, mode, events);
          if (error) events.push({ type: "NOT_IMPLEMENTED", player: r.player, cardId: card.cardId, what: error });
        }
      }
      if (from === "deck" && step["then"] === "shuffle_deck") shuffleDeck(s, r.player, events);
      return false;
    }
    case "drop_to_warp": {
      const p = s.players[r.player];
      const moved = uids.map((uid) => p.drop.find((c) => c.uid === uid)).filter((c): c is CardInstance => c !== undefined);
      for (const c of moved) {
        p.drop.splice(p.drop.indexOf(c), 1);
        s.players[c.owner].warp.push(c);
      }
      if (moved.length > 0) events.push({ type: "CARDS_TO_WARP", player: r.player, cardIds: moved.map((c) => c.cardId) });
      return false;
    }
    case "hand_to_deck_bottom":
    case "hand_to_z_energy": {
      const p = s.players[r.player];
      const cards = uids.map((uid) => takeFromHand(s, r.player, uid)).filter((c): c is CardInstance => c !== null);
      for (const c of cards) {
        c.mode = "active";
        if (step.do === "hand_to_deck_bottom") {
          c.faceUp = false;
          p.deck.push(c);
        } else {
          c.faceUp = true;
          p.zEnergy.push(c);
        }
      }
      if (cards.length > 0) {
        events.push({
          type: "EFFECT_NOTE",
          player: r.player,
          cardId: r.source.cardId,
          text:
            step.do === "hand_to_deck_bottom"
              ? `${cards.length} carte(s) de la main placée(s) au-dessous du deck`
              : `${cards.map((c) => ctx.cards.get(c.cardId)?.name ?? c.cardId).join(", ")} rajoutée(s) aux Énergies Z`,
        });
      }
      return false;
    }
    case "activate_from_hand": {
      const p = s.players[r.player];
      for (const uid of uids) {
        const card = takeFromHand(s, r.player, uid);
        if (!card) continue;
        const found = mainAbilityOf(ctx, card.cardId)!;
        toDrop(s, card);
        events.push({ type: "ABILITY_ACTIVATED", player: r.player, uid: card.uid, cardId: card.cardId, index: found.index, text: String(found.ability["text"] ?? "") });
        const limit = (found.ability["limits"] ?? {}) as Json;
        if (typeof limit["limit"] === "number") {
          const key = `limit:${r.player}:${card.cardId}#${found.index}`;
          s.turnUsage[key] = (s.turnUsage[key] ?? 0) + 1;
        }
        void p;
        insertSteps(s, (found.ability["effect"] ?? []) as EffectStep[]);
      }
      return false;
    }
    case "set_power": {
      // « La puissance de cette carte devient la puissance de la carte choisie » (puissance actuelle).
      const value = r.memo.length > 0 ? Number(r.memo[0]) : 0;
      for (const c of chosen) {
        s.effects.push({ uid: c.uid, kind: "set_power", value, untilTurn: s.turnNumber });
        events.push({ type: "POWER_SET", uid: c.uid, value });
      }
      r.memo = [];
      return false;
    }
    case "combo_from": {
      // 5-7-3-1 : Combo via une Capacité, sans payer le coût de Combo ; ses Capacités sont annulées.
      const p = s.players[r.player];
      const from = step["zone"] as "hand" | "drop";
      for (const uid of uids) {
        const zone = p[from];
        const i = zone.findIndex((c) => c.uid === uid);
        if (i < 0) continue;
        const card = zone.splice(i, 1)[0]!;
        card.mode = "active";
        card.faceUp = true;
        p.combo.push(card);
        if (step["negate_skills"] === "turn") s.effects.push({ uid, kind: "negate_all", untilTurn: s.turnNumber });
        events.push({ type: "COMBO", player: r.player, uid, cardId: card.cardId, from, energyRested: [], markersUsed: 0 });
        queueTriggers(s, { event: "used_in_combo", card }, ctx, events);
      }
      return false;
    }
    case "move_to_deck_top": {
      // Carte(s) de la Dispersion d'un joueur placée(s) sur le dessus du deck de son propriétaire.
      const owner = (step["from_player"] as PlayerId | undefined) ?? opponentOf(r.player);
      const drop = s.players[owner].drop;
      for (const uid of uids) {
        const i = drop.findIndex((c) => c.uid === uid);
        if (i < 0) continue;
        const card = drop.splice(i, 1)[0]!;
        card.faceUp = false;
        s.players[card.owner].deck.unshift(card);
        events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: `${ctx.cards.get(card.cardId)?.name ?? card.cardId} est placée sur le dessus du deck de ${card.owner}` });
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
      // Les cartes choisies vont en main (révélées, 3-1-7), puis le deck est mélangé.
      const p = s.players[r.player];
      const pick = step["pick"] as Json;
      const taken = uids.map((uid) => p.deck.splice(p.deck.findIndex((c) => c.uid === uid), 1)[0]!);
      p.hand.push(...taken);
      if (taken.length > 0) {
        events.push({
          type: "CARDS_TO_HAND",
          player: r.player,
          from: "deck",
          // 3-1-7 : une carte indiquée (avec un critère) qui passe du deck à la main est révélée à
          // tous les joueurs, même si le texte ne le précise pas.
          cardIds: pick["reveal"] || pick["filter"] || pick["filter_any"] ? taken.map((c) => c.cardId) : taken.map(() => null),
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
  "choose",
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
    // « Votre carte en combat ».
    if (target === "own_card_in_battle") {
      const battle = s.battle;
      if (!battle) return false;
      const ref = battle.attacker.player === r.player ? battle.attacker : battle.defender.player === r.player ? battle.defender : null;
      return ref && findCandidate(s, ref.uid) ? applyChoice(s, ctx, step, [ref.uid], events) : false;
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
    let pool = candidates(s, ctx, target);
    if (pool === null) {
      notImplemented(s, describeStep(step), events);
      return false;
    }
    // On ne propose que les cartes que l'instruction change vraiment (0-2-4-1).
    if (step.do === "set_rest") pool = pool.filter((c) => modeHolder(s, c).mode === "active");
    if (step.do === "set_active") pool = pool.filter((c) => modeHolder(s, c).mode === "rest" && !readyBlockedByEffect(s, c.uid));
    if (step.do === "ko") pool = pool.filter((c) => c.zone === "battle");
    // Cartes exclues (ex. la carte attaquante, pour payer une taxe d'attaque).
    if (Array.isArray(step["exclude"])) pool = pool.filter((c) => !(step["exclude"] as string[]).includes(c.uid));
    // 20-6 : « dont le total des coûts d'énergie est de X ou moins ».
    const maxTotal = typeof target["total_cost_at_most"] === "number" ? target["total_cost_at_most"] : undefined;
    if (maxTotal !== undefined) pool = pool.filter((c) => energyCostOf(ctx.cards.get(c.card?.cardId ?? "")) <= maxTotal);
    return askOrApply(s, ctx, step, r.player, pool.map((c) => c.uid), targetCount(target, pool.length), events, undefined, maxTotal);
  }

  switch (step.do) {
    case "draw": {
      if (typeof step["count"] !== "number") break;
      // Pioche remplacée (Oolong, Désir immédiat) : seulement via la Capacité d'une carte autre que Leader.
      const sourceType = ctx.cards.get(r.source.cardId)?.type;
      const replacement = s.drawReplacements.find(
        (d) => d.against === r.player && d.fromTurn <= s.turnNumber && s.turnNumber <= d.untilTurn,
      );
      if (replacement && sourceType !== "leader" && sourceType !== "z_leader") {
        events.push({
          type: "EFFECT_NOTE",
          player: replacement.player,
          cardId: replacement.source.cardId,
          text: `${step["count"]} pioche(s) de ${r.player} remplacée(s)`,
        });
        const replaced: EffectStep[] = [];
        for (let i = 0; i < step["count"]; i++) {
          for (const st of replacement.steps) replaced.push({ ...st, chooser: replacement.player, from_player: replacement.against });
        }
        insertSteps(s, replaced);
        return false;
      }
      drawCards(s, r.player, step["count"], events);
      return false;
    }

    case "move_to_deck_top": {
      // « Placez jusqu'à une carte de Combat depuis sa Dispersion sur le dessus du deck de son propriétaire. »
      const target = step["target"];
      if (!isObject(target) || target["zone"] !== "drop") break;
      const chooser = (step["chooser"] as PlayerId | undefined) ?? r.player;
      const owner = (step["from_player"] as PlayerId | undefined) ?? (target["owner"] === "self" ? r.player : opp);
      const options: string[] = [];
      for (const card of s.players[owner].drop) {
        const ok = matchesFilter(card, target["filter"], ctx.cards, s);
        if (ok === null) break;
        if (ok) options.push(card.uid);
      }
      const fixed = { ...step, from_player: owner };
      r.steps[r.index] = fixed;
      return askOrApply(s, ctx, fixed, chooser, options, targetCount(target, options.length), events);
    }

    case "set_power": {
      // « La puissance de cette carte devient ... » ; « au début du tour adverse, elle devient
      // 4000 » = retour à la puissance imprimée (la valeur cesse au début du tour adverse).
      if (step["target"] !== "this") break;
      const value = step["value"];
      if (step["from"] !== undefined) {
        if (typeof value === "number" && value === ctx.cards.get(r.source.cardId)?.power) return false;
        break;
      }
      let amount: number | null = typeof value === "number" ? value : null;
      if (isObject(value) && typeof value["power_of"] === "string") {
        const uid = r.saved[value["power_of"]]?.[0];
        const found = uid ? findCandidate(s, uid) : null;
        // Aucune carte choisie (« jusqu'à une ») : la puissance ne change pas.
        if (!found) return false;
        amount = powerOf(s, { player: found.player, uid: found.uid }, ctx);
      }
      if (amount === null) break;
      const self = findCandidate(s, r.source.uid);
      if (!self || self.zone === "energy") return false;
      r.memo = [String(amount)];
      return applyChoice(s, ctx, step, [self.uid], events);
    }

    case "set_revealed": {
      // 1-10-2 / 21-16 : passer une carte en mode Révélé. Seules les cartes en mode Caché changent ;
      // aucune carte de ce simulateur ne se joue encore en mode Caché, donc rien ne change.
      events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: "aucune carte en mode Caché : rien ne change" });
      return false;
    }

    case "combo_from": {
      // « Utilisez jusqu'à une carte ... depuis votre main / Dispersion pour une Combo » (5-7-3-1).
      const zone = step["zone"];
      if ((zone !== "hand" && zone !== "drop") || !s.battle) break;
      const options: string[] = [];
      for (const card of p[zone]) {
        const def = ctx.cards.get(card.cardId);
        // 5-7-2 : coût et puissance de Combo non négatifs, carte de Combat.
        if (def?.type !== "battle" || !def.combo || def.combo.cost < 0 || def.combo.power < 0) continue;
        const ok = matchesFilter(card, step["filter"], ctx.cards, s);
        if (ok === null) {
          notImplemented(s, describeStep(step), events);
          return false;
        }
        if (ok) options.push(card.uid);
      }
      return askOrApply(s, ctx, step, r.player, options, targetCount(step, options.length), events);
    }

    case "create_token": {
      // 19-1-3 : le jeton est mis en jeu dans la Zone de Combat du maître de l'effet.
      const tokenId = step["token_id"];
      if (typeof tokenId !== "string" || !ctx.cards.get(tokenId)) break;
      const n = typeof step["count"] === "number" ? step["count"] : 1;
      const created: string[] = [];
      for (let i = 0; i < n; i++) {
        const card: CardInstance = { uid: `${r.player}-J${s.nextTokenId++}`, cardId: tokenId, owner: r.player, mode: "active", faceUp: true };
        p.battle.push(card);
        created.push(card.uid);
        events.push({ type: "TOKEN_CREATED", player: r.player, uid: card.uid, cardId: tokenId });
        queueTriggers(s, { event: "played", card }, ctx, events);
      }
      const granted = step["grant_keywords"];
      if (Array.isArray(granted) && granted.length > 0) {
        const d = untilTurnFor(s, step["grant_duration"] ?? "turn");
        if (!d) break;
        for (const keyword of granted as string[]) {
          addEffects(s, created, (uid) => ({ uid, kind: "grant_keyword", keyword, untilTurn: d.untilTurn }));
        }
        events.push({ type: "KEYWORDS_GRANTED", uids: created, keywords: [...(granted as string[])] });
      }
      // 22-10-3-1 / 4-3-2-4 : un jeton est « joué » (décision du joueur) : l'adversaire reçoit une
      // fenêtre de [Contre : Mise en jeu] (pas pendant une fenêtre déjà en cours, 4-3-2-7).
      const last = created[created.length - 1];
      if (last && !s.counterWindow) {
        openCounterWindow(s, ctx, { on: "play", player: r.player, cardUid: last, cardId: tokenId }, { kind: "run_resolution" }, events);
        return true;
      }
      return false;
    }

    case "if_previous_succeeded": {
      // « Si vous avez joué une carte ainsi, ... »
      if (r.saved["__played"]?.length) insertSteps(s, (step["then"] ?? []) as EffectStep[]);
      return false;
    }

    case "opponent_attack_tax": {
      const rule = step["rule"];
      if (rule !== "discard_2_per_attack" && rule !== "rest_one_active_card_per_attack" && rule !== "hand_to_z_energy_per_attack") break;
      const d = untilTurnFor(s, step["duration"]);
      if (!d) break;
      s.attackTaxes.push({ player: opp, rule, untilTurn: d.untilTurn });
      events.push({
        type: "EFFECT_NOTE",
        player: r.player,
        cardId: r.source.cardId,
        text:
          rule === "discard_2_per_attack"
            ? `${opp} doit défausser deux cartes de sa main à chaque attaque`
            : rule === "hand_to_z_energy_per_attack"
              ? `${opp} doit rajouter une carte de sa main à ses Énergies Z à chaque attaque`
              : `${opp} doit passer une de ses cartes en mode Action en mode Inertie à chaque attaque`,
      });
      return false;
    }

    case "self_restriction": {
      // « Vous ne pouvez pas ... » : la restriction s'applique à son maître.
      const myTurn = s.turnPlayer === r.player;
      if (step["rule"] === "cannot_activate_other_counter_play" && step["duration"] === "turn") {
        s.restrictions.push({ player: r.player, rule: "no_other_counter_play", uid: r.source.uid, fromTurn: s.turnNumber, untilTurn: s.turnNumber });
        events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: "plus de [Contre : Mise en jeu] d'autres cartes ce tour" });
        return false;
      }
      if (step["rule"] === "cannot_activate_copies_of_this_card" && step["duration"] === "your_next_turn") {
        const turn = s.turnNumber + (myTurn ? 2 : 1);
        s.restrictions.push({ player: r.player, rule: "no_activate_copies", cardId: r.source.cardId, fromTurn: turn, untilTurn: turn });
        events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: "les exemplaires de cette carte ne pourront pas activer leurs Capacités pendant votre tour suivant" });
        return false;
      }
      break;
    }

    case "delayed": {
      // « Quand une carte de Combat adverse est mise KO via le combat, ... » (pendant ce combat).
      const when = step["when"];
      if (!isObject(when) || when["event"] !== "opponent_battle_card_ko_by_battle" || step["duration"] !== "battle" || !s.battle) break;
      s.delayed.push({
        player: r.player,
        source: { ...r.source },
        event: "opponent_battle_card_ko_by_battle",
        steps: (step["then"] ?? []) as EffectStep[],
        battleOnly: true,
        untilTurn: s.turnNumber,
      });
      return false;
    }

    case "optional_at_battle_end": {
      // « Vous pouvez [coût] à la fin du combat. Si vous le faites, [effet]. »
      if (!s.battle) return false;
      s.battle.pendingAutos.push({
        kind: "steps",
        player: r.player,
        source: { ...r.source },
        steps: [{ do: "optional", cost: step["cost"] ?? [], then: step["then"] ?? [] }],
      });
      return false;
    }

    case "replacement": {
      const when = step["when"];
      if (!isObject(when) || when["event"] !== "opponent_draws_by_non_leader_skill" || step["duration"] !== "opponent_next_turn") break;
      const turn = s.turnNumber + (s.turnPlayer === r.player ? 1 : 2);
      s.drawReplacements.push({
        player: r.player,
        against: opp,
        source: { ...r.source },
        steps: (step["instead"] ?? []) as EffectStep[],
        fromTurn: turn,
        untilTurn: turn,
      });
      events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: `pendant le tour suivant de ${opp}, ses pioches via des Capacités autres que Leader seront remplacées` });
      return false;
    }

    case "move_under": {
      // « Placez ... sous un {Nom} dans votre Zone de Combat » : sans cette carte en jeu, rien ne se passe.
      const under = step["under"];
      const name = isObject(under) ? under["name"] : undefined;
      const present = p.battle.some((c) => ctx.cards.get(c.cardId)?.name === name);
      if (present) break;
      events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: `pas de {${String(name)}} dans votre Zone de Combat : rien n'est placé dessous` });
      return false;
    }

    case "move_self": {
      // Coût « Placez cette carte dans la Dispersion de son propriétaire depuis votre Zone de Combo ».
      if (step["from"] !== "combo" || step["to"] !== "drop") break;
      const i = p.combo.findIndex((c) => c.uid === r.source.uid);
      if (i >= 0) {
        const card = p.combo.splice(i, 1)[0]!;
        toDrop(s, card);
        events.push({ type: "CARD_TO_DROP", player: r.player, uid: card.uid, cardId: card.cardId, from: "combo" });
      }
      return false;
    }

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
        const ok = matchesSpec(card, pick, ctx.cards);
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
      // « dans la Zone de Combat adverse » : la carte reste à son propriétaire, son maître devient
      // l'adversaire (0-3-3 / 0-3-4-1).
      if (step["to"] !== undefined && step["to"] !== "opponent_battle_area") break;
      const into = step["to"] === "opponent_battle_area" ? opp : r.player;
      const from = step["from"] as "hand" | "drop";
      if (from !== "hand" && from !== "drop") break;
      const zone = s.players[r.player][from];
      const i = zone.findIndex((c) => c.uid === r.source.uid);
      if (i < 0) return false; // la carte n'est plus là : l'effet échoue (9-6-11)
      const card = zone[i]!;
      const via = typeof step["via"] === "string" ? step["via"] : undefined;
      const error = enterBattleArea(s, ctx, r.player, card, from, (step["mode"] as "rest" | undefined) ?? "active", events, via, into);
      if (error) events.push({ type: "NOT_IMPLEMENTED", player: r.player, cardId: card.cardId, what: error });
      else r.saved["__played"] = [card.uid];
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
      // « Si cette carte a été jouée depuis une Dispersion », « si c'est votre tour », « quand votre
      // total de points de vie est de 4 ou moins ».
      if (isObject(check) && typeof check["card"] !== "string") {
        let ok = true;
        for (const [key, value] of Object.entries(check)) {
          if (key === "played_from") ok &&= s.playedFrom[r.source.uid] === value;
          else if (key === "your_turn") ok &&= (s.turnPlayer === r.player) === value;
          else if (key === "life_at_most") ok &&= p.life.length <= (value as number);
          else {
            notImplemented(s, describeStep(step), events);
            return false;
          }
        }
        if (ok) insertSteps(s, (step["then"] ?? []) as EffectStep[]);
        return false;
      }
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

    case "spirit_boost": {
      // 22-43 [Boost d'Esprit X] (coût) : retirer X marqueurs de son Unisson.
      const unison = p.unison[0];
      if (unison) removeMarkers(s, ctx, r.player, unison, (step["markers"] as number) ?? 1, events);
      return false;
    }

    case "z_energy_to_drop": {
      // Choisir des Énergies Z de sa Zone d'Énergie Z (5-4 : couleur sans importance).
      const options = p.zEnergy.map((c) => c.uid);
      const n = typeof step["count"] === "number" ? step["count"] : 1;
      return askOrApply(s, ctx, step, r.player, options, { min: Math.min(n, options.length), max: Math.min(n, options.length) }, events);
    }

    case "remove_from_game": {
      if (step["target"] !== "this") break;
      // « Retirez cette carte de la partie » : Leader Z posé sur le Leader (15-1-5), ou carte
      // de la Zone de Combat (ex. Extra Z).
      if (p.leader.z && (p.leader.z.uid === r.source.uid || p.leader.uid === r.source.uid)) {
        removeLeaderZ(s, r.player, events);
        return false;
      }
      const card = p.battle.find((c) => c.uid === r.source.uid);
      if (card) {
        p.battle.splice(p.battle.indexOf(card), 1);
        forgetCard(s, card.uid);
        card.faceUp = true;
        card.mode = "active";
        s.players[card.owner].removed.push(card);
        events.push({ type: "CARD_REMOVED", player: r.player, uid: card.uid, cardId: card.cardId });
      }
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

    case "play_from": {
      // « Jouez jusqu'à une carte ... depuis votre Dispersion / votre deck » (5-5-3).
      const zone = step["zone"];
      if (zone !== "drop" && zone !== "deck" && zone !== "hand") break;
      const options: string[] = [];
      for (const card of p[zone]) {
        const type = ctx.cards.get(card.cardId)?.type;
        if (type !== "battle" && type !== "unison") continue;
        const ok = matchesSpec(card, step, ctx.cards, s);
        if (ok === null) {
          notImplemented(s, describeStep(step), events);
          return false;
        }
        if (ok) options.push(card.uid);
      }
      if (zone === "deck") events.push({ type: "DECK_LOOKED", player: r.player, count: p.deck.length });
      const looked = zone === "deck" ? p.deck.filter((c) => options.includes(c.uid)).map((c) => ({ uid: c.uid, cardId: c.cardId })) : undefined;
      const waiting = askOrApply(s, ctx, step, r.player, options, targetCount(step, options.length), events, looked && looked.length > 0 ? looked : undefined);
      // Rien à jouer : on mélange quand même le deck si on y a cherché.
      if (!waiting && options.length === 0 && zone === "deck" && step["then"] === "shuffle_deck") shuffleDeck(s, r.player, events);
      return waiting;
    }

    case "drop_to_warp": {
      // « Choisissez une carte verte et une carte jaune dans votre Dispersion et transférez-les dans
      // votre Dimension parallèle » : toutes choisies en même temps, une par description (`filters`).
      const filters = (step["filters"] ?? [step["filter"] ?? {}]) as Json[];
      const options = p.drop.filter((c) => filters.some((f) => matchesFilter(c, f, ctx.cards, s) === true)).map((c) => c.uid);
      const n = filters.length;
      if (options.length < n) return false;
      s.pending = {
        type: "CHOOSE_CARDS",
        player: r.player,
        min: n,
        max: n,
        options,
        prompt: n > 1 ? `Choisissez ${n} cartes de votre Dispersion à transférer dans votre Dimension parallèle (une de chaque : ${describeFilters(filters)})` : "Choisissez 1 carte de votre Dispersion à transférer dans votre Dimension parallèle",
        ...(n > 1 ? { matchEach: filters } : {}),
      };
      return true;
    }

    case "negate_own_energy_exhaust": {
      // La Fuite d'énergie de cette carte est annulée : elle est placée en mode Action.
      const card = p.energy.find((c) => c.uid === r.source.uid);
      if (card && card.mode === "rest") {
        card.mode = "active";
        events.push({ type: "CARDS_MODE_CHANGED", uids: [card.uid], mode: "active" });
      }
      return false;
    }

    case "life_to_hand_until": {
      // « Rajoutez à votre main des cartes de vos points de vie jusqu'à avoir N points de vie. »
      const n = p.life.length - (step["value"] as number);
      if (n <= 0) return false;
      s.pending = { type: "CHOOSE_LIFE", player: r.player, min: n, max: n, prompt: `Rajoutez à votre main ${n} carte(s) de vos points de vie` };
      return true;
    }

    case "opponent_life_to_drop": {
      // « Votre adversaire place une carte de ses points de vie dans sa Dispersion » (il choisit).
      const n = Math.min((step["count"] as number) ?? 1, s.players[opp].life.length);
      if (n <= 0) return false;
      s.pending = { type: "CHOOSE_LIFE", player: opp, min: n, max: n, prompt: `Placez ${n} carte(s) de vos points de vie dans votre Dispersion`, to: "drop" };
      return true;
    }

    case "deal_damage": {
      // « Infligez 1 dégât à votre adversaire » (21-3) : il choisit ses cartes de Vie.
      const n = (step["count"] as number) ?? 1;
      if (s.players[opp].life.length === 0 || n <= 0) return false;
      events.push({ type: "DAMAGE_DEALT", player: opp, amount: n, critical: false });
      s.pending = { type: "TAKE_DAMAGE", player: opp, amount: n, critical: false, fromEffect: true };
      return true;
    }

    case "choose_one": {
      // « Choisissez l'un — » : le joueur choisit une des options.
      const options = (step["options"] ?? []) as Json[];
      s.pending = {
        type: "CHOOSE_OPTION",
        player: r.player,
        prompt: "Choisissez l'un",
        options: options.map((o, i) => ({ id: String(i), label: String(o["label"] ?? `Option ${i + 1}`) })),
      };
      return true;
    }

    case "keep_one_each_bottom_rest": {
      // Polunga : garder une de vos cartes de Combat et une adverse (en ignorant Barrière), les
      // autres cartes de Combat vont au-dessous du deck de leur propriétaire.
      insertSteps(s, [
        { do: "choose", target: { owner: "self", zone: "battle", count: 1 }, save_as: "__keep_self" },
        { do: "choose", target: { owner: "opponent", zone: "battle", count: 1, ignore_barrier: true }, save_as: "__keep_opp" },
        { do: "bottom_others" },
      ]);
      return false;
    }

    case "bottom_others": {
      const keep = new Set([...(r.saved["__keep_self"] ?? []), ...(r.saved["__keep_opp"] ?? [])]);
      for (const player of [r.player, opp]) {
        const zone = s.players[player].battle;
        for (const card of [...zone]) {
          const type = ctx.cards.get(card.cardId)?.type;
          if (keep.has(card.uid) || (type !== "battle" && type !== "z_battle")) continue;
          zone.splice(zone.indexOf(card), 1);
          forgetCard(s, card.uid);
          if (removeIfUltimate(s, card, ctx.cards)) {
            events.push({ type: "CARD_REMOVED", player, uid: card.uid, cardId: card.cardId });
            continue;
          }
          card.mode = "active";
          card.faceUp = false;
          s.players[card.owner].deck.push(card);
          events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: `${ctx.cards.get(card.cardId)?.name ?? card.cardId} est placée au-dessous du deck de ${card.owner}` });
          queueTriggers(s, { event: "leaves_battle", card }, ctx, events);
        }
      }
      return false;
    }

    case "at_end_of_turn": {
      // « Passez-la en mode Action / retournez cette carte dans votre main à la fin du tour. »
      const then = ((step["then"] ?? []) as Json[])[0];
      const action = then?.["do"] === "set_active" ? "set_active" : then?.["do"] === "return_to_hand" ? "return_to_hand" : null;
      if (!action || then?.["target"] !== "this") break;
      if (findCandidate(s, r.source.uid)) s.endOfTurn.push({ player: r.player, uid: r.source.uid, action, turn: s.turnNumber });
      return false;
    }

    case "remove_this_at_end_of_turn": {
      if (findCandidate(s, r.source.uid)) s.endOfTurn.push({ player: r.player, uid: r.source.uid, action: "remove_from_game", turn: s.turnNumber });
      return false;
    }

    case "combo_power_mod": {
      // « Cette carte gagne +X de puissance de Combo pour tout le combat » (elle est dans la Zone de Combo).
      if (step["target"] !== "this") break;
      if (!p.combo.some((c) => c.uid === r.source.uid)) return false;
      s.powerMods.push({ uid: r.source.uid, amount: step["amount"] as number, until: "battle", combo: true });
      events.push({ type: "EFFECT_NOTE", player: r.player, cardId: r.source.cardId, text: `+${step["amount"] as number} de puissance de Combo pour tout le combat` });
      return false;
    }

    case "hand_to_deck_bottom":
    case "hand_to_z_energy": {
      // « Placez une carte de votre main au-dessous de votre deck » / « rajoutez-la à vos Énergies Z ».
      const options = handOptions(s, ctx, r.player, step["filter"]);
      if (options === null) break;
      return askOrApply(s, ctx, step, r.player, options, targetCount(step, options.length), events);
    }

    case "add_markers": {
      // « Rajoutez un marqueur sur cette carte » (Unisson).
      const unison = p.unison.find((c) => c.uid === r.source.uid);
      if (!unison) return false;
      unison.markers = (unison.markers ?? 0) + ((step["count"] as number) ?? 1);
      events.push({ type: "MARKERS_CHANGED", player: r.player, uid: unison.uid, cardId: unison.cardId, markers: unison.markers });
      return false;
    }

    case "search_deck": {
      // « Rajoutez à votre main jusqu'à un ... depuis votre deck, puis mélangez votre deck. »
      insertSteps(s, [
        { do: "look_top_deck", count: p.deck.length, pick: { up_to: step["up_to"] ?? 1, filter: step["filter"], to: "hand", reveal: true }, then: "shuffle_deck" },
      ]);
      return false;
    }

    case "next_union_discount":
    case "next_extra_z_discount": {
      const reduce = (step["reduce"] ?? {}) as Json;
      s.nextDiscounts.push({
        player: r.player,
        on: step.do === "next_union_discount" ? "union" : "extra_z",
        filter: (step["filter"] ?? {}) as Json,
        colors: (reduce["specified"] ?? {}) as Record<string, number>,
        generic: (reduce["generic"] as number) ?? 0,
        // « Jusqu'à la fin de votre tour » pendant le tour adverse : jusqu'à la fin de votre prochain tour.
        untilTurn: step["duration"] === "your_turn" && s.turnPlayer !== r.player ? s.turnNumber + 1 : s.turnNumber,
      });
      events.push({
        type: "EFFECT_NOTE",
        player: r.player,
        cardId: r.source.cardId,
        text: step.do === "next_union_discount"
          ? step["duration"] === "your_turn" && s.turnPlayer !== r.player
            ? "le prochain coût de Capacité Union sera réduit jusqu'à la fin de son prochain tour"
            : "le prochain coût de Capacité Union sera réduit ce tour"
          : "la prochaine Extra Z placée ce tour coûtera moins cher",
      });
      return false;
    }

    case "activate_from_hand": {
      // « Activez la Capacité Activation : Principale de jusqu'à un {X} dans votre main » : la carte
      // est placée dans la Dispersion (12-2) et sa Capacité se résout, sans payer le coût de la carte.
      const options = handOptions(s, ctx, r.player, step["filter"]);
      if (options === null) break;
      const usable = options.filter((uid) => {
        const card = p.hand.find((c) => c.uid === uid)!;
        const found = mainAbilityOf(ctx, card.cardId);
        if (!found) return false;
        const limit = (found.ability["limits"] ?? {}) as Json;
        return typeof limit["limit"] !== "number" || (s.turnUsage[`limit:${r.player}:${card.cardId}#${found.index}`] ?? 0) < limit["limit"];
      });
      return askOrApply(s, ctx, step, r.player, usable, targetCount(step, usable.length), events);
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

/** Peut-on associer chaque carte choisie à une description différente ? */
function assignable(uids: string[], filters: Json[], s: GameState, ctx: GameContext): boolean {
  const cards = uids.map((uid) => {
    for (const pl of ["P1", "P2"] as const) {
      const c = s.players[pl].drop.find((x) => x.uid === uid);
      if (c) return c;
    }
    return null;
  });
  if (cards.some((c) => !c) || cards.length !== filters.length) return false;
  const go = (i: number, used: Set<number>): boolean =>
    i === cards.length || filters.some((f, j) => !used.has(j) && matchesFilter(cards[i]!, f, ctx.cards, s) === true && go(i + 1, new Set([...used, j])));
  return go(0, new Set());
}

/** « verte, jaune » pour un message. */
function describeFilters(filters: Json[]): string {
  const names: Record<string, string> = { green: "verte", yellow: "jaune", red: "rouge", blue: "bleue", black: "noire", white: "blanche" };
  return filters.map((f) => ((f["colors_any"] ?? []) as string[]).map((c) => names[c] ?? c).join("/") || "carte").join(", ");
}

/** Première Capacité [Activation : Principale] d'une carte (et sa position). */
function mainAbilityOf(ctx: GameContext, cardId: string): { ability: Json; index: number } | null {
  const list = abilitiesOf(ctx.cards, ctx.cards.get(cardId));
  const index = list.findIndex((a) => a["kind"] === "activate" && a["timing"] === "main");
  return index < 0 ? null : { ability: list[index]!, index };
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
  // « une carte verte et une carte jaune dans votre Dispersion » : des cartes DIFFÉRENTES.
  const fromDrop = cost.filter((c) => c.do === "drop_to_warp").flatMap((c) => (c["filters"] ?? [c["filter"] ?? {}]) as Json[]);
  if (fromDrop.length > 0) {
    const drop = s.players[player].drop;
    const assign = (i: number, used: Set<string>): boolean => {
      if (i === fromDrop.length) return true;
      return drop.some((c) => !used.has(c.uid) && matchesFilter(c, fromDrop[i], ctx.cards, s) === true && assign(i + 1, new Set([...used, c.uid])));
    };
    if (!assign(0, new Set())) return false;
  }
  for (const c of cost) {
    if (c.do === "discard") {
      const options = handOptions(s, ctx, player, c["filter"]);
      if (!options || options.length < ((c["count"] as number) ?? 1)) return false;
    } else if (c.do === "z_energy_to_drop") {
      if (s.players[player].zEnergy.length < ((c["count"] as number) ?? 1)) return false;
    } else if (c.do === "hand_to_deck_bottom" || c.do === "hand_to_z_energy") {
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
  if (pending.matchEach && !assignable(chosen, pending.matchEach, s, ctx)) {
    return "choisissez une de chaque sorte demandée (ex. une verte ET une jaune), toutes différentes";
  }
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
  if (pending.type === "CHOOSE_LIFE" && pending.to === "drop") {
    // Vers la Dispersion (zone publique) : les cartes sont révélées.
    for (const c of taken) toDrop(s, c);
    if (taken.length > 0) events.push({ type: "CARDS_DISCARDED", player: owner, cardIds: taken.map((c) => c.cardId) });
  } else if (pending.type === "CHOOSE_LIFE") {
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
  } else if (step.do === "choose_one") {
    const option = ((step["options"] ?? []) as Json[])[Number(action.id)];
    insertSteps(s, ((option?.["steps"] ?? []) as EffectStep[]));
  } else if (step.do === "negate_one_keyword") {
    negateKeyword(s, step, r.memo.shift()!, action.id, events);
    if (askKeyword(s, ctx, step, events)) return null;
  }
  nextStep(s, ctx, events);
  return null;
}
