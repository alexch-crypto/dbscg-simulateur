import { describe, expect, it } from "vitest";
import { applyAction, getLegalActions, type Action, type GameEvent, type GameState, type PlayerId } from "../src/engine";
import { ctx, expectRefused, give, newMirrorGame, p1Main, p2Main, play } from "./helpers";

// Dans p2Main, c'est le premier tour de P2 (second joueur) : il peut attaquer.
// Leaders Freezer face avant : 10 000 de puissance.

const attack = (attacker: string, target: string, player: PlayerId = "P2"): Action => ({
  type: "ATTACK",
  player,
  attacker,
  target,
});
const endStep = (player: PlayerId): Action => ({ type: "END_STEP", player });
const noPayment = { energy: [] as string[], markers: 0 };

describe("8-1 : déclaration d'attaque", () => {
  it("7-3-4-4-1 : le premier joueur ne peut pas attaquer à son premier tour", () => {
    const s = p1Main();
    expectRefused(s, attack("P1-L", "P2-L", "P1"), "7-3-4-4-1");
    expect(getLegalActions(s, "P1", ctx).filter((a) => a.type === "ATTACK")).toEqual([]);
  });

  it("le Leader attaque le Leader adverse : il passe en mode Inertie et un combat commence", () => {
    const { state, events } = play(p2Main(), attack("P2-L", "P1-L"));
    expect(state.players.P2.leader.mode).toBe("rest");
    expect(state.battle).toEqual({
      attacker: { player: "P2", uid: "P2-L" },
      defender: { player: "P1", uid: "P1-L" },
      target: { player: "P1", uid: "P1-L" },
      step: "offense",
      pendingAutos: [],
    });
    expect(state.pending).toEqual({ type: "OFFENSE", player: "P2" });
    expect(events).toContainEqual({ type: "ATTACK_DECLARED", player: "P2", attacker: "P2-L", target: "P1-L" });
  });

  it("une carte jouée ce tour-ci peut attaquer tout de suite (pas de « mal d'invocation »)", () => {
    const s = p2Main();
    const e = [give(s, "P2", "BT24-105", "energy"), give(s, "P2", "BT24-106", "energy"), give(s, "P2", "BT9-123", "energy")];
    const freezer = give(s, "P2", "BT24-068", "hand"); // Krillin (coût 3, pas d'[Auto.])
    const after = play(s, {
      type: "PLAY_CARD",
      player: "P2",
      uid: freezer.uid,
      payment: { energy: e.map((x) => x.uid), markers: 0 },
    }).state;
    expect(applyAction(after, attack(freezer.uid, "P1-L"), ctx).ok).toBe(true);
  });

  it("8-1-1 : une carte en mode Inertie ne peut pas attaquer", () => {
    const s = p2Main();
    const tired = give(s, "P2", "BT24-105", "battle", "rest");
    expectRefused(s, attack(tired.uid, "P1-L"), "mode Action");
  });

  it("8-1-1 : une carte de Combat adverse ne peut être attaquée qu'en mode Inertie", () => {
    const s = p2Main();
    const standing = give(s, "P1", "BT24-105", "battle", "active");
    expectRefused(s, attack("P2-L", standing.uid), "mode Inertie");
    const lying = give(s, "P1", "BT24-106", "battle", "rest");
    expect(applyAction(s, attack("P2-L", lying.uid), ctx).ok).toBe(true);
  });

  it("8-1-1 : on ne peut pas attaquer ses propres cartes, ni avec les cartes adverses", () => {
    const s = p2Main();
    const mine = give(s, "P2", "BT24-105", "battle", "rest");
    expectRefused(s, attack("P2-L", mine.uid), "la cible");
    expectRefused(s, attack("P1-L", "P1-L"), "l'attaquant");
  });

  it("une carte qui a attaqué ne peut plus attaquer ce tour (elle est en mode Inertie)", () => {
    const s = fullBattle(p2Main(), attack("P2-L", "P1-L")).state;
    expect(s.pending).toEqual({ type: "MAIN", player: "P2" });
    expectRefused(s, attack("P2-L", "P1-L"), "mode Action");
  });

  it("8-1-1 : on peut attaquer plusieurs fois par tour, avec des cartes différentes", () => {
    const s = p2Main();
    const a = give(s, "P2", "BT24-105", "battle");
    let after = fullBattle(s, attack("P2-L", "P1-L")).state;
    after = fullBattle(after, attack(a.uid, "P1-L")).state;
    expect(after.players.P1.life).toHaveLength(6);
  });

  it("coups autorisés : chaque attaquant en mode Action contre chaque cible valide", () => {
    const s = p2Main();
    give(s, "P2", "BT24-105", "battle");
    give(s, "P1", "BT24-106", "battle", "rest");
    give(s, "P1", "P-561", "battle", "active");
    const attacks = getLegalActions(s, "P2", ctx).filter((a) => a.type === "ATTACK");
    expect(attacks).toHaveLength(4); // 2 attaquants × 2 cibles (Leader + carte en Inertie)
  });
});

