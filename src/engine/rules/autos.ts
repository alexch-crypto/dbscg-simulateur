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
// [Auto.] des cartes en main ou en Dispersion. Les effets retardés passent par `enqueueSteps`.

import { abilitiesOf, type RawAbility } from "../cards/abilities";
import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type CardInstance, type CardRef, type Continuation, type GameState, type PlayerId, type QueuedAuto } from "../state/types";
import { applyPowerRules, battleEndStep, continueAttack, startBlockerStep } from "./battle";
import { abilityConditions, checkConditions, matchesFilter } from "./conditions";
import { checkDefeat } from "./defeat";
import { afterCounterLink } from "./counters";
import { resumeResolution, startResolution } from "./effects";
import { isNegated } from "./keywords";
import { leaderAbilities, leaderCardId } from "./leader";
import { finishPlay } from "./play";
import { finishZPlay } from "./zdeck";
import { continueSetupTutor } from "./setup";

// ---------------------------------------------------------------------------
// Déclencheurs
// ---------------------------------------------------------------------------

export type Trigger =
  /** 9-6-9-4 : une carte est jouée dans la Zone de Combat (`via` : Capacité-clef utilisée, ex. « successor »). */
  | { event: "played"; card: CardInstance; via?: string }
  /** 8-1-3 : une carte attaque / est attaquée. */
  | { event: "attacks"; ref: CardRef }
  | { event: "attacked"; ref: CardRef }
  /**
   * Une carte quitte la Zone de Combat (mise KO en combat ou par une Capacité). `bySkillOf` : maître
   * de la Capacité responsable ; `toDrop` : elle va dans une Dispersion ; `hadBlocker` : elle avait [Bloqueur].
   */
  | { event: "leaves_battle"; card: CardInstance; bySkillOf?: PlayerId; toDrop?: boolean; hadBlocker?: boolean }
  /** Une Unisson quitte la Zone Unisson. */
  | { event: "leaves_unison"; card: CardInstance }
  /** 5-7 : une carte est utilisée pour une Combo. */
  | { event: "used_in_combo"; card: CardInstance }
  /** Un joueur active une Capacité [Contre]. */
  | { event: "counter_activated"; player: PlayerId }
  /** Un joueur active une Capacité [Union]. */
  | { event: "union_activated"; player: PlayerId }
  /** 8-5-9 : fin du combat pendant lequel cette carte a été attaquée. */
  | { event: "battle_end_attacked"; ref: CardRef };

/** Événements du fichier de cartes qui correspondent à chaque déclencheur (pour « cette carte »). */
const SELF_EVENTS: Record<Trigger["event"], string[]> = {
  played: ["played", "played_or_attacks", "placed_in_battle_area"],
  attacks: ["attacks", "played_or_attacks"],
  attacked: ["attacked"],
  leaves_battle: ["leaves_battle_area_by_skill_or_ko"],
  leaves_unison: ["leaves_unison_area"],
  used_in_combo: ["used_in_combo"],
  counter_activated: [],
  union_activated: [],
  battle_end_attacked: ["battle_end"],
};

/**
 * Met en suspens les [Auto.] d'un joueur dont le déclencheur ne concerne pas « cette carte »
 * (ex. « quand votre adversaire active un Contre ») : Leader, cartes de Combat et Unisson en jeu.
 */
function queueOthers(
  s: GameState,
  player: PlayerId,
  event: string,
  ctx: GameContext,
  events: GameEvent[],
  accept: (t: Record<string, unknown>) => boolean = () => true,
): void {
  const p = s.players[player];
  const refs: CardRef[] = [{ player, uid: p.leader.uid }, ...[...p.battle, ...p.unison].map((c) => ({ player, uid: c.uid }))];
  for (const ref of refs) {
    const other = sourceOf(s, ref, ctx);
    other?.abilities.forEach((ability, index) => {
      const t = ability["trigger"] as Record<string, unknown> | undefined;
      if (ability["kind"] !== "auto" || t?.["event"] !== event || !accept(t)) return;
      enqueue(s, player, other, ability, index, events);
    });
  }
}

