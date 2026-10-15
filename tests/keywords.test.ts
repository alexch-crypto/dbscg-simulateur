import { describe, expect, it } from "vitest";
import {
  applyAction,
  buildCardDatabase,
  getLegalActions,
  parseCardFile,
  validateDeck,
  type Action,
  type GameState,
  type PlayerId,
} from "../src/engine";
import { ctx, db, expectRefused, freezer, give, p2Main, play, startedMirrorGame } from "./helpers";

// Cartes du deck Freezer utilisées :
//  BT24-136 Second Changement de Forme : 20 000, [Double Frappe]
//  BT24-134 Phase de Transformation finale : 25 000, [Coup Critique] [Réplique]
//  BT24-133 Activation de l'Overdrive : 30 000, [Double Frappe] [Réplique] [Fuite d'énergie]
//  P-561 Piccolo Daimaô : 20 000, [Unique] [Coup Critique]
//  BT9-137 Cell Xeno : 40 000, [Ultimate]
//  BT9-123 Anilaza : [Fuite d'énergie]
//  SD8-04 Paragus : Combo +10 000, [Super Combo]

const attack = (attacker: string, target: string, player: PlayerId = "P2"): Action => ({ type: "ATTACK", player, attacker, target });
const endStep = (player: PlayerId): Action => ({ type: "END_STEP", player });
const takeLife = (indices: number[], player: PlayerId = "P1"): Action => ({ type: "TAKE_LIFE", player, indices });

/** P2 attaque le Leader de P1 avec `uid`, sans Combo : on arrive au choix des dégâts. */
const toDamage = (s: GameState, uid: string) => play(s, attack(uid, "P1-L"), endStep("P2"), endStep("P1")).state;

describe("22-7 : [Double Frappe]", () => {
  it("inflige 2 dégâts : le défenseur choisit ses 2 cartes de Vie en même temps", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-136", "battle");
    const damage = play(s, attack(freezer.uid, "P1-L"), endStep("P2"), endStep("P1"));
    expect(damage.events).toContainEqual({ type: "DAMAGE_DEALT", player: "P1", amount: 2, critical: false });
    const st = damage.state;
    expect(st.pending).toEqual({ type: "TAKE_DAMAGE", player: "P1", amount: 2, critical: false });
    const handBefore = st.players.P1.hand.length;
    const chosen = [st.players.P1.life[1]!.uid, st.players.P1.life[6]!.uid];
    const { state, events } = play(st, takeLife([6, 1])); // l'ordre des positions n'a pas d'importance
    expect(state.players.P1.life).toHaveLength(6);
    expect(state.players.P1.hand).toHaveLength(handBefore + 2);
    expect(state.players.P1.hand.slice(-2).map((c) => c.uid)).toEqual(chosen);
    expect(events).toContainEqual({ type: "LIFE_LOST", player: "P1", indices: [1, 6], to: "hand", cardIds: [null, null] });
  });

  it("il faut choisir exactement 2 cartes différentes", () => {
    const s = p2Main();
    const st = toDamage(s, give(s, "P2", "BT24-136", "battle").uid);
    expectRefused(st, takeLife([0]), "choisissez 2 carte(s)");
    expectRefused(st, takeLife([3, 3]), "deux fois");
  });

  it("coups proposés : toutes les paires de positions (28 pour 8 cartes de Vie)", () => {
    const s = p2Main();
    const st = toDamage(s, give(s, "P2", "BT24-136", "battle").uid);
    expect(getLegalActions(st, "P1", ctx).filter((a) => a.type === "TAKE_LIFE")).toHaveLength(28);
  });

  it("avec 1 seule carte de Vie, le défenseur la perd et perd la partie", () => {
    const s = p2Main();
    s.players.P1.hand.push(...s.players.P1.life.splice(1));
    const st = toDamage(s, give(s, "P2", "BT24-136", "battle").uid);
    expectRefused(st, takeLife([0, 1]), "choisissez 1 carte(s)");
    const { state } = play(st, takeLife([0]));
    expect(state.result).toMatchObject({ kind: "win", winner: "P2" });
  });

  it("une attaque sans Frappe inflige toujours 1 dégât", () => {
    const s = p2Main();
    const st = toDamage(s, "P2-L");
    expect(st.pending).toMatchObject({ type: "TAKE_DAMAGE", amount: 1 });
  });

  it("contre une carte de Combat, la Frappe ne change rien : la carte est mise KO", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-136", "battle");
    const target = give(s, "P1", "BT24-105", "battle", "rest");
    const { state } = play(s, attack(freezer.uid, target.uid), endStep("P2"), endStep("P1"));
    expect(state.players.P1.drop.map((c) => c.uid)).toContain(target.uid);
    expect(state.players.P1.life).toHaveLength(8);
  });
});

