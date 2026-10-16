// Textes en français affichés par l'interface : coups, événements, décisions.
// Uniquement de l'affichage : aucune règle du jeu ici.

import type {
  Action,
  CardDatabase,
  CardView,
  GameEvent,
  PendingDecision,
  PlayerId,
  PlayerView,
  VisibleCard,
} from "../engine";

export const COLOR_NAMES: Record<string, string> = {
  red: "rouge",
  blue: "bleu",
  green: "vert",
  yellow: "jaune",
  black: "noir",
  white: "blanc",
};

const isVisible = (c: CardView): c is VisibleCard => "uid" in c;

/** Retrouve une carte visible (par uid) dans la vue, toutes zones publiques confondues. */
function findVisible(view: PlayerView, uid: string): VisibleCard | undefined {
  for (const p of Object.values(view.players)) {
    for (const zone of [p.hand, p.life, p.energy, p.battle, p.combo, p.drop, p.zEnergy, p.warp]) {
      const found = zone.find((c) => isVisible(c) && c.uid === uid);
      if (found && isVisible(found)) return found;
    }
  }
  return undefined;
}

export function cardName(db: CardDatabase, cardId: string): string {
  return db.get(cardId)?.name ?? cardId;
}

/** Nom lisible d'une carte en jeu (Leader ou autre) à partir de son uid. */
export function nameOf(view: PlayerView, db: CardDatabase, uid: string): string {
  for (const p of Object.values(view.players)) {
    if (p.leader.uid === uid) {
      const def = db.get(p.leader.cardId);
      const face = p.leader.side === "front" ? def?.front : def?.back;
      return `Leader ${face?.name ?? p.leader.cardId} (${p.id})`;
    }
  }
  const card = findVisible(view, uid);
  return card ? cardName(db, card.cardId) : uid;
}

function paymentText(view: PlayerView, db: CardDatabase, energy: string[], markers: number): string {
  const parts = energy.map((uid) => nameOf(view, db, uid));
  if (markers > 0) parts.push(`${markers} marqueur(s) Énergie`);
  return parts.length > 0 ? ` — payer avec : ${parts.join(", ")}` : " — gratuit";
}

