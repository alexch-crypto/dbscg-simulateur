// Effets du deck Freezer qui restaient « non gérés » : chaque carte est testée sur son effet.
import { describe, expect, it } from "vitest";
import { applyAction, buildCardDatabase, getLegalActions, parseCardFile, type Action, type GameContext, type GameState, type PlayerId } from "../src/engine";
import { powerOf } from "../src/engine/rules/battle";
import { ctx, freezer, give, newMirrorGame, p2Main, play } from "./helpers";

/** Le coup ACTIVATE proposé par le moteur pour une Capacité d'une carte. */
function activate(s: GameState, player: PlayerId, uid: string, index: number): Action {
  const a = getLegalActions(s, player, ctx).find((x) => x.type === "ACTIVATE" && x.uid === uid && x.index === index);
  if (!a) throw new Error(`ACTIVATE non proposé pour ${uid} #${index}`);
  return a;
}

function counter(s: GameState, player: PlayerId, uid: string): Action {
  const a = getLegalActions(s, player, ctx).find((x) => x.type === "DECLARE_COUNTER" && x.uid === uid);
  if (!a) throw new Error(`aucun contre proposé pour ${uid}`);
  return a;
}

/** Place une carte du deck Z d'un joueur directement dans une zone (préparation de scénario). */
function fromZDeck(s: GameState, player: PlayerId, cardId: string, zone: "battle" | "unison", markers?: number) {
  const p = s.players[player];
  const i = p.zDeck.findIndex((c) => c.cardId === cardId);
  const card = p.zDeck.splice(i, 1)[0]!;
  card.faceUp = true;
  card.mode = "active";
  if (markers !== undefined) card.markers = markers;
  p[zone].push(card);
  return card;
}

const attack = (player: PlayerId, attacker: string, target: string): Action => ({ type: "ATTACK", player, attacker, target });
const noImpl = (events: { type: string }[]) => events.filter((e) => e.type === "NOT_IMPLEMENTED");

describe("Boo, Malveillance pure et simple (BT14-082) : Contre : Attaque", () => {
  function setup() {
    const s = p2Main();
    const boo = give(s, "P1", "BT14-082", "hand");
    give(s, "P1", "P-223", "energy");
    give(s, "P1", "P-561", "energy");
    const attacker = give(s, "P2", "BT24-105", "battle");
    let r = play(s, attack("P2", "P2-L", "P1-L"));
    r = play(r.state, counter(r.state, "P1", boo.uid));
    return { r, boo, attacker };
  }

  it("annule l'attaque, joue Boo, puis fait défausser une carte de la main", () => {
    const { r, boo } = setup();
    expect(r.events).toContainEqual({ type: "ATTACK_NEGATED" });
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(boo.uid);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 1, max: 1 });
    expect(noImpl(r.events)).toEqual([]);
  });

  it("ensuite, chaque attaque de l'adversaire lui coûte deux cartes de sa main", () => {
    const { r: first, attacker } = setup();
    const discarded = (first.state.pending as { options: string[] }).options[0]!;
    let r = play(first.state, { type: "CHOOSE_CARDS", player: "P1", uids: [discarded] });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(discarded);
    expect(r.state.attackTaxes).toEqual([{ player: "P2", rule: "discard_2_per_attack", untilTurn: r.state.turnNumber }]);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
    const hand = r.state.players.P2.hand.length;
    r = play(r.state, attack("P2", attacker.uid, "P1-L"));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 2, max: 2 });
    const two = (r.state.pending as { options: string[] }).options.slice(0, 2);
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: two });
    expect(r.state.players.P2.hand).toHaveLength(hand - 2);
    expect(r.state.battle?.attacker.uid).toBe(attacker.uid);
  });

  it("avec moins de deux cartes en main, l'adversaire ne peut plus attaquer", () => {
    const { r: first, attacker } = setup();
    const discarded = (first.state.pending as { options: string[] }).options[0]!;
    const r = play(first.state, { type: "CHOOSE_CARDS", player: "P1", uids: [discarded] });
    r.state.players.P2.drop.push(...r.state.players.P2.hand.splice(1));
    expect(getLegalActions(r.state, "P2", ctx).some((a) => a.type === "ATTACK" && a.attacker === attacker.uid)).toBe(false);
  });
});

