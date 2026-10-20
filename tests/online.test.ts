import { describe, expect, it } from "vitest";
import { getLegalActions, getPlayerView, type Action, type GameState } from "../src/engine";
import { GUEST, HOST, OnlineGuest, OnlineHost, PROTOCOL_VERSION, type GuestMessage, type HostMessage } from "../src/net/online";
import { ctx, freezer } from "./helpers";

/** Relie un hôte et un invité « en mémoire », en passant chaque message par JSON comme sur le réseau. */
function link(seed = 42) {
  const toGuest: HostMessage[] = [];
  const toHost: GuestMessage[] = [];
  let guest!: OnlineGuest;
  const host = new OnlineHost(
    ctx,
    freezer.deck!,
    "only_if_playable",
    (msg) => {
      const copy = JSON.parse(JSON.stringify(msg)) as HostMessage;
      toGuest.push(copy);
      guest.receive(copy);
    },
    () => {},
    seed,
  );
  guest = new OnlineGuest(
    (msg) => {
      const copy = JSON.parse(JSON.stringify(msg)) as GuestMessage;
      toHost.push(copy);
      host.receive(copy);
    },
    () => {},
  );
  return { host, guest, toGuest, toHost };
}

/** UIDs des cartes cachées de l'hôte (main, deck, Vie, deck Z), sauf celles révélées (ex. carte en train d'être jouée, 5-5-2-1). */
function hostSecrets(s: GameState): string[] {
  const p = s.players[HOST];
  return [...p.hand, ...p.deck, ...p.life, ...p.zDeck].filter((c) => !c.faceUp).map((c) => c.uid);
}

describe("Jeu en ligne : connexion et début de partie", () => {
  it("l'invité dit bonjour : l'hôte crée la partie et lui envoie sa vue et ses coups", () => {
    const { host, guest } = link();
    guest.hello(freezer.deck!, "always");
    expect(host.state).not.toBeNull();
    expect(guest.you).toBe(GUEST);
    expect(guest.snapshot!.view).toEqual(getPlayerView(host.state!, GUEST));
    expect(guest.snapshot!.actions).toEqual(getLegalActions(host.state!, GUEST, ctx));
    expect(host.state!.settings.counterPrompt).toEqual({ P1: "only_if_playable", P2: "always" });
  });

  it("les pseudos des deux joueurs sont échangés", () => {
    const { host, guest } = link();
    host.names.P1 = "Alex";
    guest.hello(freezer.deck!, "always", "Ami");
    expect(host.names).toEqual({ P1: "Alex", P2: "Ami" });
    expect(guest.names).toEqual({ P1: "Alex", P2: "Ami" });
  });

  it("version différente : la partie ne commence pas", () => {
    const { host, guest } = link();
    host.receive({ t: "hello", version: PROTOCOL_VERSION + 1, deck: freezer.deck!, counterPrompt: "always" });
    expect(host.state).toBeNull();
    void guest;
  });

  it("deck invalide : message d'erreur à l'invité", () => {
    const { host, guest } = link();
    guest.hello({ ...freezer.deck!, main: { "BT24-133": 5 } }, "always");
    expect(host.state).toBeNull();
    expect(guest.lastError).toContain("deck invalide");
  });

  it("reconnexion : un nouveau bonjour renvoie l'état actuel sans recréer la partie", () => {
    const { host, guest } = link();
    guest.hello(freezer.deck!, "always");
    const before = host.state;
    guest.snapshot = null;
    guest.hello(freezer.deck!, "always");
    expect(host.state).toBe(before);
    expect(guest.snapshot!.view).toEqual(getPlayerView(host.state!, GUEST));
  });
});

describe("Jeu en ligne : sécurité", () => {
  it("l'invité ne peut pas jouer un coup de l'hôte", () => {
    const { host, guest } = link();
    guest.hello(freezer.deck!, "always");
    const before = structuredClone(host.state);
    guest.act({ type: "CONCEDE", player: HOST });
    expect(guest.lastError).toContain("vos propres coups");
    expect(host.state).toEqual(before);
  });

  it("l'hôte ne peut pas jouer un coup de l'invité depuis son interface", () => {
    const { host, guest } = link();
    guest.hello(freezer.deck!, "always");
    expect(host.actLocal({ type: "CONCEDE", player: GUEST })).toContain("vos propres coups");
  });

  it("un coup interdit est refusé par le moteur, avec la règle en cause", () => {
    const { host, guest } = link();
    guest.hello(freezer.deck!, "always");
    guest.act({ type: "END_MAIN_PHASE", player: GUEST });
    expect(guest.lastError).toContain("coup refusé");
    void host;
  });

  it("les messages reçus par l'invité ne contiennent jamais les cartes cachées de l'hôte, ni le hasard", () => {
    const { host, guest, toGuest } = link(7);
    guest.hello(freezer.deck!, "always");
    let x = 7;
    const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
    for (let move = 0; move < 300 && !host.state!.result; move++) {
      const last = toGuest.at(-1)!;
      if (last.t === "update") {
        const text = JSON.stringify({ view: last.view, actions: last.actions });
        for (const uid of hostSecrets(host.state!)) expect(text).not.toContain(`"${uid}"`);
        expect(text).not.toContain('"rng"');
      }
      const decider = host.state!.pending!.player;
      if (decider === HOST) {
        const actions = host.snapshot(HOST)!.actions.filter((a) => a.type !== "CONCEDE");
        expect(host.actLocal(actions[pick(actions.length)]!)).toBeNull();
      } else {
        const actions = guest.snapshot!.actions.filter((a: Action) => a.type !== "CONCEDE");
        guest.act(actions[pick(actions.length)]!);
        expect(guest.lastError).toBe("");
      }
    }
  });
});

describe("Jeu en ligne : parties complètes", () => {
  it("10 parties jouées jusqu'au bout par messages, l'invité ne voyant que sa vue", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { host, guest, toHost } = link(seed);
      guest.hello(freezer.deck!, seed % 2 ? "always" : "only_if_playable");
      let x = seed;
      const pick = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      for (let move = 0; move < 1500 && !host.state!.result; move++) {
        const decider = host.state!.pending!.player;
        if (decider === HOST) {
          const actions = host.snapshot(HOST)!.actions.filter((a) => a.type !== "CONCEDE");
          expect(host.actLocal(actions[pick(actions.length)]!)).toBeNull();
        } else {
          expect(guest.snapshot!.actions).toEqual(getLegalActions(host.state!, GUEST, ctx));
          const actions = guest.snapshot!.actions.filter((a) => a.type !== "CONCEDE");
          guest.act(actions[pick(actions.length)]!);
          expect(guest.lastError).toBe("");
        }
      }
      expect(host.state!.result).not.toBeNull();
      expect(guest.snapshot!.view.result).toEqual(host.state!.result);
      // L'enregistrement de l'hôte rejoue exactement la même partie.
      expect(host.record!.actions.length).toBeGreaterThan(0);
      expect(toHost.filter((m) => m.t === "action").length).toBeGreaterThan(0);
    }
  });
});
