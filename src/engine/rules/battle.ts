// Attaques et combats (manuel, section 8), Combos (5-6, 5-7), dégâts (21-3), KO (5-12),
// mots-clés de combat : [Bloqueur] (22-4), [Coup Critique] (22-6), [Frappe] (22-7),
// [Réplique] / [Tri-offensive] (22-8), [Ultimate] (22-14).
// Non géré pour l'instant : fenêtres de contre (8-1-4), autres capacités [Auto.] « quand cette
// carte attaque / est attaquée », Unissons (pas d'étape de Défense, 8-2-4-3-1-1).

import type { CardDefinition } from "../cards/types";
import type { Action, GameContext, GameEvent } from "../protocol";
import { opponentOf, type CardInstance, type CardRef, type GameState, type PlayerId } from "../state/types";
import { checkDefeat } from "./defeat";
import { availableEnergySources, findPayment, type EnergyPayment } from "./energy";
import { checkpoint, queueTriggers } from "./autos";
import { hasKeyword, KW, readyAfterBattleCount, readyBlockedByEffect, removeIfUltimate, strikeDamage } from "./keywords";
import { payEnergy } from "./play";
import { forgetCard, koBattleCard } from "./zones";

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

type InPlay = { kind: "leader" } | { kind: "battle"; card: CardInstance };

/** Retrouve un Leader ou une carte de Combat en jeu d'un joueur. */
function findInPlay(s: GameState, player: PlayerId, uid: string): InPlay | null {
  const p = s.players[player];
  if (p.leader.uid === uid) return { kind: "leader" };
  const card = p.battle.find((c) => c.uid === uid);
  return card ? { kind: "battle", card } : null;
}

/** Puissance d'un Leader (selon sa face) ou d'une carte de Combat (2-7), avec les effets en cours. */
export function powerOf(s: GameState, ref: CardRef, ctx: GameContext): number {
  const found = findInPlay(s, ref.player, ref.uid);
  if (!found) return 0;
  let base: number;
  if (found.kind === "leader") {
    const leader = s.players[ref.player].leader;
    const def = ctx.cards.get(leader.cardId);
    base = (leader.side === "front" ? def?.front?.power : def?.back?.power) ?? 0;
  } else {
    base = ctx.cards.get(found.card.cardId)?.power ?? 0;
  }
  // 9-9-1 : on part de la valeur imprimée, puis on applique les effets continus chiffrés.
  return base + s.powerMods.filter((m) => m.uid === ref.uid).reduce((total, m) => total + m.amount, 0);
}

/** Déplace une carte vers la Zone de Dispersion de son propriétaire. */
function toDrop(s: GameState, card: CardInstance): void {
  card.mode = "active";
  card.faceUp = true;
  s.players[card.owner].drop.push(card);
}

/** 8-5-13 / 7-3-3 : retour au timing libre de la phase principale. */
function backToMain(s: GameState): void {
  s.battle = null;
  s.pending = { type: "MAIN", player: s.turnPlayer };
}

// ---------------------------------------------------------------------------
// 8-1 : déclaration d'attaque
// ---------------------------------------------------------------------------

/** Cartes qui peuvent attaquer : Leader et cartes de Combat en mode Action (8-1-1). */
export function possibleAttackers(s: GameState, player: PlayerId): string[] {
  // 7-3-4-4-1 : le premier joueur ne peut pas attaquer lors de son premier tour.
  if (s.turnNumber === 1 && player === s.firstPlayer) return [];
  const p = s.players[player];
  return [
    ...(p.leader.mode === "active" ? [p.leader.uid] : []),
    ...p.battle.filter((c) => c.mode === "active").map((c) => c.uid),
  ];
}

/** Cibles possibles : le Leader adverse, ou une carte de Combat adverse en mode Inertie (8-1-1). */
export function possibleTargets(s: GameState, player: PlayerId): string[] {
  const opp = s.players[opponentOf(player)];
  return [opp.leader.uid, ...opp.battle.filter((c) => c.mode === "rest").map((c) => c.uid)];
}