describe("Freezer, Activation de l'Overdrive (BT24-133) : taxe d'attaque", () => {
  it("l'adversaire doit passer une autre de ses cartes en mode Action en mode Inertie à chaque attaque", () => {
    const s = p2Main();
    s.attackTaxes.push({ player: "P1", rule: "rest_one_active_card_per_attack", untilTurn: s.turnNumber + 1 });
    let r = play(s, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null });
    const energy = give(r.state, "P1", "BT24-105", "energy");
    r = play(r.state, attack("P1", "P1-L", "P2-L"));
    // Choix : une carte en mode Action autre que l'attaquant (ici, la seule Énergie).
    expect(r.state.players.P1.leader.mode).toBe("rest");
    expect(r.state.players.P1.energy.find((c) => c.uid === energy.uid)!.mode).toBe("rest");
    expect(r.state.battle?.attacker.uid).toBe("P1-L");
  });

  it("sans autre carte en mode Action, l'attaque n'est pas possible", () => {
    const s = p2Main();
    s.attackTaxes.push({ player: "P1", rule: "rest_one_active_card_per_attack", untilTurn: s.turnNumber + 1 });
    const r = play(s, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null });
    expect(r.state.players.P1.energy.filter((c) => c.mode === "active")).toHaveLength(0);
    expect(getLegalActions(r.state, "P1", ctx).some((a) => a.type === "ATTACK")).toBe(false);
  });

  it("avec deux cartes possibles, le joueur choisit laquelle passer en mode Inertie", () => {
    const s = p2Main();
    s.attackTaxes.push({ player: "P1", rule: "rest_one_active_card_per_attack", untilTurn: s.turnNumber + 1 });
    let r = play(s, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null });
    const a = give(r.state, "P1", "BT24-105", "energy");
    const b = give(r.state, "P1", "P-223", "battle");
    r = play(r.state, attack("P1", "P1-L", "P2-L"));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 1, max: 1 });
    expect([...(r.state.pending as { options: string[] }).options].sort()).toEqual([a.uid, b.uid].sort());
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [b.uid] });
    expect(r.state.players.P1.battle.find((c) => c.uid === b.uid)!.mode).toBe("rest");
    expect(r.state.players.P1.energy.find((c) => c.uid === a.uid)!.mode).toBe("active");
  });
});

describe("Krillin, Désagrégation (BT24-068) : jouée dans la Zone de Combat adverse", () => {
  it("pioche, puis Krillin arrive en mode Inertie chez l'adversaire (il reste à son propriétaire)", () => {
    const s = p2Main();
    fromZDeck(s, "P2", "BT24-059", "unison", 2); // Unisson Z verte
    const krillin = give(s, "P2", "BT24-068", "hand");
    const hand = s.players.P2.hand.length;
    const r = play(s, activate(s, "P2", krillin.uid, 0));
    const placed = r.state.players.P1.battle.find((c) => c.uid === krillin.uid);
    expect(placed).toMatchObject({ owner: "P2", mode: "rest" });
    expect(r.state.players.P2.hand).toHaveLength(hand); // -Krillin +1 pioche
    expect(noImpl(r.events)).toEqual([]);
  });

  it("pas proposé si l'adversaire a une carte de Combat, ou sans Unisson Z verte", () => {
    const s = p2Main();
    const krillin = give(s, "P2", "BT24-068", "hand");
    const can = () => getLegalActions(s, "P2", ctx).some((a) => a.type === "ACTIVATE" && a.uid === krillin.uid);
    expect(can()).toBe(false);
    fromZDeck(s, "P2", "BT24-059", "unison", 2);
    expect(can()).toBe(true);
    give(s, "P1", "P-223", "battle");
    expect(can()).toBe(false);
  });

  it("mis KO chez l'adversaire, Krillin va dans la Dispersion de son propriétaire", () => {
    const s = p2Main();
    fromZDeck(s, "P2", "BT24-059", "unison", 2);
    const krillin = give(s, "P2", "BT24-068", "hand");
    const big = give(s, "P2", "BT24-134", "battle"); // 25 000 contre 15 000
    let r = play(s, activate(s, "P2", krillin.uid, 0));
    r = play(r.state, attack("P2", big.uid, krillin.uid));
    while (r.state.pending?.type === "COUNTER_WINDOW" || r.state.pending?.type === "OFFENSE" || r.state.pending?.type === "DEFENSE") {
      const p = r.state.pending;
      r = play(r.state, p.type === "COUNTER_WINDOW" ? { type: "PASS_COUNTER", player: p.player } : { type: "END_STEP", player: p.player });
    }
    expect(r.state.players.P1.battle.some((c) => c.uid === krillin.uid)).toBe(false);
    expect(r.state.players.P2.drop.map((c) => c.uid)).toContain(krillin.uid);
  });
});

