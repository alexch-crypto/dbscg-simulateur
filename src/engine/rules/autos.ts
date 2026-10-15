// Capacités [Auto.] (manuel 9-6) et points de contrôle (4-2).
//
// 1. Quand un événement déclencheur se produit, chaque [Auto.] concernée se met en suspens :
//    elle est ajoutée à `s.autoQueue` avec une COPIE de sa Capacité (9-6-11 : elle se résoudra
//    même si la carte change de zone ou perd ses Capacités entre-temps).
// 2. Au point de contrôle, on résout une par une les [Auto.] du joueur actif, puis celles du
//    joueur non actif (schéma 9-6). Si un joueur en a plusieurs, il choisit l'ordre (9-6-3).
// 3. Une fois la file vide, le jeu reprend là où il en était (`Continuation`).
//
// Non géré pour l'instant : coûts de Capacité des [Auto.], fenêtres de contre (9-6-6 / 9-6-8),
// [Auto.] des cartes en main ou en Dispersion, effets retardés.

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type CardInstance, type CardRef, type Continuation, type GameState, type PlayerId, type QueuedAuto } from "../state/types";
import { battleEndStep, startBlockerStep } from "./battle";
import { checkConditions, matchesFilter } from "./conditions";
import { checkDefeat } from "./defeat";
import { startResolution } from "./effects";

// ---------------------------------------------------------------------------
// Déclencheurs
// ---------------------------------------------------------------------------

export type Trigger =
  /** 9-6-9-4 : une carte est jouée dans la Zone de Combat. */
  | { event: "played"; card: CardInstance }
  /** 8-1-3 : une carte attaque / est attaquée. */
  | { event: "attacks"; ref: CardRef }
  | { event: "attacked"; ref: CardRef }
  /** Une carte quitte la Zone de Combat (mise KO en combat ou par une Capacité). */
  | { event: "leaves_battle"; card: CardInstance }
  /** 5-7 : une carte est utilisée pour une Combo. */
  | { event: "used_in_combo"; card: CardInstance };

/** Événements du fichier de cartes qui correspondent à chaque déclencheur (pour « cette carte »). */
const SELF_EVENTS: Record<Trigger["event"], string[]> = {
  played: ["played", "played_or_attacks"],
  attacks: ["attacks", "played_or_attacks"],
  attacked: ["attacked"],
  leaves_battle: ["leaves_battle_area_by_skill_or_ko"],
  used_in_combo: ["used_in_combo"],
};

/** Carte (uid, numéro, maître, Capacités actuelles) désignée par une référence en jeu. */
function sourceOf(s: GameState, ref: CardRef, ctx: GameContext) {
  const p = s.players[ref.player];
  if (p.leader.uid === ref.uid) {
    const def = ctx.cards.get(p.leader.cardId);
    return { uid: ref.uid, cardId: p.leader.cardId, player: ref.player, abilities: abilitiesOf(ctx.cards, def, p.leader.side) };
  }
  const card = p.battle.find((c) => c.uid === ref.uid);
  if (!card) return null;
  return { uid: card.uid, cardId: card.cardId, player: ref.player, abilities: abilitiesOf(ctx.cards, ctx.cards.get(card.cardId)) };
}

function enqueue(
  s: GameState,
  player: PlayerId,
  source: { uid: string; cardId: string },
  ability: RawAbility,
  index: number,
  events: GameEvent[],
): void {
  const auto: QueuedAuto = {
    id: s.nextAutoId++,
    player,
    source,
    ability: structuredClone(ability),
    abilityKey: `${source.cardId}#${index}`,
  };
  s.autoQueue.push(auto);
  events.push({ type: "AUTO_TRIGGERED", player, uid: source.uid, cardId: source.cardId });
}

