// Images des cartes, importées par le joueur depuis son ordinateur (Paramètres) et gardées
// UNIQUEMENT dans son navigateur (IndexedDB). Elles ne font pas partie du site publié : les
// illustrations appartiennent à leurs ayants droit.
//
// Nom de fichier = numéro de carte (ex. « BT24-056.jpg ») ; « -back » pour le verso d'un Leader.

const DB_NAME = "dbscg-images";
const STORE = "images";

/** Images chargées en mémoire : numéro de carte → adresse utilisable dans la page. */
const urls = new Map<string, string>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Charge en mémoire les images enregistrées dans le navigateur (sans erreur si indisponible). */
export async function loadImages(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        setUrl(String(cursor.key), cursor.value as Blob);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch {
    // Stockage indisponible (navigation privée...) : pas d'images.
  }
}

function setUrl(id: string, blob: Blob): void {
  const old = urls.get(id);
  if (old) URL.revokeObjectURL(old);
  urls.set(id, URL.createObjectURL(blob));
}

/** Numéro de carte d'après un nom de fichier (« BT24-056.jpg » → « BT24-056 »). */
export const idFromFileName = (name: string): string => name.replace(/\.[a-z0-9]+$/i, "").trim().toUpperCase().replace(/-BACK$/, "-back");

/** Enregistre des fichiers image ; renvoie le nombre de fichiers importés. */
export async function importImages(files: FileList | File[]): Promise<number> {
  const list = Array.from(files as ArrayLike<File>).filter((f) => f.type.startsWith("image/"));
  if (list.length === 0) return 0;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const f of list) tx.objectStore(STORE).put(f, idFromFileName(f.name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  for (const f of list) setUrl(idFromFileName(f.name), f);
  return list.length;
}

/** Efface toutes les images du navigateur. */
export async function clearImages(): Promise<void> {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Rien à effacer.
  }
}

export const imageCount = (): number => urls.size;

/** Affichage des images activé (réglé par la page principale d'après les préférences). */
let enabled = true;
export const setImagesEnabled = (on: boolean): void => {
  enabled = on;
};

/** Adresse de l'image d'une carte (verso d'un Leader avec \`back\`), ou undefined. */
export function imageUrl(cardId: string, back = false): string | undefined {
  if (!enabled) return undefined;
  return (back ? urls.get(`${cardId}-back`) : undefined) ?? urls.get(cardId);
}