describe("Clones meurtriers (EB1-037) : jeton Meda", () => {
  function withToken() {
    const s = p2Main();
    const clones = give(s, "P1", "EB1-037", "hand");
    give(s, "P1", "P-223", "energy");
    give(s, "P1", "P-561", "energy");
    let r = play(s, attack("P2", "P2-L", "P1-L"));
    r = play(r.state, counter(r.state, "P1", clones.uid));
    const token = r.state.players.P1.battle.find((c) => c.cardId === "EB1-037-JETON1")!;
    return { r, token };
  }

  it("le jeton a 5000 de puissance et [Bloqueur] pour le tour", () => {
    const { r, token } = withToken();
    expect(powerOf(r.state, { player: "P1", uid: token.uid }, ctx)).toBe(5000);
    expect(r.state.effects).toContainEqual({ uid: token.uid, kind: "grant_keyword", keyword: "blocker", untilTurn: r.state.turnNumber });
  });

  it("19-1-6-1 : un jeton sans coût n'est pas choisi par « coût de 5 ou moins » (Piccolo Daimaô)", () => {
    const { r: first, token } = withToken();
    const s = first.state;
    for (const id of ["P-223", "BT24-105", "BT24-106", "BT27-080"]) give(s, "P2", id, "energy");
    const piccolo = give(s, "P2", "P-561", "hand");
    const other = give(s, "P1", "BT24-105", "battle");
    const playAction = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === piccolo.uid)!;
    const r = play(s, playAction);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", options: [other.uid] });
    expect((r.state.pending as { options: string[] }).options).not.toContain(token.uid);
  });

  it("22-10-3-1 : un jeton est « joué » — l'adversaire peut répondre avec un [Contre : Mise en jeu]", () => {
    // Carte de test : « Activation : Principale — Jouez 1 jeton Meda. »
    const extra = parseCardFile({
      cards: [
        {
          id: "TEST-TOKEN",
          type: "battle",
          name: "Créateur de jeton",
          colors: ["green"],
          cost: { total: 1, specified: {} },
          power: 5000,
          combo: { cost: 0, power: 5000 },
          abilities: [
            {
              kind: "activate",
              timing: "main",
              effect: [{ do: "create_token", token: { name: "Jeton Meda", power: 5000, combo: { cost: 0, power: 5000 } }, count: 1 }],
              text: "Activation : Principale — Jouez 1 jeton Meda.",
            },
          ],
        },
      ],
    });
    const testCtx: GameContext = { cards: buildCardDatabase([freezer.cards, extra.cards]) };
    const s = p2Main();
    s.players.P2.battle.push({ uid: "P2-TT", cardId: "TEST-TOKEN", owner: "P2", mode: "active", faceUp: true });
    // P1 a Méchant charismatique en main et de quoi le payer (coût 5).
    const mechant = give(s, "P1", "BT10-075", "hand");
    for (const id of ["P-223", "BT24-105", "BT24-106", "BT27-080", "BT9-123"]) give(s, "P1", id, "energy");
    const victim = give(s, "P2", "BT24-105", "battle");
    const step = (st: GameState, a: Action) => {
      const r = applyAction(st, a, testCtx);
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    const activation = getLegalActions(s, "P2", testCtx).find((a) => a.type === "ACTIVATE" && a.uid === "P2-TT")!;
    let r = step(s, activation);
    const token = r.state.players.P2.battle.find((c) => c.cardId === "TEST-TOKEN-JETON1")!;
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "play" });
    expect(r.state.counterWindow?.event).toMatchObject({ on: "play", cardUid: token.uid });
    // P1 joue Méchant charismatique et met KO une AUTRE carte (le jeton n'a pas de coût, 19-1-6-1).
    const declare = getLegalActions(r.state, "P1", testCtx).find((a) => a.type === "DECLARE_COUNTER" && a.uid === mechant.uid)!;
    r = step(r.state, declare);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1" });
    const options = (r.state.pending as { options: string[] }).options;
    expect(options).toContain(victim.uid);
    expect(options).not.toContain(token.uid);
    r = step(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [victim.uid] });
    expect(r.state.players.P2.drop.map((c) => c.uid)).toContain(victim.uid);
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(token.uid);
  });

  it("19-1-7 : mis KO, le jeton est retiré de la partie (pas de Dispersion)", () => {
    const { r: first, token } = withToken();
    const s = first.state;
    token.mode = "rest";
    const attacker = give(s, "P2", "BT24-134", "battle");
    let r = play(s, attack("P2", attacker.uid, token.uid));
    while (r.state.battle) {
      const p = r.state.pending!;
      if (p.type === "COUNTER_WINDOW") r = play(r.state, { type: "PASS_COUNTER", player: p.player });
      else if (p.type === "BLOCKER") r = play(r.state, { type: "DECLARE_BLOCKER", player: p.player, uid: null });
      else if (p.type === "COMBO_TO_Z") r = play(r.state, { type: "COMBO_TO_Z_ENERGY", player: p.player, uid: null });
      else r = play(r.state, { type: "END_STEP", player: p.player });
    }
    expect(r.state.players.P1.battle.some((c) => c.uid === token.uid)).toBe(false);
    expect(r.state.players.P1.drop.some((c) => c.uid === token.uid)).toBe(false);
    expect(r.state.players.P1.removed.some((c) => c.uid === token.uid)).toBe(false);
  });
});