/** Carte (uid, numéro, maître, Capacités actuelles) désignée par une référence en jeu. */
function sourceOf(s: GameState, ref: CardRef, ctx: GameContext) {
  const p = s.players[ref.player];
  // 9-1 : une carte dont les Capacités sont annulées ne déclenche rien.
  if (isNegated(s, ref.uid)) return null;
  if (p.leader.uid === ref.uid) {
    return { uid: ref.uid, cardId: leaderCardId(p.leader), player: ref.player, abilities: leaderAbilities(p.leader, ctx.cards) };
  }
  const card = [...p.battle, ...p.unison].find((c) => c.uid === ref.uid);
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

/**
 * Met en suspens des instructions qui ne viennent pas d'une [Auto.] imprimée (effet retardé,
 * effet « à la fin du combat ») : elles se résolvent au prochain point de contrôle.
 */
export function enqueueSteps(
  s: GameState,
  player: PlayerId,
  source: { uid: string; cardId: string },
  steps: unknown[],
  label: string,
  events: GameEvent[],
): void {
  enqueue(s, player, source, { kind: "auto", effect: structuredClone(steps), text: label }, -1, events);
}

/** Met en suspens les [Auto.] déclenchées par un événement (9-6-2). */
export function queueTriggers(
  s: GameState,
  trigger: Trigger,
  ctx: GameContext,
  events: GameEvent[],
  /** Les Capacités de la carte concernée étaient annulées : seules les autres cartes réagissent. */
  selfNegated = false,
): void {
  if (trigger.event === "counter_activated") {
    queueOthers(s, opponentOf(trigger.player), "opponent_activates_counter", ctx, events);
    return;
  }
  if (trigger.event === "union_activated") {
    queueOthers(s, trigger.player, "you_activate_union", ctx, events);
    return;
  }
  // 1) Capacités « cette carte » de la carte concernée.
  let source: { uid: string; cardId: string; player: PlayerId; abilities: RawAbility[] } | null;
  if (selfNegated) {
    source = null;
  } else if ("ref" in trigger) {
    source = sourceOf(s, trigger.ref, ctx);
  } else {
    // La carte peut déjà avoir changé de zone (ex. mise KO) : on lit ses Capacités sur sa définition.
    // 9-6-9-1-2 : son maître est celui de la Zone de Combat qu'elle quitte (ici, son propriétaire).
    // Une carte dont les Capacités sont annulées (ex. par un [Contre : Mise en jeu]) ne déclenche rien.
    const card = trigger.card;
    source = isNegated(s, card.uid)
      ? null
      : { uid: card.uid, cardId: card.cardId, player: card.owner, abilities: abilitiesOf(ctx.cards, ctx.cards.get(card.cardId)) };
  }
  if (source) {
    source.abilities.forEach((ability, index) => {
      if (ability["kind"] !== "auto") return;
      const t = ability["trigger"] as Record<string, unknown> | undefined;
      // « Cette carte », ou « à la fin du combat pendant lequel cette carte a été attaquée ».
      if (!t || (t["who"] !== "this" && t["condition"] !== "this_was_attacked")) return;
      // « Quand cette carte est jouée via [Successeur] / avec [Espace-temps] ».
      const viaMatch = t["event"] === "played_via" && trigger.event === "played" && trigger.via !== undefined && t["via"] === trigger.via;
      if (!viaMatch && !SELF_EVENTS[trigger.event].includes(t["event"] as string)) return;
      enqueue(s, source!.player, source!, ability, index, events);
    });
  }

  // 2) Déclencheurs portés par les autres cartes en jeu.
  if (trigger.event === "played") {
    // « Quand une carte de Combat adverse est jouée ».
    const type = ctx.cards.get(trigger.card.cardId)?.type;
    if (type === "battle" || type === "z_battle") queueOthers(s, opponentOf(trigger.card.owner), "opponent_plays_battle_card", ctx, events);
  }
  if (trigger.event === "leaves_battle") {
    // « Quand une carte dans une Zone de Combat est placée dans une Dispersion ».
    if (trigger.toDrop) for (const pl of ["P1", "P2"] as const) queueOthers(s, pl, "battle_card_to_drop", ctx, events);
    // « Quand une de vos cartes de Combat avec [Bloqueur] quitte votre Zone de Combat via une Capacité adverse ».
    const owner = trigger.card.owner;
    if (trigger.hadBlocker && trigger.bySkillOf && trigger.bySkillOf !== owner) queueOthers(s, owner, "own_blocker_leaves_by_opponent_skill", ctx, events);
  }
  if (trigger.event === "used_in_combo") {
    // « Quand vous utilisez un de vos <...> pour une Combo ».
    queueOthers(s, trigger.card.owner, "you_combo_with", ctx, events, (t) => matchesFilter(trigger.card, t["filter"], ctx.cards, s) === true);
  }
  if (trigger.event === "played") {
    const player = trigger.card.owner;
    const p = s.players[player];
    const refs: CardRef[] = [
      { player, uid: p.leader.uid },
      ...[...p.battle, ...p.unison].filter((c) => c.uid !== trigger.card.uid).map((c) => ({ player, uid: c.uid })),
    ];
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
  // 21-6 / 21-8 : puissances à zéro ou moins (peut déclencher des [Auto.], résolues ci-dessous).
  applyPowerRules(s, ctx, events);
  // Le joueur actif d'abord, puis le joueur non actif.
  for (const player of [s.turnPlayer, opponentOf(s.turnPlayer)]) {
    const mine = s.autoQueue.filter((a) => a.player === player);
    if (mine.length === 0) {
      s.autoAsk = s.autoAsk.filter((p) => p !== player);
      continue;
    }
    // Plusieurs [Auto.] en même temps : le joueur choisit l'ordre, et on lui redemande à chaque
    // fois, jusqu'à la dernière (pour qu'il voie qu'elle se résout aussi).
    if (mine.length > 1 && !s.autoAsk.includes(player)) s.autoAsk.push(player);
    if (mine.length === 1 && !s.autoAsk.includes(player)) {
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
  const conditions = checkConditions(s, auto.player, abilityConditions(auto.ability), ctx.cards, auto.source.uid);
  if (typeof conditions === "string") return cancel(`condition pas encore gérée par le moteur (${conditions})`);
  if (!conditions) return cancel("condition non remplie");
  // 9-6-4-1 : avec un coût de Capacité, le joueur choisit de le payer entièrement ou pas du tout.
  const cost = auto.ability["cost"];

  if (limits["once_per_turn"]) s.turnUsage[onceKey] = (s.turnUsage[onceKey] ?? 0) + 1;
  if (typeof limits["limit"] === "number") s.turnUsage[limitKey] = (s.turnUsage[limitKey] ?? 0) + 1;

  // 9-6-5 à 9-6-7 : la Capacité s'active et ses effets se résolvent.
  const effect = (auto.ability["effect"] ?? []) as Parameters<typeof startResolution>[4];
  const steps = Array.isArray(cost) && cost.length > 0 ? [{ do: "optional", cost, then: effect }] : effect;
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
      battleEndStep(s, ctx, events);
      return;
    case "finish_play":
      finishPlay(s, ctx, then.player, then.uid, events, then.markers);
      return;
    case "finish_z_play":
      finishZPlay(s, ctx, then.player, then.uid, then.markers, events);
      return;
    case "run_resolution":
      resumeResolution(s, ctx, events);
      return;
    case "attack_checkpoint":
      // 8-1-5 : point de contrôle (les [Auto.] « quand cette carte attaque »), puis 8-1-6.
      checkpoint(s, ctx, { kind: "blocker_step" }, events);
      return;
    case "counter_chain":
      afterCounterLink(s, ctx, events);
      return;
    case "attack_after_tax":
      continueAttack(s, ctx, events);
      return;
    case "setup_tutor":
      continueSetupTutor(s, ctx, then.next, events);
      return;
  }
}
