// Transport réseau pair-à-pair avec PeerJS (WebRTC).
//
// Le serveur public gratuit de PeerJS sert seulement à mettre les deux navigateurs en relation
// (« signalisation ») ; ensuite les messages vont directement d'un navigateur à l'autre.
// Une room = un identifiant PeerJS « dbscg-sim-<CODE> » ouvert par l'hôte.

import Peer, { type DataConnection } from "peerjs";

const PREFIX = "dbscg-sim-";
/** Lettres et chiffres faciles à dicter (sans 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeRoomCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Traduit les erreurs PeerJS en français. */
function peerError(err: unknown): string {
  const type = (err as { type?: string }).type;
  switch (type) {
    case "peer-unavailable":
      return "aucune room avec ce code (vérifiez le code, ou que l'hôte a bien créé la room)";
    case "unavailable-id":
      return "ce code de room est déjà utilisé";
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "impossible de joindre le serveur de mise en relation (vérifiez votre connexion Internet)";
    case "browser-incompatible":
      return "ce navigateur ne permet pas le jeu en ligne (essayez Chrome, Firefox ou Edge)";
    default:
      return `erreur réseau (${type ?? String(err)})`;
  }
}

export interface HostHandlers {
  /** La room est ouverte : le code peut être donné à l'adversaire. */
  onReady(code: string): void;
  /** Un invité s'est connecté (ou reconnecté). */
  onGuestConnected(): void;
  onGuestLeft(): void;
  onMessage(msg: unknown): void;
  onError(message: string): void;
}

export interface HostLink {
  send(msg: unknown): void;
  close(): void;
}

/** Ouvre une room. Un seul invité à la fois ; un nouvel invité remplace l'ancien (reconnexion). */
export function hostRoom(handlers: HostHandlers, code = makeRoomCode(), attempt = 0): HostLink {
  let guest: DataConnection | null = null;
  const peer = new Peer(PREFIX + code);
  peer.on("open", () => handlers.onReady(code));
  peer.on("connection", (conn) => {
    conn.on("open", () => {
      if (guest && guest !== conn) guest.close();
      guest = conn;
      handlers.onGuestConnected();
    });
    conn.on("data", (data) => {
      if (conn === guest) handlers.onMessage(data);
    });
    conn.on("close", () => {
      if (conn === guest) {
        guest = null;
        handlers.onGuestLeft();
      }
    });
  });
  peer.on("error", (err) => {
    // Code déjà pris : on en essaie un autre.
    if ((err as { type?: string }).type === "unavailable-id" && attempt < 5) {
      peer.destroy();
      const next = hostRoom(handlers, makeRoomCode(), attempt + 1);
      link.send = next.send;
      link.close = next.close;
      return;
    }
    handlers.onError(peerError(err));
  });
  // Si la connexion au serveur de mise en relation tombe, on la rétablit (la room reste valide).
  peer.on("disconnected", () => {
    if (!peer.destroyed) peer.reconnect();
  });
  const link: HostLink = {
    send: (msg) => {
      if (guest?.open) guest.send(msg);
    },
    close: () => peer.destroy(),
  };
  return link;
}

export interface GuestHandlers {
  onConnected(): void;
  onClosed(): void;
  onMessage(msg: unknown): void;
  onError(message: string): void;
}

export interface GuestLink {
  send(msg: unknown): void;
  close(): void;
}

/** Rejoint la room d'un hôte avec son code. */
export function joinRoom(code: string, handlers: GuestHandlers): GuestLink {
  const peer = new Peer();
  let conn: DataConnection | null = null;
  peer.on("open", () => {
    conn = peer.connect(PREFIX + normalizeCode(code), { reliable: true });
    conn.on("open", () => handlers.onConnected());
    conn.on("data", (data) => handlers.onMessage(data));
    conn.on("close", () => handlers.onClosed());
    conn.on("error", (err) => handlers.onError(peerError(err)));
  });
  peer.on("error", (err) => handlers.onError(peerError(err)));
  return {
    send: (msg) => {
      if (conn?.open) conn.send(msg);
    },
    close: () => peer.destroy(),
  };
}