/** P2 attaque le Leader adverse avec son Leader et arrive à son étape d'Attaque. */
function toOffense(s: GameState): GameState {
  let r = play(s, attack("P2", "P2-L", "P1-L"));
  while (r.state.pending?.type !== "OFFENSE") {
    const p = r.state.pending!;
    if (p.type === "COUNTER_WINDOW") r = play(r.state, { type: "PASS_COUNTER", player: p.player });
    else if (p.type === "BLOCKER") r = play(r.state, { type: "DECLARE_BLOCKER", player: p.player, uid: null });
    else throw new Error(`inattendu : ${JSON.stringify(p)}`);
  }
  return r.state;
}

describe("Leader Freezer, Fléau des Saiyans (verso) : Combo depuis la main", () => {
  it("Boost d'Esprit 1 : une carte vert-jaune de coût de Combo 1 va en Combo sans payer, Capacités annulées", () => {
    const s = p2Main();
    s.players.P2.leader.side = "back";
    const cooler = fromZDeck(s, "P2", "BT24-059", "unison", 2);
    const card = give(s, "P2", "BT24-136", "hand");
    give(s, "P2", "BT24-105", "hand"); // jaune seulement : pas proposée
    let st = toOffense(s);
    let r = play(st, activate(st, "P2", "P2-L", 2));
    expect(r.state.players.P2.unison[0]).toMatchObject({ uid: cooler.uid, markers: 1 });
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 0, max: 1 });
    const options = (r.state.pending as { options: string[] }).options;
    expect(options).toContain(card.uid);
    // Seulement des cartes multicolores vert-jaune avec un coût de Combo de 1.
    for (const uid of options) {
      const def = ctx.cards.get(r.state.players.P2.hand.find((c) => c.uid === uid)!.cardId)!;
      expect([[...def.colors].sort(), def.combo?.cost]).toEqual([["green", "yellow"], 1]);
    }
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [card.uid] });
    expect(r.state.players.P2.combo.map((c) => c.uid)).toEqual([card.uid]);
    expect(r.state.effects).toContainEqual({ uid: card.uid, kind: "negate_all", untilTurn: r.state.turnNumber });
    // Aucun coût de Combo payé (5-7-3-1) et retour à l'étape d'Attaque.
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
    expect(noImpl(r.events)).toEqual([]);
    st = r.state;
  });
});