describe("22-6 : [Coup Critique]", () => {
  it("le défenseur choisit sa carte de Vie, qui va en Dispersion au lieu de la main", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-134", "battle");
    const st = toDamage(s, freezer.uid);
    expect(st.pending).toEqual({ type: "TAKE_DAMAGE", player: "P1", amount: 1, critical: true });
    const chosen = st.players.P1.life[2]!;
    const handBefore = st.players.P1.hand.length;
    const { state, events } = play(st, takeLife([2]));
    expect(state.players.P1.hand).toHaveLength(handBefore);
    expect(state.players.P1.drop.map((c) => c.uid)).toEqual([chosen.uid]);
    // La Dispersion est publique : la carte est révélée.
    expect(events).toContainEqual({ type: "LIFE_LOST", player: "P1", indices: [2], to: "drop", cardIds: [chosen.cardId] });
  });

  it("Coup Critique + Double Frappe : 2 cartes de Vie, toutes en Dispersion", () => {
    // Aucune carte du deck n'a les deux : on donne [Coup Critique] à l'Overdrive (Double Frappe) pour ce test.
    const overdriveDef = db.get("BT24-133")!;
    const customCtx = {
      cards: new Map(db).set("BT24-133", { ...overdriveDef, keywords: [...overdriveDef.keywords, { id: "critical" }] }),
    };
    const s = p2Main();
    const overdrive = give(s, "P2", "BT24-133", "battle");
    let st = s;
    for (const a of [attack(overdrive.uid, "P1-L"), endStep("P2"), endStep("P1"), takeLife([0, 1])]) {
      const r = applyAction(st, a, customCtx);
      if (!r.ok) throw new Error(r.error);
      st = r.state;
    }
    expect(st.players.P1.life).toHaveLength(6);
    expect(st.players.P1.drop).toHaveLength(2);
  });
});