/** Bloqueurs disponibles : cartes en mode Action avec [Bloqueur], autres que la carte attaquée (22-4-2). */
export function possibleBlockers(s: GameState, ctx: GameContext): string[] {
  const battle = s.battle;
  if (!battle) return [];
  return s.players[battle.target.player].battle
    .filter(
      (c) =>
        c.mode === "active" &&
        c.uid !== battle.target.uid &&
        hasKeyword(s, { player: battle.target.player, uid: c.uid }, KW.blocker, ctx.cards),
    )
    .map((c) => c.uid);
}

export function declareAttack(
  s: GameState,
  action: Extract<Action, { type: "ATTACK" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const player = action.player;
  if (s.turnNumber === 1 && player === s.firstPlayer) {
    return "7-3-4-4-1 : le premier joueur ne peut pas attaquer lors de son premier tour";
  }
  const attacker = findInPlay(s, player, action.attacker);
  if (!attacker) return "8-1-1 : l'attaquant doit être votre Leader ou une de vos cartes de Combat";
  if (!possibleAttackers(s, player).includes(action.attacker)) return "8-1-1 : l'attaquant doit être en mode Action";
  const defenderPlayer = opponentOf(player);
  const target = findInPlay(s, defenderPlayer, action.target);
  if (!target) return "8-1-1 : la cible doit être le Leader adverse ou une carte de Combat adverse";
  if (target.kind === "battle" && target.card.mode !== "rest") {
    return "8-1-1 : une carte de Combat adverse ne peut être attaquée que si elle est en mode Inertie";
  }

  // 8-1-1 : passer l'attaquant du mode Action au mode Inertie. 8-1-2 : un combat se lance.
  if (attacker.kind === "leader") s.players[player].leader.mode = "rest";
  else attacker.card.mode = "rest";
  const targetRef = { player: defenderPlayer, uid: action.target };
  const attackerRef = { player, uid: action.attacker };
  s.battle = { attacker: attackerRef, defender: targetRef, target: targetRef, step: "attack_declared", pendingAutos: [] };
  events.push({ type: "ATTACK_DECLARED", player, attacker: action.attacker, target: action.target });

  // 8-1-3 : les capacités « quand cette carte attaque / est attaquée » se mettent en suspens.
  // 22-8-2 : [Réplique] / [Tri-offensive] passe en état de suspens quand la carte attaque,
  // si elle n'a pas déjà été utilisée X-1 fois ce tour (22-8-3).
  const usageKey = `dual_attack:${action.attacker}`;
  if ((s.turnUsage[usageKey] ?? 0) < readyAfterBattleCount(s, attackerRef, ctx.cards)) {
    s.battle.pendingAutos.push({ kind: "dual_attack", card: attackerRef, usageKey });
  }
  // Ordre (décision du joueur, conforme à 8-1-3 / 8-1-5) : fenêtre de contre (à venir), puis
  // les [Auto.] « quand cette carte attaque » (joueur actif) et « quand cette carte est
  // attaquée » (joueur non actif), puis seulement le blocage.
  queueTriggers(s, { event: "attacks", ref: attackerRef }, ctx, events);
  queueTriggers(s, { event: "attacked", ref: targetRef }, ctx, events);
  checkpoint(s, ctx, { kind: "blocker_step" }, events);
  return null;
}

/** 22-4 : étape de blocage — le défenseur choisit au plus un Bloqueur, s'il en a. */
export function startBlockerStep(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  if (possibleBlockers(s, ctx).length > 0) {
    s.pending = { type: "BLOCKER", player: s.battle!.target.player };
  } else {
    startOffenseStep(s, events);
  }
}

/** 22-4 : le défenseur active (ou non) [Bloqueur]. */
export function declareBlocker(
  s: GameState,
  action: Extract<Action, { type: "DECLARE_BLOCKER" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const battle = s.battle!;
  if (action.uid !== null) {
    if (!possibleBlockers(s, ctx).includes(action.uid)) {
      return "22-4-2 : le Bloqueur doit être une de vos cartes de Combat en mode Action avec [Bloqueur], autre que la carte attaquée";
    }
    // 22-4-2 : coût de Capacité, passer la carte en mode Inertie.
    // 22-4-3 : elle devient la carte de défense.
    const blocker = s.players[action.player].battle.find((c) => c.uid === action.uid)!;
    blocker.mode = "rest";
    battle.defender = { player: action.player, uid: action.uid };
    events.push({ type: "BLOCKER_DECLARED", player: action.player, uid: action.uid });
  }
  startOffenseStep(s, events);
  return null;
}

/** 8-1-4 à 8-1-6 puis 8-2 : étape d'Attaque. */
function startOffenseStep(s: GameState, events: GameEvent[]): void {
  // 8-1-4 : fenêtre de contre (à venir). 8-1-5 : point de contrôle.
  // 8-1-6 : l'attaque est valide, passez à l'étape d'Attaque.
  // 8-2-2 : capacités « Au début de l'étape d'Attaque ». 8-2-3 : point de contrôle.
  s.battle!.step = "offense";
  events.push({ type: "BATTLE_STEP", step: "offense" });
  s.pending = { type: "OFFENSE", player: s.turnPlayer };
}

// ---------------------------------------------------------------------------
// 5-7 : Combos (étapes d'Attaque et de Défense)
// ---------------------------------------------------------------------------

/** Carte du joueur qui est en combat (attaquante ou de défense). */
function ownCardInBattle(s: GameState, player: PlayerId): CardRef {
  const battle = s.battle!;
  return battle.attacker.player === player ? battle.attacker : battle.defender;
}

/** 5-6-1-1 : un coût de Combo se paie avec des Énergies de n'importe quelle couleur. */
const comboPayment = (card: CardDefinition): EnergyPayment => ({ colors: {}, generic: card.combo!.cost });

/** 5-7-2 : seule une carte de Combat avec un coût et une puissance de Combo non négatifs peut combo. */
const canCombo = (card: CardDefinition | undefined): card is CardDefinition =>
  card?.type === "battle" && card.combo !== undefined && card.combo.cost >= 0 && card.combo.power >= 0;

/**
 * Cartes utilisables pour une Combo : cartes de Combat de la main (5-7-5-1-2 / 5-7-6-1-2) et
 * cartes de Combat en mode Action de la Zone de Combat, autres que la carte en combat
 * (5-7-5-1-1 / 5-7-6-1-1).
 */
export function comboCandidates(s: GameState, player: PlayerId, ctx: GameContext): { card: CardInstance; from: "hand" | "battle" }[] {
  const p = s.players[player];
  const inBattle = ownCardInBattle(s, player).uid;
  return [
    ...p.hand.filter((c) => canCombo(ctx.cards.get(c.cardId))).map((card) => ({ card, from: "hand" as const })),
    ...p.battle
      .filter((c) => c.mode === "active" && c.uid !== inBattle && canCombo(ctx.cards.get(c.cardId)))
      .map((card) => ({ card, from: "battle" as const })),
  ];
}

/** Paiement suggéré pour une Combo, ou null si le coût de Combo ne peut pas être payé (5-6-3). */
export function suggestComboPayment(s: GameState, player: PlayerId, card: CardInstance, ctx: GameContext) {
  const def = ctx.cards.get(card.cardId);
  if (!canCombo(def)) return null;
  const sources = availableEnergySources(s, player, ctx.cards);
  const chosen = findPayment(sources, comboPayment(def));
  if (!chosen) return null;
  return {
    energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
    markers: chosen.filter((src) => src.id === "marker").length,
  };
}

export function combo(
  s: GameState,
  action: Extract<Action, { type: "COMBO" }>,
  ctx: GameContext,
  events: GameEvent[],
): string | null {
  const candidate = comboCandidates(s, action.player, ctx).find((c) => c.card.uid === action.uid);
  if (!candidate) {
    return "5-7-5 / 5-7-6 : la Combo doit utiliser une carte de Combat de votre main, ou une de vos cartes de Combat en mode Action autre que celle en combat";
  }
  // 5-7-3 : passer en mode Inertie les Énergies du coût de Combo, puis effectuer la Combo.
  const def = ctx.cards.get(candidate.card.cardId)!;
  const error = payEnergy(s, action.player, comboPayment(def), action.payment, ctx);
  if (error) return error;

  // 5-7-5-2 / 5-7-6-2 : la carte est placée dans la Zone de Combo.
  const resume = s.pending!;
  const p = s.players[action.player];
  const zone = candidate.from === "hand" ? p.hand : p.battle;
  zone.splice(zone.indexOf(candidate.card), 1);
  if (candidate.from === "battle") forgetCard(s, candidate.card.uid);
  // 22-14-3 : une carte [Ultimate] qui quitte la Zone de Combat est retirée de la partie à la place.
  const removed = candidate.from === "battle" && removeIfUltimate(s, candidate.card, ctx.cards);
  if (!removed) {
    candidate.card.mode = "active";
    candidate.card.faceUp = true;
    p.combo.push(candidate.card);
  }
  events.push({
    type: "COMBO",
    player: action.player,
    uid: candidate.card.uid,
    cardId: candidate.card.cardId,
    from: candidate.from,
    energyRested: [...action.payment.energy],
    markersUsed: action.payment.markers,
  });
  if (removed) {
    events.push({ type: "CARD_REMOVED", player: action.player, uid: candidate.card.uid, cardId: candidate.card.cardId });
  } else {
    queueTriggers(s, { event: "used_in_combo", card: candidate.card }, ctx, events);
  }
  // 5-7-5-3 : point de contrôle. 5-7-5-4 : le joueur peut continuer à faire des Combos.
  checkpoint(s, ctx, { kind: "restore", pending: resume }, events);
  return null;
}

// ---------------------------------------------------------------------------
// Fin des étapes d'Attaque / Défense, étape des Dégâts
// ---------------------------------------------------------------------------

export function endStep(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const battle = s.battle!;
  if (battle.step === "offense") {
    // 8-2-4-3-1-1 : passez à l'étape de Défense (8-3).
    // 8-3-2 : capacités « Au début de l'étape de Défense ». 8-3-3 : point de contrôle.
    battle.step = "defense";
    events.push({ type: "BATTLE_STEP", step: "defense" });
    s.pending = { type: "DEFENSE", player: opponentOf(s.turnPlayer) };
  } else {
    // 8-3-4-3-1 : passez à l'étape des Dégâts.
    damageStep(s, ctx, events);
  }
}

/** Somme des puissances de Combo de la Zone de Combo d'un joueur. */
function comboPower(s: GameState, player: PlayerId, ctx: GameContext): number {
  return s.players[player].combo.reduce((total, c) => total + (ctx.cards.get(c.cardId)?.combo?.power ?? 0), 0);
}

/** 8-4 : étape des Dégâts. */
function damageStep(s: GameState, ctx: GameContext, events: GameEvent[]): void {
  const battle = s.battle!;
  battle.step = "damage";
  s.pending = null;
  events.push({ type: "BATTLE_STEP", step: "damage" });
  // 8-4-2 : capacités « Au début de votre étape des Dégâts ». 8-4-3 : point de contrôle.

  // 8-4-4 / 8-4-5 : ajouter les puissances de Combo de chaque joueur à sa carte en combat.
  const attackerPower = powerOf(s, battle.attacker, ctx) + comboPower(s, battle.attacker.player, ctx);
  const defenderPower = powerOf(s, battle.defender, ctx) + comboPower(s, battle.defender.player, ctx);
  events.push({ type: "POWER_COMPARED", attacker: attackerPower, defender: defenderPower });

  // 8-4-6 : si la puissance de l'attaquant est ÉGALE OU SUPÉRIEURE à celle de la carte de défense...
  if (attackerPower >= defenderPower) {
    const defender = findInPlay(s, battle.defender.player, battle.defender.uid);
    if (defender?.kind === "leader") {
      // 8-4-6-1-2-1 : la carte attaquante inflige 1 dégât au joueur non actif.
      // 22-7 : [Double/Triple/Quadruple Frappe] => 2, 3 ou 4 dégâts à la place.
      // 22-6 : [Coup Critique] => les cartes de Vie vont en Dispersion au lieu de la main.
      const amount = strikeDamage(s, battle.attacker, ctx.cards);
      const critical = hasKeyword(s, battle.attacker, KW.critical, ctx.cards);
      dealDamage(s, battle.defender.player, amount, critical, events);
      if (s.pending) return; // le joueur doit d'abord choisir ses cartes de Vie
    } else if (defender?.kind === "battle") {
      // 8-4-6-2-1 : la carte de défense est mise KO (5-12-1 : placée dans la Dispersion ;
      // 22-14-3 : retirée de la partie si elle a [Ultimate]).
      koBattleCard(s, ctx, battle.defender.player, defender.card, events);
    }
  }
  // 8-4-8 : point de contrôle (ex. « quand cette carte est mise KO »), puis 8-4-9.
  checkpoint(s, ctx, { kind: "battle_end_step" }, events);
}

/** 5-10 / 21-3 : infliger X dégâts à un joueur. */
function dealDamage(s: GameState, player: PlayerId, amount: number, critical: boolean, events: GameEvent[]): void {
  // 21-3-2 : si X = 0, rien ne se passe.
  if (amount <= 0) return;
  events.push({ type: "DAMAGE_DEALT", player, amount, critical });
  // 21-3-2 : le joueur choisit X cartes de sa Zone de Vie (toutes en même temps, décision du joueur).
  s.pending = { type: "TAKE_DAMAGE", player, amount, critical };
}

/** Nombre de cartes de Vie à choisir : X, ou toute la Vie s'il en reste moins (0-2-4). */
export const lifeCardsToChoose = (s: GameState, player: PlayerId, amount: number): number =>
  Math.min(amount, s.players[player].life.length);

/** 21-3-2 : le joueur qui subit les dégâts choisit ses cartes de Vie (positions). */
export function takeLife(
  s: GameState,
  action: Extract<Action, { type: "TAKE_LIFE" }>,
  events: GameEvent[],
): string | null {
  const pending = s.pending as Extract<GameState["pending"], { type: "TAKE_DAMAGE" }>;
  const p = s.players[action.player];
  const expected = lifeCardsToChoose(s, action.player, pending.amount);
  const indices = action.indices;
  if (indices.length !== expected) return `21-3-2 : choisissez ${expected} carte(s) de Vie`;
  if (new Set(indices).size !== indices.length) return "21-3-2 : une même carte de Vie est choisie deux fois";
  if (!indices.every((i) => Number.isInteger(i) && i >= 0 && i < p.life.length)) {
    return `21-3-2 : position de Vie invalide (vous avez ${p.life.length} carte(s) de Vie)`;
  }

  // On retire les cartes de la plus haute position à la plus basse pour garder les positions valides.
  const sorted = [...indices].sort((a, b) => a - b);
  const taken = [...sorted].reverse().map((i) => p.life.splice(i, 1)[0]!).reverse();
  const wasFaceUp = taken.map((c) => c.faceUp);
  const to = pending.critical ? "drop" : "hand";
  for (const card of taken) {
    if (pending.critical) {
      // 22-6-2 : placées dans la Zone de Dispersion au lieu de la main (zone publique).
      card.faceUp = true;
      card.mode = "active";
      s.players[card.owner].drop.push(card);
    } else {
      card.faceUp = false;
      p.hand.push(card);
    }
  }
  events.push({
    type: "LIFE_LOST",
    player: action.player,
    indices: sorted,
    to,
    // L'identité n'est publique que si la carte va en Dispersion ou était face visible.
    cardIds: taken.map((c, i) => (to === "drop" || wasFaceUp[i] ? c.cardId : null)),
  });
  s.pending = null;
  // 21-2 : défaite immédiate si la Zone de Vie est vide.
  if (checkDefeat(s, events)) return null;
  battleEndStep(s, events);
  return null;
}

/** 8-4-7 à 8-5 : fin de l'étape des Dégâts, puis étape de Fin de Combat. */
export function battleEndStep(s: GameState, events: GameEvent[]): void {
  // 8-4-7 : capacités « Quand l'étape des Dégâts se termine ». 8-4-8 : point de contrôle.
  // 8-4-9 : passez à l'étape de Fin de Combat.
  s.battle!.step = "end";
  events.push({ type: "BATTLE_STEP", step: "end" });
  // 8-5-1 : point de contrôle. 8-5-2 : le joueur actif d'abord.
  askComboToZ(s, s.turnPlayer, events);
}

// ---------------------------------------------------------------------------
// 8-5 : étape de Fin de Combat
// ---------------------------------------------------------------------------

/** 8-5-2 / 8-5-3 : propose au joueur de placer une carte de Combo en Énergie Z (s'il en a). */
function askComboToZ(s: GameState, player: PlayerId, events: GameEvent[]): void {
  if (s.players[player].combo.length > 0) {
    s.pending = { type: "COMBO_TO_Z", player };
  } else if (player === s.turnPlayer) {
    askComboToZ(s, opponentOf(player), events);
  } else {
    finishBattle(s, events);
  }
}

export function comboToZEnergy(
  s: GameState,
  action: Extract<Action, { type: "COMBO_TO_Z_ENERGY" }>,
  events: GameEvent[],
): string | null {
  const p = s.players[action.player];
  if (action.uid !== null) {
    const index = p.combo.findIndex((c) => c.uid === action.uid);
    if (index < 0) return "8-5-2 : la carte doit être dans votre Zone de Combo";
    const [card] = p.combo.splice(index, 1);
    // Placée dans la Zone d'Énergie Z de son propriétaire.
    card!.mode = "active";
    card!.faceUp = true;
    s.players[card!.owner].zEnergy.push(card!);
    events.push({ type: "Z_ENERGY_PLACED", player: action.player, uid: card!.uid, cardId: card!.cardId });
  }
  if (action.player === s.turnPlayer) askComboToZ(s, opponentOf(action.player), events);
  else finishBattle(s, events);
  return null;
}

function finishBattle(s: GameState, events: GameEvent[]): void {
  // 8-5-4 : point de contrôle.
  // 8-5-5 : les augmentations de puissance des Combos disparaissent (elles ne sont calculées
  // qu'à l'étape des Dégâts dans ce moteur).
  // 8-5-6 / 8-5-7 : capacités « Quand une carte de votre Zone de Combo est placée dans votre Dispersion ».
  // 8-5-8 : toutes les cartes des Zones de Combo vont dans la Dispersion de leur propriétaire.
  for (const id of [s.turnPlayer, opponentOf(s.turnPlayer)]) {
    const cards = s.players[id].combo.splice(0);
    for (const c of cards) toDrop(s, c);
    if (cards.length > 0) events.push({ type: "COMBO_ZONE_CLEARED", player: id, count: cards.length });
  }
  // 8-5-9 / 8-5-10 : capacités « À la fin d'un combat » et capacités en attente.
  // 22-8-3 : [Réplique] / [Tri-offensive] en suspens : la carte repasse en mode Action. Elle se
  // résout même si la carte a perdu ses Capacités pendant le combat (décision du joueur).
  for (const auto of s.battle!.pendingAutos) {
    if (auto.kind !== "dual_attack") continue;
    const p = s.players[auto.card.player];
    const target = p.leader.uid === auto.card.uid ? p.leader : p.battle.find((c) => c.uid === auto.card.uid);
    if (!target) continue; // la carte a quitté le jeu : rien à relever
    s.turnUsage[auto.usageKey] = (s.turnUsage[auto.usageKey] ?? 0) + 1;
    if (target.mode === "rest" && !readyBlockedByEffect(s, auto.card.uid)) {
      target.mode = "active";
      events.push({ type: "CARD_READIED", player: auto.card.player, uid: auto.card.uid, reason: "dual_attack" });
    }
  }
  // 8-5-11 / 8-5-12 : fin des effets « pour tout le combat ».
  s.powerMods = s.powerMods.filter((m) => m.until !== "battle");
  s.effects = s.effects.filter((e) => !e.battleOnly);
  // 8-5-13 : le combat s'achève, retour à 7-3-3.
  events.push({ type: "BATTLE_ENDED" });
  backToMain(s);
}