describe("Pan, en Soutien (BT29-107)", () => {
  it("Combo depuis la Dispersion, Capacités annulées pour le tour", () => {
    const s = p2Main();
    const pan = fromZDeck(s, "P2", "BT29-107", "battle");
    const inDrop = give(s, "P2", "SD8-04", "hand");
    s.players.P2.hand.splice(s.players.P2.hand.indexOf(inDrop), 1);
    s.players.P2.drop.push(inDrop);
    const st = toOffense(s);
    let r = play(st, activate(st, "P2", pan.uid, 1));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2" });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [inDrop.uid] });
    expect(r.state.players.P2.combo.map((c) => c.uid)).toEqual([inDrop.uid]);
    // Paragus utilisé pour une Combo : ses Capacités sont annulées, son [Auto.] ne se déclenche pas.
    expect(r.events.some((e) => e.type === "AUTO_TRIGGERED")).toBe(false);
  });

  it("« Passez une carte en mode Révélé » : aucune carte en mode Caché, rien ne change", () => {
    const s = p2Main();
    give(s, "P2", "BT24-105", "energy");
    const z = s.players.P2.deck.splice(0, 1)[0]!;
    s.players.P2.zEnergy.push(z);
    const pan = s.players.P2.zDeck.find((c) => c.cardId === "BT29-107")!;
    const action = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_Z" && a.uid === pan.uid)!;
    let r = play(s, action);
    while (r.state.pending?.type === "COUNTER_WINDOW") r = play(r.state, { type: "PASS_COUNTER", player: r.state.pending.player });
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(pan.uid);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "EFFECT_NOTE", cardId: "BT29-107" }));
    expect(noImpl(r.events)).toEqual([]);
  });
});

describe("Oolong, Cupidité avouée (P-405) : la puissance devient celle de la carte choisie", () => {
  it("jusqu'au début du tour adverse", () => {
    const s = p2Main();
    const oolong = fromZDeck(s, "P2", "P-405", "battle");
    const big = give(s, "P1", "BT24-134", "battle");
    let r = play(s, activate(s, "P2", oolong.uid, 0));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2" });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [big.uid] });
    expect(powerOf(r.state, { player: "P2", uid: oolong.uid }, ctx)).toBe(25000);
    expect(noImpl(r.events)).toEqual([]);
    r = play(r.state, { type: "END_MAIN_PHASE", player: "P2" });
    expect(powerOf(r.state, { player: "P2", uid: oolong.uid }, ctx)).toBe(4000);
  });
});

describe("Météore gigantesque de Destruction (BT22-060) : effet retardé", () => {
  it("+10000 pour le combat ; quand une carte de Combat adverse est mise KO via le combat, l'adversaire défausse", () => {
    const s = p2Main();
    const meteor = fromZDeck(s, "P2", "BT22-060", "battle");
    const target = give(s, "P1", "BT24-134", "battle", "rest"); // 25 000
    let r = play(s, attack("P2", "P2-L", target.uid));
    while (r.state.pending?.type !== "OFFENSE") {
      const p = r.state.pending!;
      r = play(r.state, p.type === "COUNTER_WINDOW" ? { type: "PASS_COUNTER", player: p.player } : { type: "DECLARE_BLOCKER", player: p.player, uid: null });
    }
    r = play(r.state, activate(r.state, "P2", meteor.uid, 0));
    expect(r.state.players.P2.removed.map((c) => c.uid)).toContain(meteor.uid);
    // Jusqu'à une de vos cartes : le Leader (10000 → 20000), puis 2 x Combo n'est pas nécessaire.
    if (r.state.pending?.type === "CHOOSE_CARDS") r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: ["P2-L"] });
    expect(powerOf(r.state, { player: "P2", uid: "P2-L" }, ctx)).toBe(20000);
    // Combo de P2 pour dépasser 25 000.
    const comboCard = give(r.state, "P2", "P-223", "hand");
    give(r.state, "P2", "BT24-105", "energy");
    r = play(r.state, getLegalActions(r.state, "P2", ctx).find((a) => a.type === "COMBO" && a.uid === comboCard.uid)!);
    r = play(r.state, { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(target.uid);
    // L'effet retardé : P1 choisit une carte de sa main et la défausse.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 1, max: 1 });
  });
});

