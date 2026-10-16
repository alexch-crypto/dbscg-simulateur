// Liste des coups autorisés pour un joueur. L'interface s'en servira pour afficher
// les boutons, et une IA pourra s'en servir pour choisir un coup.
//
// Pour jouer une carte, il existe souvent plusieurs façons de payer : la liste propose
// UNE façon valide (paiement suggéré). Le joueur peut en envoyer une autre, applyAction
// vérifiera qu'elle est correcte.

import type { Action, GameContext } from "./protocol";
import {
  comboCandidates,
  lifeCardsToChoose,
  possibleAttackers,
  possibleBlockers,
  possibleTargets,
  suggestComboPayment,
} from "./rules/battle";
import { activatableAbilities, suggestActivationPayment } from "./rules/activate";
import { exactSubsets, overRealmOptions, successorOptions, suggestPayment } from "./rules/alt-play";
import { awakenBlocker } from "./rules/awaken";
import { suggestZPayment, zAwakenOptions, zPlayOptions } from "./rules/zdeck";
import { counterOptions, suggestCounterPayment } from "./rules/counters";
import { availableEnergySources, findPayment } from "./rules/energy";
import { uniqueBlocks } from "./rules/keywords";
import { normalPlayPayment } from "./rules/play";
import { PLAYER_IDS, type GameState, type PlayerId } from "./state/types";

/** Toutes les façons de choisir `k` positions parmi `n` (ordre croissant). */
function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === k) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i < n; i++) pick(i + 1, [...chosen, i]);
  };
  pick(0, []);
  return result;
}

