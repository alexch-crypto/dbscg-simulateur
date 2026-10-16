import { describe, expect, it } from "vitest";
import { applyAction, getLegalActions, getPlayerView, type Action, type GameState, type PlayerId } from "../src/engine";
import { ctx, expectRefused, give, p2Main, play } from "./helpers";

// P2 est le joueur actif (son premier tour, il peut attaquer) ; P1 contre.
// Cartes utilisées :
//  BT3-104  Kinto-un : Contre : Attaque — annulez l'attaque ; puis vous pouvez défausser une carte
//           jaune : l'adversaire ne peut attaquer qu'une fois avec ses cartes de Combat ce tour. (coût 1 jaune)
//  BT10-088 Potentiel latent libéré : Contre : Attaque (Leader exclusivement vert) — KO de cartes adverses
//           pour un total de coûts ≤ 2 ; puis vous pouvez défausser une carte verte : 1 seule attaque restante.
//  BT1-107  Soif de sang glaciale : Contre : Mise en jeu (Leader « Armée de Freezer ») — annule les Capacités
//           de la carte de Combat jouée pour le tour. (coût 1 jaune)
//  P-561    Piccolo Daimaô : Contre : Attaque — annulez l'attaque et jouez cette carte (on paie son coût).
//  EB1-037  Clones meurtriers : Contre : Attaque — annulez l'attaque (+ jeton, non géré). Avec 5 points de vie
//           ou moins, on peut payer en rajoutant une carte de Vie à sa main au lieu de l'énergie.
//  BT10-075 Freezer, Méchant charismatique : Contre : Mise en jeu — jouez cette carte (on paie son coût).

const attack = (attacker: string, target = "P1-L"): Action => ({ type: "ATTACK", player: "P2", attacker, target });
const pass = (player: PlayerId): Action => ({ type: "PASS_COUNTER", player });

function counterAction(s: GameState, player: PlayerId, uid: string, alt = false): Action {
  const a = getLegalActions(s, player, ctx).find((x) => x.type === "DECLARE_COUNTER" && x.uid === uid && x.alt === alt);
  if (!a) throw new Error(`aucun contre proposé pour ${uid} (alt=${alt})`);
  return a;
}