/**
 * Joue un combat jusqu'au bout sans Combo ni Bloqueur : chaque joueur finit son étape,
 * le défenseur prend la première carte de Vie si besoin, personne ne met de carte en Énergie Z.
 */
function fullBattle(s: GameState, attackAction: Action): { state: GameState; events: GameEvent[] } {
  let { state, events } = play(s, attackAction);
  for (let guard = 0; state.pending && state.pending.type !== "MAIN" && guard < 20; guard++) {
    const p = state.pending;
    const next: Action =
      p.type === "BLOCKER" ? { type: "DECLARE_BLOCKER", player: p.player, uid: null }
      : p.type === "TAKE_DAMAGE"
        ? { type: "TAKE_LIFE", player: p.player, indices: [...Array(Math.min(p.amount, state.players[p.player].life.length)).keys()] }
      : p.type === "COMBO_TO_Z" ? { type: "COMBO_TO_Z_ENERGY", player: p.player, uid: null }
      : p.type === "CHOOSE_CARDS" ? { type: "CHOOSE_CARDS", player: p.player, uids: p.options.slice(0, p.min) }
      : endStep(p.player);
    const r = play(state, next);
    state = r.state;
    events = [...events, ...r.events];
  }
  return { state, events };
}

describe("8-4 : étape des Dégâts", () => {
  it("8-4-6 : à puissance égale, l'attaquant gagne et inflige 1 dégât au Leader", () => {
    let s = play(p2Main(), attack("P2-L", "P1-L"), endStep("P2"), endStep("P1")).state;
    expect(s.pending).toEqual({ type: "TAKE_DAMAGE", player: "P1", amount: 1, critical: false });
    expect(s.battle?.step).toBe("damage");
  });

  it("21-3 : le défenseur choisit une carte de Vie (à l'aveugle) qui va dans sa main", () => {
    const before = play(p2Main(), attack("P2-L", "P1-L"), endStep("P2"), endStep("P1")).state;
    const chosen = before.players.P1.life[3]!;
    const { state, events } = play(before, { type: "TAKE_LIFE", player: "P1", indices: [3] });
    expect(state.players.P1.life).toHaveLength(7);
    expect(state.players.P1.hand.at(-1)).toEqual({ ...chosen, faceUp: false });
    // sans révéler la carte
    expect(events).toContainEqual({ type: "LIFE_LOST", player: "P1", indices: [3], to: "hand", cardIds: [null] });
    expect(events).toContainEqual({ type: "BATTLE_ENDED" });
    expect(state.battle).toBeNull();
    expect(state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("une carte de Vie face visible prise en main est annoncée aux deux joueurs", () => {
    const before = play(p2Main(), attack("P2-L", "P1-L"), endStep("P2"), endStep("P1")).state;
    before.players.P1.life[0]!.faceUp = true;
    const cardId = before.players.P1.life[0]!.cardId;
    const { events } = play(before, { type: "TAKE_LIFE", player: "P1", indices: [0] });
    expect(events).toContainEqual({ type: "LIFE_LOST", player: "P1", indices: [0], to: "hand", cardIds: [cardId] });
  });

  it("21-3 : seul le joueur qui subit les dégâts choisit, avec le bon nombre de positions existantes", () => {
    const s = play(p2Main(), attack("P2-L", "P1-L"), endStep("P2"), endStep("P1")).state;
    expectRefused(s, { type: "TAKE_LIFE", player: "P2", indices: [0] }, "c'est à P1");
    expectRefused(s, { type: "TAKE_LIFE", player: "P1", indices: [8] }, "position de Vie invalide");
    expectRefused(s, { type: "TAKE_LIFE", player: "P1", indices: [0, 1] }, "choisissez 1 carte(s)");
  });

  it("21-2-2-1 : perdre sa dernière carte de Vie fait perdre la partie", () => {
    const s = p2Main();
    s.players.P1.hand.push(...s.players.P1.life.splice(1)); // il ne reste qu'une Vie à P1
    const { state } = fullBattle(s, attack("P2-L", "P1-L"));
    expect(state.result).toEqual({ kind: "win", winner: "P2", reason: "P1 perd — 21-2-2-1 : plus de carte dans la Zone de Vie" });
    expect(state.pending).toBeNull();
  });

  it("8-4-6 : si l'attaquant est moins puissant, rien ne se passe", () => {
    const s = p2Main();
    const zarbon = give(s, "P2", "P-223", "battle"); // 5 000
    const { state, events } = fullBattle(s, attack(zarbon.uid, "P1-L"));
    expect(events).toContainEqual({ type: "POWER_COMPARED", attacker: 5000, defender: 10000 });
    expect(state.players.P1.life).toHaveLength(8);
    expect(events.some((e) => e.type === "DAMAGE_DEALT")).toBe(false);
  });

  it("8-4-6-2 : une carte de Combat de défense battue est mise KO (Dispersion de son propriétaire)", () => {
    const s = p2Main();
    const target = give(s, "P1", "BT24-105", "battle", "rest"); // 10 000
    const { state, events } = fullBattle(s, attack("P2-L", target.uid));
    expect(state.players.P1.battle).toHaveLength(0);
    expect(state.players.P1.drop.map((c) => c.uid)).toContain(target.uid);
    expect(events).toContainEqual({ type: "CARD_KO", player: "P1", uid: target.uid, cardId: "BT24-105" });
    expect(state.players.P1.life).toHaveLength(8); // pas de dégât au joueur
  });

  it("une carte de Combat plus puissante que l'attaquant survit", () => {
    const s = p2Main();
    const piccolo = give(s, "P1", "P-561", "battle", "rest"); // 20 000
    const { state } = fullBattle(s, attack("P2-L", piccolo.uid));
    expect(state.players.P1.battle.map((c) => c.uid)).toEqual([piccolo.uid]);
  });
});

describe("5-7 : Combos", () => {
  /** P2 attaque le Leader de P1 ; on est à l'étape d'Attaque de P2. */
  const inOffense = () => {
    const s = p2Main();
    return { s, attackFrom: (st: GameState) => play(st, attack("P2-L", "P1-L")).state };
  };

  it("l'attaquant ajoute la puissance de Combo d'une carte de sa main (coût de Combo 0)", () => {
    const { s, attackFrom } = inOffense();
    const zarbon = give(s, "P2", "P-223", "hand"); // Combo 0 / +5 000
    let st = attackFrom(s);
    const r = play(st, { type: "COMBO", player: "P2", uid: zarbon.uid, payment: noPayment });
    st = r.state;
    expect(st.players.P2.combo.map((c) => c.uid)).toEqual([zarbon.uid]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "COMBO", from: "hand", cardId: "P-223" }));
    const { events } = fullBattle(st, endStep("P2"));
    expect(events).toContainEqual({ type: "POWER_COMPARED", attacker: 15000, defender: 10000 });
  });

  it("le défenseur peut aussi faire des Combos et repousser l'attaque", () => {
    const { s, attackFrom } = inOffense();
    const zarbon = give(s, "P1", "P-223", "hand");
    let st = play(attackFrom(s), endStep("P2")).state;
    expect(st.pending).toEqual({ type: "DEFENSE", player: "P1" });
    st = play(st, { type: "COMBO", player: "P1", uid: zarbon.uid, payment: noPayment }).state;
    const { state, events } = fullBattle(st, endStep("P1"));
    expect(events).toContainEqual({ type: "POWER_COMPARED", attacker: 10000, defender: 15000 });
    expect(state.players.P1.life).toHaveLength(8);
  });

  it("plusieurs Combos à la suite, carte par carte", () => {
    const { s, attackFrom } = inOffense();
    const a = give(s, "P2", "P-223", "hand");
    const b = give(s, "P2", "SD8-04", "hand"); // +10 000
    const st = play(
      attackFrom(s),
      { type: "COMBO", player: "P2", uid: a.uid, payment: noPayment },
      { type: "COMBO", player: "P2", uid: b.uid, payment: noPayment },
    ).state;
    const { events } = fullBattle(st, endStep("P2"));
    expect(events).toContainEqual({ type: "POWER_COMPARED", attacker: 25000, defender: 10000 });
  });

  it("5-6 : un coût de Combo de 1 se paie avec une Énergie de n'importe quelle couleur", () => {
    const { s, attackFrom } = inOffense();
    const energy = give(s, "P2", "P-223", "energy"); // verte
    const overdrive = give(s, "P2", "BT24-133", "hand"); // Combo 1 / +10 000
    const st = attackFrom(s);
    expectRefused(st, { type: "COMBO", player: "P2", uid: overdrive.uid, payment: noPayment }, "exactement 1");
    const after = play(st, { type: "COMBO", player: "P2", uid: overdrive.uid, payment: { energy: [energy.uid], markers: 0 } }).state;
    expect(after.players.P2.energy[0]!.mode).toBe("rest");
  });

  it("5-6-3 : le marqueur Énergie peut payer un coût de Combo", () => {
    const { s, attackFrom } = inOffense();
    const overdrive = give(s, "P2", "BT24-133", "hand");
    const after = play(attackFrom(s), { type: "COMBO", player: "P2", uid: overdrive.uid, payment: { energy: [], markers: 1 } }).state;
    expect(after.players.P2.energyMarkers).toBe(0);
  });

  it("5-7-5-1-1 : Combo avec une carte de Combat en mode Action de sa Zone de Combat", () => {
    const { s, attackFrom } = inOffense();
    const helper = give(s, "P2", "SD8-04", "battle", "active");
    const after = play(attackFrom(s), { type: "COMBO", player: "P2", uid: helper.uid, payment: noPayment });
    expect(after.state.players.P2.battle).toHaveLength(0);
    expect(after.state.players.P2.combo.map((c) => c.uid)).toEqual([helper.uid]);
    expect(after.events).toContainEqual(expect.objectContaining({ type: "COMBO", from: "battle" }));
  });

  it("5-7-5-1-1 : pas de Combo avec une carte en mode Inertie, ni avec la carte attaquante", () => {
    const s = p2Main();
    const tired = give(s, "P2", "SD8-04", "battle", "rest");
    const attacker = give(s, "P2", "BT24-105", "battle", "active");
    const st = play(s, attack(attacker.uid, "P1-L")).state;
    expectRefused(st, { type: "COMBO", player: "P2", uid: tired.uid, payment: noPayment }, "5-7-5");
    expectRefused(st, { type: "COMBO", player: "P2", uid: attacker.uid, payment: noPayment }, "5-7-5");
  });

  it("5-7-1 : une Extra ne peut pas servir de Combo", () => {
    const { s, attackFrom } = inOffense();
    const kinto = give(s, "P2", "BT3-104", "hand");
    expectRefused(attackFrom(s), { type: "COMBO", player: "P2", uid: kinto.uid, payment: noPayment }, "5-7-5");
  });

  it("seul le joueur dont c'est l'étape peut faire une Combo", () => {
    const { s, attackFrom } = inOffense();
    const zarbon = give(s, "P1", "P-223", "hand");
    expectRefused(attackFrom(s), { type: "COMBO", player: "P1", uid: zarbon.uid, payment: noPayment }, "c'est à P2");
  });
});

describe("22-4 : [Bloqueur]", () => {
  it("le défenseur peut bloquer avec une carte [Bloqueur] en mode Action : elle devient la carte de défense", () => {
    const s = p2Main();
    const blocker = give(s, "P1", "P-223", "battle"); // Zarbon, Bloqueur, 5 000
    let st = play(s, attack("P2-L", "P1-L")).state;
    expect(st.pending).toEqual({ type: "BLOCKER", player: "P1" });
    const r = play(st, { type: "DECLARE_BLOCKER", player: "P1", uid: blocker.uid });
    st = r.state;
    expect(st.battle?.defender).toEqual({ player: "P1", uid: blocker.uid });
    expect(st.players.P1.battle[0]!.mode).toBe("rest"); // 22-4-2 : coût = passer en mode Inertie
    expect(r.events).toContainEqual({ type: "BLOCKER_DECLARED", player: "P1", uid: blocker.uid });
    // 10 000 contre 5 000 : le Bloqueur est mis KO, le Leader ne subit aucun dégât.
    const { state } = fullBattle(st, endStep("P2"));
    expect(state.players.P1.drop.map((c) => c.uid)).toContain(blocker.uid);
    expect(state.players.P1.life).toHaveLength(8);
  });

  it("un Bloqueur peut protéger une carte de Combat, pas seulement le Leader", () => {
    const s = p2Main();
    const target = give(s, "P1", "BT24-105", "battle", "rest");
    const blocker = give(s, "P1", "P-223", "battle");
    const st = play(s, attack("P2-L", target.uid), { type: "DECLARE_BLOCKER", player: "P1", uid: blocker.uid }).state;
    expect(st.battle?.defender.uid).toBe(blocker.uid);
    expect(st.battle?.target.uid).toBe(target.uid);
  });

  it("le défenseur peut choisir de ne pas bloquer", () => {
    const s = p2Main();
    give(s, "P1", "P-223", "battle");
    const st = play(s, attack("P2-L", "P1-L"), { type: "DECLARE_BLOCKER", player: "P1", uid: null }).state;
    expect(st.battle?.defender).toEqual({ player: "P1", uid: "P1-L" });
    expect(st.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("sans Bloqueur disponible, pas de question : on passe directement à l'étape d'Attaque", () => {
    const s = p2Main();
    give(s, "P1", "P-223", "battle", "rest"); // Bloqueur en mode Inertie : ne peut pas bloquer
    give(s, "P1", "BT24-105", "battle", "active"); // pas Bloqueur
    expect(play(s, attack("P2-L", "P1-L")).state.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("une seule carte bloque par attaque, et seulement une carte autorisée", () => {
    const s = p2Main();
    const b1 = give(s, "P1", "P-223", "battle");
    give(s, "P1", "P-223", "battle");
    const notBlocker = give(s, "P1", "BT24-105", "battle");
    const st = play(s, attack("P2-L", "P1-L")).state;
    expectRefused(st, { type: "DECLARE_BLOCKER", player: "P1", uid: notBlocker.uid }, "22-4-2");
    const after = play(st, { type: "DECLARE_BLOCKER", player: "P1", uid: b1.uid }).state;
    expect(after.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });
});

describe("8-5 : fin du combat", () => {
  it("8-5-2 : l'attaquant peut placer une carte de sa Zone de Combo en Énergie Z, le reste va en Dispersion", () => {
    const s = p2Main();
    const a = give(s, "P2", "P-223", "hand");
    const b = give(s, "P2", "SD8-04", "hand");
    let st = play(
      s,
      attack("P2-L", "P1-L"),
      { type: "COMBO", player: "P2", uid: a.uid, payment: noPayment },
      { type: "COMBO", player: "P2", uid: b.uid, payment: noPayment },
      endStep("P2"),
      endStep("P1"),
      { type: "TAKE_LIFE", player: "P1", indices: [0] },
    ).state;
    expect(st.pending).toEqual({ type: "COMBO_TO_Z", player: "P2" });
    expectRefused(st, { type: "COMBO_TO_Z_ENERGY", player: "P2", uid: "P1-L" }, "Zone de Combo");
    const r = play(st, { type: "COMBO_TO_Z_ENERGY", player: "P2", uid: b.uid });
    st = r.state;
    expect(st.players.P2.zEnergy.map((c) => c.uid)).toEqual([b.uid]);
    expect(st.players.P2.drop.map((c) => c.uid)).toEqual([a.uid]);
    expect(st.players.P2.combo).toHaveLength(0);
    expect(r.events).toContainEqual({ type: "COMBO_ZONE_CLEARED", player: "P2", count: 1 });
    expect(st.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("8-5-2 puis 8-5-3 : le joueur actif choisit d'abord, puis le joueur non actif", () => {
    const s = p2Main();
    const a = give(s, "P2", "P-223", "hand");
    const d = give(s, "P1", "SD8-04", "hand");
    let st = play(
      s,
      attack("P2-L", "P1-L"),
      { type: "COMBO", player: "P2", uid: a.uid, payment: noPayment },
      endStep("P2"),
      { type: "COMBO", player: "P1", uid: d.uid, payment: noPayment },
      endStep("P1"),
    ).state;
    // 15 000 contre 20 000 : pas de dégâts, on passe directement à la fin du combat.
    expect(st.pending).toEqual({ type: "COMBO_TO_Z", player: "P2" });
    st = play(st, { type: "COMBO_TO_Z_ENERGY", player: "P2", uid: null }).state;
    expect(st.pending).toEqual({ type: "COMBO_TO_Z", player: "P1" });
    st = play(st, { type: "COMBO_TO_Z_ENERGY", player: "P1", uid: d.uid }).state;
    expect(st.players.P1.zEnergy.map((c) => c.uid)).toEqual([d.uid]);
    expect(st.players.P2.drop.map((c) => c.uid)).toEqual([a.uid]);
    expect(st.battle).toBeNull();
  });

  it("après le combat, le joueur actif peut continuer sa phase principale puis finir son tour", () => {
    const st = fullBattle(p2Main(), attack("P2-L", "P1-L")).state;
    const next = play(st, { type: "END_MAIN_PHASE", player: "P2" }).state;
    expect(next.turnPlayer).toBe("P1");
    expect(next.players.P2.leader.mode).toBe("rest"); // P2 se relèvera à SON prochain tour
  });
});

describe("Robustesse : parties jouées au hasard", () => {
  /** Petit générateur pseudo-aléatoire pour choisir les coups (indépendant du moteur). */
  const chooser = (seed: number) => {
    let x = seed;
    return (n: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % n;
    };
  };

  const allCardsOf = (s: GameState, p: PlayerId) => {
    const z = s.players[p];
    return [...z.deck, ...z.hand, ...z.life, ...z.energy, ...z.battle, ...z.combo, ...z.drop, ...z.zEnergy, ...z.warp];
  };

  it("tous les coups proposés sont acceptés, et aucune carte ne disparaît", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let s = newMirrorGame(seed);
      const pick = chooser(seed);
      for (let move = 0; move < 400 && !s.result; move++) {
        const player = s.pending!.player;
        // On n'abandonne pas au hasard : on retire CONCEDE des choix.
        const legal = getLegalActions(s, player, ctx).filter((a) => a.type !== "CONCEDE");
        expect(legal.length, `aucun coup pour ${player} (${s.pending?.type})`).toBeGreaterThan(0);
        const action = legal[pick(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} refusé : ${JSON.stringify(action)} → ${r.error}`);
        s = r.state;
        for (const p of ["P1", "P2"] as const) {
          const cards = allCardsOf(s, p);
          expect(cards).toHaveLength(53);
          expect(new Set(cards.map((c) => c.uid)).size).toBe(53);
          expect(cards.every((c) => c.owner === p)).toBe(true);
        }
      }
    }
  });
});