describe("22-8 : [Réplique]", () => {
  /** Joue un combat complet : P1 prend ses dégâts en première position, personne ne met d'Énergie Z. */
  function fullBattle(s: GameState, a: Action): GameState {
    let st = play(s, a).state;
    for (let guard = 0; st.pending && st.pending.type !== "MAIN" && guard < 20; guard++) {
      const p = st.pending;
      const next: Action =
        p.type === "BLOCKER" ? { type: "DECLARE_BLOCKER", player: p.player, uid: null }
        : p.type === "TAKE_DAMAGE"
          ? takeLife([...Array(Math.min(p.amount, st.players[p.player].life.length)).keys()], p.player)
        : p.type === "COMBO_TO_Z" ? { type: "COMBO_TO_Z_ENERGY", player: p.player, uid: null }
        : endStep(p.player);
      st = play(st, next).state;
    }
    return st;
  }

  it("après son premier combat du tour, la carte repasse en mode Action et peut attaquer à nouveau", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-134", "battle");
    let st = fullBattle(s, attack(freezer.uid, "P1-L"));
    expect(st.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("active");
    // Deuxième attaque : possible.
    st = fullBattle(st, attack(freezer.uid, "P1-L"));
    // Après le deuxième combat, elle reste en mode Inertie (Réplique : X-1 = 1 fois par tour).
    expect(st.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("rest");
    expectRefused(st, attack(freezer.uid, "P1-L"), "mode Action");
    expect(st.players.P1.life).toHaveLength(6);
  });

  it("la carte se relève à la toute fin du combat, APRÈS le choix de l'Énergie Z", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-134", "battle");
    const helper = give(s, "P2", "P-223", "hand");
    let st = play(
      s,
      attack(freezer.uid, "P1-L"),
      { type: "COMBO", player: "P2", uid: helper.uid, payment: { energy: [], markers: 0 } },
      endStep("P2"),
      endStep("P1"),
      takeLife([0]),
    ).state;
    expect(st.pending).toEqual({ type: "COMBO_TO_Z", player: "P2" });
    expect(st.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("rest"); // pas encore relevée
    const r = play(st, { type: "COMBO_TO_Z_ENERGY", player: "P2", uid: null });
    expect(r.state.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("active");
    const types = r.events.map((e) => e.type);
    expect(types.indexOf("COMBO_ZONE_CLEARED")).toBeLessThan(types.indexOf("CARD_READIED"));
    expect(types.indexOf("CARD_READIED")).toBeLessThan(types.indexOf("BATTLE_ENDED"));
  });

  it("la Réplique en attente se résout même si l'attaque échoue", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-134", "battle"); // 25 000
    const paragus1 = give(s, "P1", "SD8-04", "hand"); // +10 000
    const paragus2 = give(s, "P1", "SD8-04", "hand"); // +10 000 => 30 000 en défense
    const free = { energy: [] as string[], markers: 0 };
    const st = play(
      s,
      attack(freezer.uid, "P1-L"),
      endStep("P2"),
      { type: "COMBO", player: "P1", uid: paragus1.uid, payment: free },
      { type: "COMBO", player: "P1", uid: paragus2.uid, payment: free },
    ).state;
    const end = fullBattle(st, endStep("P1"));
    expect(end.players.P1.life).toHaveLength(8); // 25 000 contre 30 000 : pas de dégâts
    expect(end.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("active");
  });

  it("le compteur de Réplique repart à zéro au tour suivant", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-134", "battle");
    let st = fullBattle(fullBattle(s, attack(freezer.uid, "P1-L")), attack(freezer.uid, "P1-L"));
    expect(Object.keys(st.turnUsage)).toContain(`dual_attack:${freezer.uid}`);
    st = play(st, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(st.turnUsage).toEqual({});
  });

  it("une carte sans Réplique reste en mode Inertie après avoir attaqué", () => {
    const s = p2Main();
    const freezer = give(s, "P2", "BT24-136", "battle");
    const st = fullBattle(s, attack(freezer.uid, "P1-L"));
    expect(st.players.P2.battle.find((c) => c.uid === freezer.uid)!.mode).toBe("rest");
  });
});

describe("22-31 : [Fuite d'énergie]", () => {
  it("une carte avec Fuite d'énergie arrive en Énergie en mode Inertie", () => {
    const s = startedMirrorGame();
    const anilaza = give(s, "P1", "BT9-123", "hand");
    const { state, events } = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: anilaza.uid });
    expect(state.players.P1.energy[0]!.mode).toBe("rest");
    expect(events).toContainEqual({ type: "ENERGY_CHARGED", player: "P1", uid: anilaza.uid, cardId: "BT9-123", mode: "rest" });
  });

  it("elle ne peut donc pas payer ce tour-ci, mais se relève au tour suivant", () => {
    let s = startedMirrorGame();
    const anilaza = give(s, "P1", "BT9-123", "hand");
    s = play(s, { type: "CHARGE_ENERGY", player: "P1", uid: anilaza.uid }, { type: "END_MAIN_PHASE", player: "P1" }).state;
    s = play(s, { type: "CHARGE_ENERGY", player: "P2", uid: null }, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(s.players.P1.energy[0]!.mode).toBe("active"); // 7-2-7
  });
});

describe("22-39 : [Unique]", () => {
  it("impossible de jouer un deuxième Piccolo Daimaô quand un Piccolo [Unique] est dans sa Zone de Combat", () => {
    const s = p2Main();
    give(s, "P2", "P-561", "battle");
    const second = give(s, "P2", "P-561", "hand");
    const energy = [0, 1, 2, 3].map(() => give(s, "P2", "BT9-123", "energy"));
    expectRefused(
      s,
      { type: "PLAY_CARD", player: "P2", uid: second.uid, payment: { energy: energy.map((e) => e.uid), markers: 0 } },
      "22-39",
    );
    const plays = getLegalActions(s, "P2", ctx).filter((a) => a.type === "PLAY_CARD" && a.uid === second.uid);
    expect(plays).toEqual([]);
  });

  it("le Piccolo de l'adversaire ne gêne pas", () => {
    const s = p2Main();
    give(s, "P1", "P-561", "battle");
    const mine = give(s, "P2", "P-561", "hand");
    const energy = [0, 1, 2, 3].map(() => give(s, "P2", "BT9-123", "energy"));
    const r = play(s, { type: "PLAY_CARD", player: "P2", uid: mine.uid, payment: { energy: energy.map((e) => e.uid), markers: 0 } });
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(mine.uid);
  });
});

describe("22-14 : [Ultimate]", () => {
  it("Cell Xeno mis KO en combat est retiré de la partie au lieu d'aller en Dispersion", () => {
    const s = p2Main();
    const cell = give(s, "P1", "BT9-137", "battle", "rest"); // 40 000
    const emperor = give(s, "P2", "BT27-136", "battle"); // 30 000
    const paragus = give(s, "P2", "SD8-04", "hand"); // +10 000 => 40 000 : égalité, l'attaquant gagne
    const { state, events } = play(
      s,
      attack(emperor.uid, cell.uid),
      { type: "COMBO", player: "P2", uid: paragus.uid, payment: { energy: [], markers: 0 } },
      endStep("P2"),
      endStep("P1"),
    );
    expect(state.players.P1.battle).toHaveLength(0);
    expect(state.players.P1.drop.map((c) => c.uid)).not.toContain(cell.uid);
    expect(state.players.P1.removed.map((c) => c.uid)).toEqual([cell.uid]);
    expect(events).toContainEqual({ type: "CARD_REMOVED", player: "P1", uid: cell.uid, cardId: "BT9-137" });
  });

  it("22-14-3 : Cell Xeno utilisé en Combo depuis la Zone de Combat est retiré de la partie", () => {
    const s = p2Main();
    const cell = give(s, "P2", "BT9-137", "battle", "active");
    const energy = give(s, "P2", "BT24-105", "energy");
    const { state } = play(
      s,
      attack("P2-L", "P1-L"),
      { type: "COMBO", player: "P2", uid: cell.uid, payment: { energy: [energy.uid], markers: 0 } },
    );
    expect(state.players.P2.combo).toHaveLength(0);
    expect(state.players.P2.removed.map((c) => c.uid)).toEqual([cell.uid]);
  });

  it("Cell Xeno utilisé en Combo depuis la MAIN va normalement en Zone de Combo", () => {
    const s = p2Main();
    const cell = give(s, "P2", "BT9-137", "hand");
    const energy = give(s, "P2", "BT24-105", "energy");
    const { state } = play(
      s,
      attack("P2-L", "P1-L"),
      { type: "COMBO", player: "P2", uid: cell.uid, payment: { energy: [energy.uid], markers: 0 } },
    );
    expect(state.players.P2.combo.map((c) => c.uid)).toEqual([cell.uid]);
  });

  it("22-14-2 : refuse un deck avec 2 cartes [Ultimate]", () => {
    const deck = { ...freezer.deck!, main: { ...freezer.deck!.main, "BT9-137": 2 } };
    expect(validateDeck(deck, db)).toContain("22-14-2 : 2 cartes [Ultimate] dans le deck (maximum 1)");
  });
});

describe("22-17 : [Super Combo]", () => {
  const testCard = (id: string) => ({
    id,
    type: "battle",
    name: id,
    colors: ["green"],
    cost: { total: 1, specified: { green: 1 } },
    power: 5000,
    combo: { cost: 0, power: 10000 },
    keywords: ["super_combo"],
  });
  const extra = parseCardFile({ cards: [testCard("TEST-SC")] });
  const testDb = buildCardDatabase([freezer.cards, extra.cards]);

  it("le deck Freezer (4 Paragus [Super Combo]) est légal", () => {
    expect(validateDeck(freezer.deck!, testDb)).toEqual([]);
  });

  it("refuse 5 cartes [Super Combo], même avec des numéros différents", () => {
    const deck = { ...freezer.deck!, main: { ...freezer.deck!.main, "TEST-SC": 1 } };
    expect(validateDeck(deck, testDb)).toContain("22-17-2 : 5 cartes [Super Combo] dans le deck (maximum 4)");
  });
});