describe("Fenêtre de contre sur une attaque : Kinto-un", () => {
  function setup() {
    const s = p2Main();
    const kinto = give(s, "P1", "BT3-104", "hand");
    const energy = give(s, "P1", "BT24-105", "energy"); // jaune
    const yellow = give(s, "P1", "BT27-076", "hand"); // carte jaune à défausser
    return { s, kinto, energy, yellow };
  }

  it("le défenseur reçoit une fenêtre de contre dès la déclaration d'attaque", () => {
    const { s } = setup();
    const r = play(s, attack("P2-L"));
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "attack" });
    expect(getLegalActions(r.state, "P1", ctx).map((a) => a.type)).toEqual(["PASS_COUNTER", "DECLARE_COUNTER", "CONCEDE"]);
  });

  it("Kinto-un annule l'attaque : pas de dégât, la carte va en Dispersion, fin du combat", () => {
    const { s, kinto, energy } = setup();
    let r = play(s, attack("P2-L"));
    r = play(r.state, counterAction(r.state, "P1", kinto.uid));
    expect(r.events).toContainEqual(expect.objectContaining({ type: "COUNTER_DECLARED", player: "P1", cardId: "BT3-104" }));
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(kinto.uid); // 12-2-2-2 : dès l'activation
    expect(r.state.players.P1.energy.find((c) => c.uid === energy.uid)!.mode).toBe("rest");
    expect(r.events).toContainEqual({ type: "ATTACK_NEGATED" });
    // « Vous pouvez placer une carte jaune de votre main dans votre Dispersion » : on refuse.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_OPTION", player: "P1" });
    r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    expect(r.state.battle).toBeNull();
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
    expect(r.state.players.P1.life).toHaveLength(8);
    expect(r.state.players.P2.leader.mode).toBe("rest"); // l'attaquant reste en mode Inertie
  });

  it("si on défausse une carte jaune : l'adversaire ne peut plus attaquer qu'une fois avec ses cartes de Combat", () => {
    const { s, kinto, yellow } = setup();
    const a = give(s, "P2", "BT24-105", "battle");
    const b = give(s, "P2", "BT24-106", "battle");
    const c = give(s, "P2", "BT27-080", "battle");
    let r = play(s, attack(a.uid));
    r = play(r.state, counterAction(r.state, "P1", kinto.uid), { type: "CHOOSE_OPTION", player: "P1", id: "yes" });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [yellow.uid] });
    expect(r.state.players.P1.drop.map((c) => c.uid)).toContain(yellow.uid);
    expect(r.events).toContainEqual({ type: "ATTACKS_LIMITED", player: "P2", remaining: 1, battleCardsOnly: true });
    // Une attaque avec une carte de Combat est encore possible (b), pas deux (c). Le Leader n'est pas limité.
    const attackers = (st: GameState) =>
      getLegalActions(st, "P2", ctx).filter((x) => x.type === "ATTACK").map((x) => (x as { attacker: string }).attacker);
    expect(new Set(attackers(r.state))).toEqual(new Set(["P2-L", b.uid, c.uid]));
    r = play(r.state, attack(b.uid), { type: "END_STEP", player: "P2" }, { type: "END_STEP", player: "P1" });
    r = play(r.state, { type: "TAKE_LIFE", player: "P1", indices: [0] });
    expect(attackers(r.state)).toEqual(["P2-L"]);
    expectRefused(r.state, attack(c.uid), "limite les attaques");
  });

  it("les [Auto.] « quand cette carte attaque » se résolvent quand même (pioche du Leader éveillé)", () => {
    const { s, kinto } = setup();
    s.players.P2.leader.side = "back";
    const handBefore = s.players.P2.hand.length;
    let r = play(s, attack("P2-L"));
    r = play(r.state, counterAction(r.state, "P1", kinto.uid), { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    expect(r.state.players.P2.hand).toHaveLength(handBefore + 1);
    expect(r.state.battle).toBeNull();
  });

  it("un contre se paie : sans Énergie jaune, Kinto-un n'est pas proposé", () => {
    const s = p2Main();
    give(s, "P1", "BT3-104", "hand");
    give(s, "P1", "P-223", "energy"); // verte
    const r = play(s, attack("P2-L"));
    // Réglage « seulement si jouable » : la fenêtre s'est fermée toute seule.
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });
});

describe("Réglage « toujours me demander »", () => {
  it("la fenêtre s'ouvre même sans contre en main ; « Ne pas contrer » la ferme", () => {
    const s = p2Main(42);
    s.settings.counterPrompt = { P1: "always", P2: "always" };
    let r = play(s, attack("P2-L"));
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "attack" });
    expect(getLegalActions(r.state, "P1", ctx).map((a) => a.type)).toEqual(["PASS_COUNTER", "CONCEDE"]);
    r = play(r.state, pass("P1"));
    expect(r.state.pending).toEqual({ type: "OFFENSE", player: "P2" });
  });

  it("une carte jouée ouvre aussi une fenêtre de [Contre : Mise en jeu]", () => {
    const s = p2Main();
    s.settings.counterPrompt = { P1: "always", P2: "always" };
    for (const id of ["BT9-123", "BT24-106", "P-223"]) give(s, "P2", id, "energy");
    const card = give(s, "P2", "BT24-068", "hand"); // Krillin, coût 3
    const action = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === card.uid)!;
    let r = play(s, action);
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "play" });
    expect(r.state.players.P2.battle).toHaveLength(0); // pas encore en jeu
    r = play(r.state, pass("P1"));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toEqual([card.uid]);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("le réglage de chaque joueur est public (dans la vue)", () => {
    const s = p2Main();
    expect(getPlayerView(s, "P2").settings.counterPrompt.P1).toBe("only_if_playable");
  });
});