export function getLegalActions(s: GameState, player: PlayerId, ctx: GameContext): Action[] {
  if (s.result) return [];
  const actions: Action[] = [];
  const pending = s.pending;

  // [Éveil Z] : pendant son tour (phase principale, étape d'Attaque).
  for (const z of zAwakenOptions(s, player, ctx)) {
    actions.push({ type: "Z_AWAKEN", player, uid: z.uid, ...suggestZPayment(s, player, z.payment, z.zCost, ctx) });
  }
  // 9-4 : Capacités [Activation] activables maintenant (phase principale, étapes d'Attaque/Défense).
  for (const a of activatableAbilities(s, player, ctx)) {
    const payment = suggestActivationPayment(s, player, a, ctx);
    if (a.declare) {
      for (let x = a.declare.min; x <= a.declare.max; x++) actions.push({ type: "ACTIVATE", player, uid: a.uid, index: a.index, payment, x });
    } else {
      actions.push({ type: "ACTIVATE", player, uid: a.uid, index: a.index, payment });
    }
  }

  if (pending && pending.player === player) {
    switch (pending.type) {
      case "CHOOSE_FIRST_PLAYER":
        for (const first of PLAYER_IDS) actions.push({ type: "CHOOSE_FIRST_PLAYER", player, first });
        break;
      case "MULLIGAN":
        actions.push({ type: "MULLIGAN", player, redraw: false }, { type: "MULLIGAN", player, redraw: true });
        break;
      case "CHARGE":
        actions.push({ type: "CHARGE_ENERGY", player, uid: null });
        for (const c of s.players[player].hand) actions.push({ type: "CHARGE_ENERGY", player, uid: c.uid });
        break;
      case "MAIN": {
        const sources = availableEnergySources(s, player, ctx.cards);
        for (const c of s.players[player].hand) {
          const card = ctx.cards.get(c.cardId);
          if (card?.type !== "battle") continue;
          if (uniqueBlocks(s, c, ctx.cards)) continue; // 22-39
          const payment = normalPlayPayment(s, player, c, ctx);
          const chosen = payment && findPayment(sources, payment);
          if (!chosen) continue; // 5-3-3 : coût impossible à payer.
          actions.push({
            type: "PLAY_CARD",
            player,
            uid: c.uid,
            payment: {
              energy: chosen.filter((src) => src.id !== "marker").map((src) => src.id),
              markers: chosen.filter((src) => src.id === "marker").length,
            },
          });
        }
        for (const attacker of possibleAttackers(s, player, ctx)) {
          for (const target of possibleTargets(s, player, ctx)) actions.push({ type: "ATTACK", player, attacker, target });
        }
        if (!awakenBlocker(s, player, ctx)) actions.push({ type: "AWAKEN", player });
        // 22-38 : [Successeur] — quelques combinaisons exactes de cartes à sacrifier.
        for (const option of successorOptions(s, player, ctx)) {
          const variant = option.energyVariants.findIndex((v) => suggestPayment(s, player, v, ctx));
          const payment = suggestPayment(s, player, option.energyVariants[variant]!, ctx)!;
          for (const sacrifice of exactSubsets(option.pool, option.target)) {
            actions.push({ type: "SUCCESSOR", player, uid: option.uid, sacrifice, payment, variant });
          }
        }
        // 14-18 : cartes du deck Z (une action par valeur de X pour les Unissons).
        for (const z of zPlayOptions(s, player, ctx)) {
          for (const { x, payment } of z.payments) {
            actions.push({ type: "PLAY_Z", player, uid: z.uid, ...suggestZPayment(s, player, payment, z.zCost, ctx), ...(x !== undefined ? { x } : {}) });
          }
        }
        // 22-15 : [Espace-temps].
        for (const card of overRealmOptions(s, player, ctx)) actions.push({ type: "OVER_REALM", player, uid: card.uid });
        actions.push({ type: "END_MAIN_PHASE", player });
        break;
      }
      case "BLOCKER":
        actions.push({ type: "DECLARE_BLOCKER", player, uid: null });
        for (const uid of possibleBlockers(s, ctx)) actions.push({ type: "DECLARE_BLOCKER", player, uid });
        break;
      case "OFFENSE":
      case "DEFENSE":
        for (const { card } of comboCandidates(s, player, ctx)) {
          const payment = suggestComboPayment(s, player, card, ctx);
          if (payment) actions.push({ type: "COMBO", player, uid: card.uid, payment });
        }
        if (!awakenBlocker(s, player, ctx)) actions.push({ type: "AWAKEN", player });
        actions.push({ type: "END_STEP", player });
        break;
      case "CHOOSE_LIFE": {
        const n = s.players[player].life.length;
        for (let k = pending.min; k <= pending.max; k++) {
          for (const indices of combinations(n, k)) actions.push({ type: "CHOOSE_LIFE", player, indices });
        }
        break;
      }
      case "CHOOSE_AUTO":
        for (const option of pending.options) actions.push({ type: "CHOOSE_AUTO", player, id: option.id });
        break;
      case "COUNTER_WINDOW":
        actions.push({ type: "PASS_COUNTER", player });
        for (const option of counterOptions(s, player, pending.on, ctx)) {
          actions.push({
            type: "DECLARE_COUNTER",
            player,
            uid: option.uid,
            alt: option.alt,
            payment: suggestCounterPayment(s, player, option, ctx),
          });
        }
        break;
      case "CHOOSE_OPTION":
        for (const option of pending.options) actions.push({ type: "CHOOSE_OPTION", player, id: option.id });
        break;
      case "CHOOSE_BLIND": {
        const n = s.players[pending.owner].hand.length;
        // Les positions n'apportent aucune information : on propose « les k premières ».
        for (let k = pending.min; k <= pending.max; k++) {
          actions.push({ type: "CHOOSE_BLIND", player, indices: [...Array(k).keys()].filter((i) => i < n) });
        }
        break;
      }
      case "CHOOSE_CARDS": {
        // Choix possibles : aucune carte (si permis), chaque carte seule, et les `max` premières.
        // (Toutes les combinaisons seraient trop nombreuses ; tout choix valide reste accepté.)
        if (pending.min === 0) actions.push({ type: "CHOOSE_CARDS", player, uids: [] });
        if (pending.min <= 1) for (const uid of pending.options) actions.push({ type: "CHOOSE_CARDS", player, uids: [uid] });
        // Avec une limite de coût total (20-6), on ne propose que les choix d'une carte.
        if (pending.max > 1 && pending.maxTotalCost === undefined) {
          actions.push({ type: "CHOOSE_CARDS", player, uids: pending.options.slice(0, pending.max) });
        }
        break;
      }
      case "TAKE_DAMAGE": {
        // Toutes les combinaisons de positions (au plus 70 pour 4 cartes parmi 8).
        const count = lifeCardsToChoose(s, player, pending.amount);
        for (const indices of combinations(s.players[player].life.length, count)) {
          actions.push({ type: "TAKE_LIFE", player, indices });
        }
        break;
      }
      case "COMBO_TO_Z":
        actions.push({ type: "COMBO_TO_Z_ENERGY", player, uid: null });
        for (const c of s.players[player].combo) actions.push({ type: "COMBO_TO_Z_ENERGY", player, uid: c.uid });
        break;
    }
  }

  // 0-1-3-4 : l'abandon est toujours possible.
  actions.push({ type: "CONCEDE", player });
  return actions;
}