/** Met en suspens les [Auto.] déclenchées par un événement (9-6-2). */
export function queueTriggers(s: GameState, trigger: Trigger, ctx: GameContext, events: GameEvent[]): void {
  // 1) Capacités « cette carte » de la carte concernée.
  let source: { uid: string; cardId: string; player: PlayerId; abilities: RawAbility[] } | null;
  if ("ref" in trigger) {
    source = sourceOf(s, trigger.ref, ctx);
  } else {
    // La carte peut déjà avoir changé de zone (ex. mise KO) : on lit ses Capacités sur sa définition.
    // 9-6-9-1-2 : son maître est celui de la Zone de Combat qu'elle quitte (ici, son propriétaire).
    const card = trigger.card;
    source = { uid: card.uid, cardId: card.cardId, player: card.owner, abilities: abilitiesOf(ctx.cards, ctx.cards.get(card.cardId)) };
  }
  if (source) {
    source.abilities.forEach((ability, index) => {
      if (ability["kind"] !== "auto") return;
      const t = ability["trigger"] as Record<string, unknown> | undefined;
      if (!t || t["who"] !== "this" || !SELF_EVENTS[trigger.event].includes(t["event"] as string)) return;
      enqueue(s, source!.player, source!, ability, index, events);
    });
  }

  // 2) « Quand vous jouez un <...> » sur les autres cartes en jeu du même joueur.
  if (trigger.event === "played") {
    const player = trigger.card.owner;
    const p = s.players[player];
    const refs: CardRef[] = [{ player, uid: p.leader.uid }, ...p.battle.filter((c) => c.uid !== trigger.card.uid).map((c) => ({ player, uid: c.uid }))];
    for (const ref of refs) {
      const other = sourceOf(s, ref, ctx);
      other?.abilities.forEach((ability, index) => {
        const t = ability["trigger"] as Record<string, unknown> | undefined;
        if (ability["kind"] !== "auto" || t?.["event"] !== "you_play_card") return;
        if (matchesFilter(trigger.card, t["filter"], ctx.cards) !== true) return;
        enqueue(s, player, other, ability, index, events);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Point de contrôle
// ---------------------------------------------------------------------------

/** Lance un point de contrôle ; `then` indique comment reprendre le jeu ensuite. */
export function checkpoint(s: GameState, ctx: GameContext, then: Continuation, events: GameEvent[]): void {
  s.checkpointThen = then;
  continueCheckpoint(s, ctx, events);
}

function continueCheckpoint(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  // Applications de règle en attente (21-2 : défaite).
  if (checkDefeat(s, events)) {
    s.autoQueue = [];
    s.checkpointThen = null;
    return;
  }
  // Le joueur actif d'abord, puis le joueur non actif.
  for (const player of [s.turnPlayer, opponentOf(s.turnPlayer)]) {
    const mine = s.autoQueue.filter((a) => a.player === player);
    if (mine.length === 0) continue;
    if (mine.length === 1) {
      resolveQueued(s, ctx, mine[0]!, events);
    } else {
      // 9-6-3 : le joueur choisit laquelle résoudre.
      s.pending = {
        type: "CHOOSE_AUTO",
        player,
        options: mine.map((a) => ({ id: a.id, label: `${ctx.cards.get(a.source.cardId)?.name ?? a.source.cardId} : ${String(a.ability["text"] ?? "")}` })),
      };
    }
    return;
  }
  // Plus rien en attente : on reprend le jeu.
  const then = s.checkpointThen ?? { kind: "checkpoint" as const };
  s.checkpointThen = null;
  continueWith(s, ctx, then, events);
}

/** Le joueur choisit quelle [Auto.] résoudre en premier (9-6-3). */
export function chooseAuto(s: GameState, action: Extract<Action, { type: "CHOOSE_AUTO" }>, ctx: GameContext, events: GameEvent[]): string | null {
  const auto = s.autoQueue.find((a) => a.id === action.id && a.player === action.player);
  if (!auto) return "9-6-3 : cette Capacité n'est pas en attente";
  s.pending = null;
  resolveQueued(s, ctx, auto, events);
  return null;
}

/** Retire une [Auto.] de la file, vérifie ses limites et conditions, puis résout ses effets. */
function resolveQueued(s: GameState, ctx: GameContext, auto: QueuedAuto, events: GameEvent[]): void {
  s.autoQueue = s.autoQueue.filter((a) => a.id !== auto.id);
  const name = auto.source.cardId;
  const cancel = (reason: string) => {
    events.push({ type: "AUTO_CANCELLED", player: auto.player, cardId: name, reason });
    continueCheckpoint(s, ctx, events);
  };

  // 22-11 [Une fois par tour] : par Capacité et par carte. 22-44 [Limite X] : partagée entre
  // tous les exemplaires du même numéro de carte, pour le même maître.
  const limits = (auto.ability["limits"] ?? {}) as Record<string, unknown>;
  const onceKey = `once:${auto.source.uid}:${auto.abilityKey}`;
  const limitKey = `limit:${auto.player}:${auto.abilityKey}`;
  if (limits["once_per_turn"] && (s.turnUsage[onceKey] ?? 0) >= 1) return cancel("22-11 : déjà utilisée ce tour");
  if (typeof limits["limit"] === "number" && (s.turnUsage[limitKey] ?? 0) >= limits["limit"]) {
    return cancel(`22-44 : [Limite ${limits["limit"]}] atteinte ce tour`);
  }

  // 9-6-4-1-1 : les conditions sont vérifiées au moment de résoudre.
  const conditions = checkConditions(s, auto.player, auto.ability["condition"], ctx.cards);
  if (typeof conditions === "string") return cancel(`condition pas encore gérée par le moteur (${conditions})`);
  if (!conditions) return cancel("condition non remplie");
  // 9-6-4 : coût de Capacité (pas encore géré pour les [Auto.]).
  const cost = auto.ability["cost"];
  if (Array.isArray(cost) && cost.length > 0) return cancel("coût de Capacité pas encore géré par le moteur");

  if (limits["once_per_turn"]) s.turnUsage[onceKey] = (s.turnUsage[onceKey] ?? 0) + 1;
  if (typeof limits["limit"] === "number") s.turnUsage[limitKey] = (s.turnUsage[limitKey] ?? 0) + 1;

  // 9-6-5 à 9-6-7 : la Capacité s'active et ses effets se résolvent.
  const steps = (auto.ability["effect"] ?? []) as Parameters<typeof startResolution>[4];
  startResolution(s, ctx, auto.player, auto.source, steps, { kind: "checkpoint" }, events);
}

/** Reprend le jeu après un effet ou un point de contrôle. */
export function continueWith(s: GameState, ctx: GameContext, then: Continuation, events: GameEvent[]): void {
  if (s.result) return;
  switch (then.kind) {
    case "checkpoint":
      continueCheckpoint(s, ctx, events);
      return;
    case "restore":
      // Un effet a pu déclencher d'autres [Auto.] : point de contrôle avant de rendre la main.
      if (s.autoQueue.length > 0) checkpoint(s, ctx, then, events);
      else s.pending = then.pending;
      return;
    case "blocker_step":
      startBlockerStep(s, ctx, events);
      return;
    case "battle_end_step":
      battleEndStep(s, events);
      return;
  }
}