describe("Potentiel latent libéré : un contre qui n'annule pas l'attaque", () => {
  it("KO de cartes adverses pour un total de coûts ≤ 2, puis le défenseur peut encore bloquer", () => {
    const s = p2Main();
    const latent = give(s, "P1", "BT10-088", "hand");
    give(s, "P1", "P-223", "energy"); // verte
    const blocker = give(s, "P1", "P-223", "battle"); // Zarbon, Bloqueur
    const boo = give(s, "P2", "BT14-082", "battle"); // coût 2
    const paragus = give(s, "P2", "SD8-04", "battle"); // coût 2
    let r = play(s, attack("P2-L"));
    r = play(r.state, counterAction(r.state, "P1", latent.uid));
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", min: 0, maxTotalCost: 2 });
    // Les deux ensemble font 4 : refusé.
    expectRefused(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [boo.uid, paragus.uid] }, "20-6");
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [boo.uid] });
    expect(r.state.players.P2.drop.map((c) => c.uid)).toContain(boo.uid);
    r = play(r.state, { type: "CHOOSE_OPTION", player: "P1", id: "no" });
    // L'attaque continue : étape de blocage.
    expect(r.state.pending).toEqual({ type: "BLOCKER", player: "P1" });
    r = play(r.state, { type: "DECLARE_BLOCKER", player: "P1", uid: blocker.uid });
    expect(r.state.battle?.defender.uid).toBe(blocker.uid);
  });
});

describe("[Contre : Mise en jeu] : Soif de sang glaciale", () => {
  function setup(playedId: string) {
    const s = p2Main();
    const soif = give(s, "P1", "BT1-107", "hand");
    give(s, "P1", "BT24-105", "energy"); // jaune
    for (const id of ["BT9-123", "BT9-123", "BT9-123", "BT9-123", "BT24-106", "BT27-080"]) give(s, "P2", id, "energy");
    const card = give(s, "P2", playedId, "hand");
    const action = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === card.uid)!;
    return { s, soif, card, action };
  }

  it("annule les Capacités de la carte jouée : son « Quand cette carte est jouée » ne se déclenche pas", () => {
    const { s, soif, card, action } = setup("BT24-105"); // Départ de l'Invasion
    let r = play(s, action);
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "play" });
    r = play(r.state, counterAction(r.state, "P1", soif.uid));
    expect(r.events).toContainEqual({ type: "SKILLS_NEGATED", uids: [card.uid] });
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(card.uid); // la carte arrive quand même
    expect(r.events.some((e) => e.type === "AUTO_TRIGGERED")).toBe(false);
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("22-20 [Déflexion] : Second Changement de Forme n'est pas affecté (pas de fenêtre proposée)", () => {
    const { s, action } = setup("BT24-136");
    const r = play(s, action);
    expect(r.state.pending).not.toMatchObject({ type: "COUNTER_WINDOW" });
  });

  it("une [Activation] qui joue une carte ouvre aussi la fenêtre (Départ de l'Invasion joué depuis la main)", () => {
    const s = p2Main();
    const soif = give(s, "P1", "BT1-107", "hand");
    give(s, "P1", "BT24-105", "energy");
    give(s, "P2", "P-223", "energy");
    give(s, "P2", "BT24-106", "energy");
    const card = give(s, "P2", "BT24-105", "hand");
    const activate = getLegalActions(s, "P2", ctx).find((a) => a.type === "ACTIVATE" && a.uid === card.uid)!;
    let r = play(s, activate);
    expect(r.state.pending).toEqual({ type: "COUNTER_WINDOW", player: "P1", on: "play" });
    r = play(r.state, counterAction(r.state, "P1", soif.uid));
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(card.uid);
    expect(r.events.some((e) => e.type === "AUTO_TRIGGERED")).toBe(false);
  });
});