export function describeAction(a: Action, view: PlayerView, db: CardDatabase): string {
  switch (a.type) {
    case "CONCEDE":
      return "Abandonner la partie";
    case "CHOOSE_FIRST_PLAYER":
      return a.first === a.player ? `Je joue en premier (${a.first})` : `${a.first} joue en premier`;
    case "MULLIGAN":
      return a.redraw ? "Repiocher ma main (6 nouvelles cartes)" : "Garder ma main";
    case "CHARGE_ENERGY":
      return a.uid === null ? "Ne pas placer d'Énergie" : `Placer en Énergie : ${nameOf(view, db, a.uid)}`;
    case "PLAY_CARD":
      return `Jouer ${nameOf(view, db, a.uid)}${paymentText(view, db, a.payment.energy, a.payment.markers)}`;
    case "END_MAIN_PHASE":
      return "Terminer la phase principale (fin du tour)";
    case "ATTACK":
      return `Attaquer ${nameOf(view, db, a.target)} avec ${nameOf(view, db, a.attacker)}`;
    case "DECLARE_BLOCKER":
      return a.uid === null ? "Ne pas bloquer" : `Bloquer avec ${nameOf(view, db, a.uid)}`;
    case "COMBO": {
      const card = findVisible(view, a.uid);
      const combo = card ? db.get(card.cardId)?.combo : undefined;
      const bonus = combo ? ` (+${combo.power})` : "";
      return `Combo : ${nameOf(view, db, a.uid)}${bonus}${paymentText(view, db, a.payment.energy, a.payment.markers)}`;
    }
    case "END_STEP":
      return "Finir l'étape";
    case "TAKE_LIFE": {
      const parts = a.indices.map((i) => {
        const life = view.players[a.player].life[i];
        const known = life && isVisible(life) ? ` (${cardName(db, life.cardId)}, face visible)` : "";
        return `n°${i + 1}${known}`;
      });
      return `Perdre la carte de Vie ${parts.join(" + ")}`;
    }
    case "COMBO_TO_Z_ENERGY":
      return a.uid === null ? "Ne rien placer en Énergie Z" : `Placer en Énergie Z : ${nameOf(view, db, a.uid)}`;
    case "AWAKEN":
      return "Éveil du Leader";
    case "CHOOSE_CARDS": {
      // Cartes regardées dans une zone secrète (dessus du deck) : leur nom vient de `looked`.
      const looked = view.pending?.type === "CHOOSE_CARDS" ? view.pending.looked : undefined;
      const label = (u: string) => {
        const seen = looked?.find((c) => c.uid === u);
        return seen ? cardName(db, seen.cardId) : nameOf(view, db, u);
      };
      return a.uids.length === 0 ? "Ne rien choisir" : `Choisir : ${a.uids.map(label).join(", ")}`;
    }
    case "CHOOSE_LIFE":
      return a.indices.length === 0 ? "Ne prendre aucune carte de Vie" : `Prendre la carte de Vie ${a.indices.map((i) => `n°${i + 1}`).join(" + ")}`;
    case "CHOOSE_AUTO": {
      const option = view.pending?.type === "CHOOSE_AUTO" ? view.pending.options.find((o) => o.id === a.id) : undefined;
      return `Résoudre d'abord : ${option?.label ?? `capacité n°${a.id}`}`;
    }
    case "CHOOSE_BLIND":
      return a.indices.length === 0 ? "Ne rien choisir" : `Choisir ${a.indices.length} carte(s) au hasard dans la main adverse`;
    case "PASS_COUNTER":
      return "Ne pas contrer";
    case "DECLARE_COUNTER": {
      const card = findVisible(view, a.uid);
      const name = card ? cardName(db, card.cardId) : a.uid;
      const cost = a.alt
        ? " — coût alternatif (sans énergie)"
        : a.payment.energy.length || a.payment.markers
          ? paymentText(view, db, a.payment.energy, a.payment.markers)
          : " — sans coût d'énergie";
      return `Contrer avec ${name}${cost}`;
    }
    case "CHOOSE_OPTION": {
      const option = view.pending?.type === "CHOOSE_OPTION" ? view.pending.options.find((o) => o.id === a.id) : undefined;
      return option?.label ?? a.id;
    }
    case "ACTIVATE": {
      const card = findVisible(view, a.uid);
      const leader = Object.values(view.players).find((p) => p.leader.uid === a.uid)?.leader;
      const cardId = card?.cardId ?? leader?.cardId ?? "";
      const def = db.get(cardId);
      const abilities = def?.type === "leader" ? (leader?.side === "back" ? def.back : def.front)?.abilities : def?.abilities;
      const text = String(abilities?.[a.index]?.["text"] ?? "");
      return `Activer ${nameOf(view, db, a.uid)} : ${text.slice(0, 90)}${text.length > 90 ? "…" : ""}${
        a.payment.energy.length || a.payment.markers ? paymentText(view, db, a.payment.energy, a.payment.markers) : ""
      }`;
    }
  }
}

export function describePending(p: PendingDecision | null): string {
  if (!p) return "";
  switch (p.type) {
    case "CHOOSE_FIRST_PLAYER":
      return "Le tirage au sort vous désigne : choisissez qui joue en premier.";
    case "MULLIGAN":
      return "Gardez votre main, ou repiochez-la (une seule fois).";
    case "CHARGE":
      return "Phase de Recharge : placez une carte de votre main en Énergie (facultatif).";
    case "MAIN":
      return "Phase principale : jouez des cartes, attaquez, ou terminez la phase.";
    case "BLOCKER":
      return "Vous êtes attaqué : voulez-vous bloquer avec une carte [Bloqueur] ?";
    case "OFFENSE":
      return "Étape d'Attaque : faites des Combos, ou finissez l'étape.";
    case "DEFENSE":
      return "Étape de Défense : faites des Combos, ou finissez l'étape.";
    case "TAKE_DAMAGE":
      return `Vous subissez ${p.amount} dégât(s)${p.critical ? " [Coup Critique]" : ""} : choisissez ${p.amount} carte(s) de Vie (face cachée), qui vont ${
        p.critical ? "en Dispersion" : "dans votre main"
      }.`;
    case "COMBO_TO_Z":
      return "Fin du combat : placez une de vos cartes de Combo en Énergie Z (facultatif).";
    case "CHOOSE_CARDS":
    case "CHOOSE_LIFE":
    case "CHOOSE_BLIND":
    case "CHOOSE_OPTION":
      return p.prompt;
    case "CHOOSE_AUTO":
      return "Plusieurs de vos capacités [Auto.] se déclenchent : choisissez laquelle résoudre en premier.";
    case "COUNTER_WINDOW":
      return p.on === "play"
        ? "Fenêtre de contre : votre adversaire joue une carte. Voulez-vous activer un [Contre : Mise en jeu] ?"
        : p.on === "attack"
          ? "Fenêtre de contre : votre adversaire attaque. Voulez-vous activer un [Contre : Attaque] ?"
          : "Fenêtre de contre : votre adversaire a activé un [Contre]. Voulez-vous le contrer ?";
  }
}