describe("Freezer, Méchant charismatique (BT10-075) : restriction de coût", () => {
  it("« vous ne pouvez pas activer les Contre : Mise en jeu des autres cartes » ce tour", () => {
    const s = p2Main();
    const soif = give(s, "P1", "BT1-107", "hand");
    give(s, "P1", "BT24-105", "energy"); // jaune
    s.restrictions.push({ player: "P1", rule: "no_other_counter_play", uid: "autre", fromTurn: s.turnNumber, untilTurn: s.turnNumber });
    for (const id of ["BT9-123", "BT24-106", "P-561"]) give(s, "P2", id, "energy");
    const played = give(s, "P2", "BT24-068", "hand");
    const action = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === played.uid)!;
    const r = applyAction(s, action, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mode « seulement si jouable » : sans contre autorisé, la fenêtre se ferme toute seule.
    expect(r.state.pending?.type).not.toBe("COUNTER_WINDOW");
    expect(r.state.players.P1.hand.map((c) => c.uid)).toContain(soif.uid);
  });
});

describe("Oolong, Désir immédiat (BT25-141) : [-7] pioches adverses remplacées", () => {
  it("au tour suivant de l'adversaire, sa pioche via une Capacité est remplacée", () => {
    const s = p2Main();
    const oolong = fromZDeck(s, "P2", "BT25-141", "unison", 7);
    let r = play(s, activate(s, "P2", oolong.uid, 2));
    expect(r.state.drawReplacements).toHaveLength(1);
    expect(r.state.restrictions).toContainEqual(expect.objectContaining({ player: "P2", rule: "no_activate_copies", cardId: "BT25-141" }));
    r = play(r.state, { type: "END_MAIN_PHASE", player: "P2" }, { type: "CHARGE_ENERGY", player: "P1", uid: null });
    // P1 a pioché normalement en début de tour (pioche de règle, pas remplacée).
    const st = r.state;
    give(st, "P1", "BT24-105", "energy");
    give(st, "P1", "P-223", "energy");
    const freezer = give(st, "P1", "BT24-105", "hand");
    const dropped = give(st, "P1", "BT27-076", "hand");
    st.players.P1.hand.splice(st.players.P1.hand.indexOf(dropped), 1);
    st.players.P1.drop.push(dropped);
    const hand = st.players.P1.hand.length;
    r = play(st, activate(st, "P1", freezer.uid, 1));
    // P2 choisit jusqu'à une carte de Combat de la Dispersion de P1 à placer sur son deck.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P2", min: 0, max: 1, options: [dropped.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P2", uids: [dropped.uid] });
    expect(r.state.players.P1.deck[0]!.uid).toBe(dropped.uid);
    // Freezer a quitté la main, rien n'a été pioché.
    expect(r.state.players.P1.hand).toHaveLength(hand - 1);
  });
});

describe("Freezer, Transformation effroyable (BT27-076) : « placez sous un {Le Pire Clan Existant} »", () => {
  it("sans cette carte en jeu, rien n'est placé et rien n'est signalé comme non géré", () => {
    const s = p2Main();
    for (const id of ["BT24-105", "BT24-106", "P-223"]) give(s, "P2", id, "energy");
    const freezer = give(s, "P2", "BT27-076", "hand");
    const r = play(s, activate(s, "P2", freezer.uid, 1));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(freezer.uid);
    expect(noImpl(r.events)).toEqual([]);
  });
});

describe("Audit : parties au hasard avec le deck Freezer complet", () => {
  it("aucun effet n'est jamais signalé « non géré » (150 parties)", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 150; seed++) {
      let s = newMirrorGame(seed);
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 800 && !s.result; move++) {
        let legal = getLegalActions(s, s.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
        // On favorise les coups qui font quelque chose (jouer, activer, attaquer...).
        const rich = legal.filter((a) => !["END_MAIN_PHASE", "END_STEP", "PASS_COUNTER"].includes(a.type));
        if (rich.length > 0 && pick(4) > 0) legal = rich;
        const action = legal[pick(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        for (const e of r.events) if (e.type === "NOT_IMPLEMENTED") seen.add(`${e.cardId} : ${e.what}`);
        s = r.state;
      }
    }
    expect([...seen]).toEqual([]);
  });
});