describe("Contres de cartes de Combat : jouer la carte", () => {
  it("Piccolo Daimaô : annule l'attaque, se joue (en payant son coût), puis son « Quand cette carte est jouée » se résout", () => {
    const s = p2Main();
    const piccolo = give(s, "P1", "P-561", "hand");
    for (const id of ["P-223", "BT24-105", "BT24-106", "BT27-080"]) give(s, "P1", id, "energy");
    const target = give(s, "P2", "BT24-105", "battle"); // coût 3 : peut être mis KO (5 ou moins)
    let r = play(s, attack("P2-L"));
    const declare = counterAction(r.state, "P1", piccolo.uid);
    expect((declare as { payment: { energy: string[] } }).payment.energy).toHaveLength(4);
    r = play(r.state, declare);
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(piccolo.uid);
    expect(r.events).toContainEqual({ type: "ATTACK_NEGATED" });
    // « Quand cette carte est jouée » de Piccolo (maître : P1) : KO d'une carte de coût 5 ou moins.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", options: [target.uid] });
    r = play(r.state, { type: "CHOOSE_CARDS", player: "P1", uids: [target.uid] });
    expect(r.state.players.P2.drop.map((c) => c.uid)).toContain(target.uid);
    expect(r.state.battle).toBeNull();
    expect(r.state.pending).toEqual({ type: "MAIN", player: "P2" });
  });

  it("Méchant charismatique : [Contre : Mise en jeu] — se joue quand l'adversaire joue une carte", () => {
    const s = p2Main();
    const mechant = give(s, "P1", "BT10-075", "hand");
    for (const id of ["P-223", "BT24-105", "BT24-106", "BT27-080", "BT9-123"]) give(s, "P1", id, "energy");
    for (const id of ["BT9-123", "BT24-106", "P-561"]) give(s, "P2", id, "energy");
    const played = give(s, "P2", "BT24-068", "hand"); // Krillin, coût 3
    const action = getLegalActions(s, "P2", ctx).find((a) => a.type === "PLAY_CARD" && a.uid === played.uid)!;
    let r = play(s, action);
    r = play(r.state, counterAction(r.state, "P1", mechant.uid));
    expect(r.state.players.P1.battle.map((c) => c.uid)).toContain(mechant.uid);
    // La restriction « vous ne pouvez pas activer d'autres Contre : Mise en jeu » est signalée (non gérée).
    expect(r.events).toContainEqual(expect.objectContaining({ type: "NOT_IMPLEMENTED", cardId: "BT10-075" }));
    // Puis Krillin arrive en jeu, et l'[Auto.] de Méchant charismatique (KO coût ≤ 7) se résout.
    expect(r.state.players.P2.battle.map((c) => c.uid)).toContain(played.uid);
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_CARDS", player: "P1", options: [played.uid] });
  });
});

describe("Coût alternatif : Clones meurtriers", () => {
  it("avec 5 points de vie ou moins, on peut payer avec une carte de Vie au lieu de l'énergie", () => {
    const s = p2Main();
    const clones = give(s, "P1", "EB1-037", "hand");
    s.players.P1.hand.push(...s.players.P1.life.splice(5)); // 5 points de vie, aucune Énergie
    let r = play(s, attack("P2-L"));
    expect(getLegalActions(r.state, "P1", ctx).some((a) => a.type === "DECLARE_COUNTER" && a.alt === false)).toBe(false);
    r = play(r.state, counterAction(r.state, "P1", clones.uid, true));
    // Coût : choisir une carte de Vie qui part en main.
    expect(r.state.pending).toMatchObject({ type: "CHOOSE_LIFE", player: "P1", min: 1, max: 1 });
    r = play(r.state, { type: "CHOOSE_LIFE", player: "P1", indices: [0] });
    expect(r.state.players.P1.life).toHaveLength(4);
    expect(r.events).toContainEqual({ type: "ATTACK_NEGATED" });
    expect(r.events).toContainEqual(expect.objectContaining({ type: "NOT_IMPLEMENTED", cardId: "EB1-037" })); // jeton
    expect(r.state.battle).toBeNull();
  });

  it("avec 6 points de vie, seul le coût normal (2 vertes) est possible", () => {
    const s = p2Main();
    const clones = give(s, "P1", "EB1-037", "hand");
    s.players.P1.hand.push(...s.players.P1.life.splice(6));
    give(s, "P1", "P-223", "energy");
    give(s, "P1", "P-561", "energy");
    const r = play(s, attack("P2-L"));
    expect(() => counterAction(r.state, "P1", clones.uid, true)).toThrow();
    expect(counterAction(r.state, "P1", clones.uid, false)).toBeDefined();
  });
});

describe("Robustesse : parties au hasard en mode « toujours demander »", () => {
  it("tous les coups proposés sont acceptés (20 parties)", () => {
    for (let seed = 300; seed < 320; seed++) {
      let s = p2Main(seed);
      s.settings.counterPrompt = { P1: "always", P2: "always" };
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 600 && !s.result; move++) {
        const legal = getLegalActions(s, s.pending!.player, ctx).filter((a) => a.type !== "CONCEDE");
        expect(legal.length, JSON.stringify(s.pending)).toBeGreaterThan(0);
        const action = legal[pick(legal.length)]!;
        const r = applyAction(s, action, ctx);
        if (!r.ok) throw new Error(`seed ${seed}, coup ${move} : ${JSON.stringify(action)} → ${r.error}`);
        s = r.state;
      }
    }
  });
});