const PHASE_NAMES: Record<string, string> = {
  setup: "mise en place",
  charge: "phase de Recharge",
  main: "phase principale",
  end: "phase de Fin",
  game_over: "partie terminée",
};
export const phaseName = (phase: string): string => PHASE_NAMES[phase] ?? phase;

const STEP_NAMES: Record<string, string> = {
  offense: "étape d'Attaque",
  defense: "étape de Défense",
  damage: "étape des Dégâts",
  end: "étape de Fin de Combat",
};

export function describeEvent(e: GameEvent, view: PlayerView, db: CardDatabase): string {
  const n = (uid: string) => nameOf(view, db, uid);
  switch (e.type) {
    case "COIN_TOSS":
      return `Tirage au sort : ${e.winner} choisira qui commence.`;
    case "FIRST_PLAYER_CHOSEN":
      return `${e.chooser} décide que ${e.first} joue en premier.`;
    case "DECK_SHUFFLED":
      return `${e.player} mélange son deck.`;
    case "CARDS_DRAWN":
      return `${e.player} pioche ${e.count} carte(s).`;
    case "MULLIGAN":
      return e.redraw ? `${e.player} repioche sa main.` : `${e.player} garde sa main.`;
    case "LIFE_PLACED":
      return `${e.player} place ${e.count} cartes dans sa Zone de Vie.`;
    case "ENERGY_MARKER_PLACED":
      return `${e.player} reçoit ${e.count} marqueur(s) Énergie.`;
    case "TURN_STARTED":
      return `══ Tour ${e.turnNumber} : ${e.player} ══`;
    case "CARDS_READIED":
      return `${e.player} repasse ses cartes en mode Action.`;
    case "ENERGY_CHARGED":
      return `${e.player} place ${cardName(db, e.cardId)} en Énergie${e.mode === "rest" ? " (mode Inertie : Fuite d'énergie)" : ""}.`;
    case "PHASE_STARTED":
      return `${e.player} : ${phaseName(e.phase)}.`;
    case "TURN_ENDED":
      return `${e.player} termine son tour.`;
    case "PLAY_DECLARED":
      return `${e.player} déclare jouer ${cardName(db, e.cardId)}.`;
    case "CARD_PLAYED":
      return `${cardName(db, e.cardId)} (${e.player}) arrive en Zone de Combat.`;
    case "COUNTER_WINDOW_OPENED":
      return `Fenêtre de contre pour ${e.player}.`;
    case "COUNTER_WINDOW_CLOSED":
      return "Fenêtre de contre terminée.";
    case "COUNTER_DECLARED":
      return `${e.player} active le [Contre] de ${cardName(db, e.cardId)} !`;
    case "COUNTER_RESOLVING":
      return `Résolution du [Contre] de ${cardName(db, e.cardId)}.`;
    case "ATTACK_NEGATED":
      return "L'attaque est annulée.";
    case "ATTACKS_LIMITED":
      return `${e.player} ne peut plus attaquer ${e.battleCardsOnly ? "avec ses cartes de Combat " : ""}que ${e.remaining} fois ce tour.`;
    case "ATTACK_DECLARED":
      return `${e.player} attaque ${n(e.target)} avec ${n(e.attacker)} !`;
    case "BLOCKER_DECLARED":
      return `${e.player} bloque avec ${n(e.uid)}.`;
    case "BATTLE_STEP":
      return `→ ${STEP_NAMES[e.step]}`;
    case "COMBO":
      return `${e.player} fait une Combo avec ${cardName(db, e.cardId)} (+${db.get(e.cardId)?.combo?.power ?? 0}).`;
    case "POWER_COMPARED":
      return `Puissance : attaquant ${e.attacker} contre défenseur ${e.defender}.`;
    case "DAMAGE_DEALT":
      return `${e.player} subit ${e.amount} dégât(s)${e.critical ? " [Coup Critique]" : ""}.`;
    case "LIFE_LOST": {
      const cards = e.indices.map((i, k) => `n°${i + 1}${e.cardIds[k] ? ` (${cardName(db, e.cardIds[k]!)})` : ""}`);
      return `${e.player} perd sa/ses carte(s) de Vie ${cards.join(", ")} → ${e.to === "drop" ? "Dispersion" : "main"}.`;
    }
    case "CARD_REMOVED":
      return `${cardName(db, e.cardId)} (${e.player}) est retirée de la partie.`;
    case "CARD_READIED":
      return `${n(e.uid)} repasse en mode Action ([Réplique]).`;
    case "CARD_KO":
      return `${cardName(db, e.cardId)} (${e.player}) est mise KO.`;
    case "Z_ENERGY_PLACED":
      return `${e.player} place ${cardName(db, e.cardId)} en Énergie Z.`;
    case "COMBO_ZONE_CLEARED":
      return `${e.count} carte(s) de Combo de ${e.player} vont en Dispersion.`;
    case "BATTLE_ENDED":
      return "Fin du combat.";
    case "AWAKEN_ACTIVATED":
      return `${e.player} active l'Éveil de son Leader !`;
    case "LEADER_FLIPPED":
      return `Le Leader de ${e.player} se retourne (${e.side === "back" ? "face arrière" : "face avant"}).`;
    case "CARDS_MODE_CHANGED":
      return `${e.uids.map(n).join(", ")} ${e.uids.length > 1 ? "passent" : "passe"} en mode ${e.mode === "rest" ? "Inertie" : "Action"}.`;
    case "CARD_PLAYED_BY_SKILL":
      return `${e.player} joue ${cardName(db, e.cardId)} via une Capacité (depuis ${e.from === "hand" ? "sa main" : "sa Dispersion"})${e.mode === "rest" ? " en mode Inertie" : ""}.`;
    case "ABILITY_ACTIVATED":
      return `${e.player} active une Capacité de ${cardName(db, e.cardId)}.`;
    case "CARDS_LOCKED":
      return `${e.uids.map(n).join(", ")} ne pourra pas passer en mode Action.`;
    case "SKILLS_NEGATED":
      return `Les Capacités de ${e.uids.map(n).join(", ")} sont annulées.`;
    case "KEYWORD_NEGATED":
      return `La Capacité-clef ${e.keyword} de ${n(e.uid)} est annulée.`;
    case "KEYWORDS_GRANTED":
      return `${e.uids.map(n).join(", ")} acquiert ${e.keywords.join(", ")}.`;
    case "CARDS_DISCARDED":
      return `${e.player} défausse ${e.cardIds.map((id) => cardName(db, id)).join(", ")}.`;
    case "CARDS_TO_WARP":
      return `${e.player} transfère ${e.cardIds.map((id) => cardName(db, id)).join(", ")} dans sa Dimension parallèle.`;
    case "CARD_TO_DROP":
      return `${cardName(db, e.cardId)} (${e.player}) est placée dans la Dispersion.`;
    case "DECK_LOOKED":
      return `${e.player} regarde les ${e.count} cartes du dessus de son deck.`;
    case "CARDS_TO_HAND":
      return `${e.player} rajoute à sa main ${e.cardIds.map((id) => (id ? cardName(db, id) : "une carte")).join(", ")}.`;
    case "AUTO_TRIGGERED":
      return `[Auto.] de ${cardName(db, e.cardId)} (${e.player}) se déclenche.`;
    case "AUTO_CANCELLED":
      return `[Auto.] de ${cardName(db, e.cardId)} ne se résout pas : ${e.reason}.`;
    case "NOT_IMPLEMENTED":
      return `⚠ ${cardName(db, e.cardId)} : partie non gérée par le moteur — ${e.what}`;
    case "POWER_MODIFIED":
      return `${n(e.uid)} : ${e.amount > 0 ? "+" : ""}${e.amount} de puissance pour tout le ${e.until === "turn" ? "tour" : "combat"}.`;
    case "LIFE_TO_HAND":
      return `${e.player} rajoute à sa main sa/ses carte(s) de Vie ${e.indices.map((i, k) => `n°${i + 1}${e.cardIds[k] ? ` (${cardName(db, e.cardIds[k]!)})` : ""}`).join(", ")}.`;
    case "GAME_OVER":
      return e.result.kind === "win"
        ? `★ Fin de la partie : ${e.result.winner} gagne (${e.result.reason}).`
        : `★ Match nul (${e.result.reason}).`;
  }
}

export const otherPlayer = (p: PlayerId): PlayerId => (p === "P1" ? "P2" : "P1");
