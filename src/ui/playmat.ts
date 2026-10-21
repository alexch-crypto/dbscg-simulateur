// Tapis de jeu du joueur : une image importée depuis son ordinateur, réduite puis gardée dans le
// navigateur. En ligne, elle est envoyée à l'adversaire (qui la voit sous les cartes du joueur).
// Sans image, le tapis par défaut (orange avec une Dragon Ball) est dessiné en CSS.

const KEY = "dbscg.playmat";
const MAX_W = 1400;
const MAX_H = 760;

let mine: string | null = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();

export const myPlaymat = (): string | null => mine;

/** Réduit une image (au plus 1400 × 760) et la convertit en JPEG (adresse « data: »). */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image illisible"));
    };
    img.src = url;
  });
}

/** Importe une image comme tapis ; renvoie un message d'erreur, ou null. */
export async function importPlaymat(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return "ce fichier n'est pas une image";
  try {
    const data = await shrink(file);
    mine = data;
    try {
      localStorage.setItem(KEY, data);
    } catch {
      return "image trop lourde pour être gardée dans le navigateur (elle sera perdue au rechargement)";
    }
    return null;
  } catch {
    return "image illisible";
  }
}

export function resetPlaymat(): void {
  mine = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Rien à effacer.
  }
}

/**
 * Une image de tapis reçue par le réseau est-elle acceptable ? Seulement une image « data: » en
 * base64, de taille raisonnable (rien d'autre ne peut être glissé dans la page).
 */
export const validPlaymat = (data: unknown): data is string =>
  typeof data === "string" && data.length < 1_500_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data);
