/* Bytes irgendwo hinschreiben, in beiden Umgebungen.
 *
 * Im Browser lädt `<a download>` herunter. In der Desktop-Hülle **nicht**: eine
 * WebView navigiert stattdessen zur URL. Ein Klick auf PNG ersetzte damit die
 * Anwendung durch ein Bild der Kurve, ein Klick auf PDF durch ein PDF — und
 * ohne Adressleiste gab es keinen Weg zurück. Jeder Export in der App ging so,
 * und keiner der 190 e2e-Tests fiel darauf herein, weil sie einen Browser
 * fahren.
 *
 * Also: wenn die Hülle da ist, über ihren Speicherdialog; sonst wie bisher.
 */

/** Die API der Hülle, wo immer sie steckt.
 *
 * pywebview spritzt sie nur in den obersten Rahmen. Seit die Module in Rahmen
 * der Schale laufen, ist `window.pywebview` auf der Seite selbst undefiniert —
 * das Speichern fiel damit still auf den Browser-Weg zurück, `<a download>` tat
 * in der WebView nichts, und der Aufrufer meldete trotzdem „gespeichert". Also
 * dieselbe Suche wie in bridge.js: erst hier, dann im Elternrahmen.
 */
function hostApi() {
  if (typeof window === 'undefined') return null;
  if (window.pywebview?.api) return window.pywebview.api;
  try {
    if (window.parent !== window && window.parent.pywebview?.api) {
      return window.parent.pywebview.api;
    }
  } catch { /* fremder Ursprung — nicht unsere Schale */ }
  return null;
}

/** Ob wir in der Desktop-Hülle laufen. */
export function inShell() {
  return typeof hostApi()?.save_file_dialog === 'function';
}

/** Ab dieser Größe stückweise. 4 MB je Nachricht ist klein genug für
 *  jede WebView und groß genug, dass ein 60-MB-Video fünfzehn Runden
 *  braucht und nicht fünfzehnhundert. */
const CHUNK_BYTES = 4 << 20;

function base64Of(bytes) {
  let binary = '';
  const chunk = 0x8000;   // in Stücken, sonst sprengt apply() den Stack
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * `data` darf Blob, ArrayBuffer, Uint8Array oder String sein.
 * Liefert `{ ok, path? , cancelled? , error? }` — nie eine Ausnahme, damit ein
 * Aufrufer den Fehler anzeigen kann statt einen toten Knopf zu hinterlassen.
 */
export async function saveBytes(name, data) {
  let bytes;
  if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data instanceof Uint8Array) bytes = data;
  else bytes = new TextEncoder().encode(String(data));

  const api = hostApi();
  if (api && typeof api.save_file_dialog === 'function') {
    const path = await api.save_file_dialog(name);
    if (!path) return { ok: false, cancelled: true };

    // Stückweise, wenn die Datei groß ist. Ein Videoexport sind zig Megabyte,
    // und die Brücke trägt JSON: eine Base64-Zeichenkette dieser Größe ist auf
    // beiden Seiten eine einzelne Allokation und eine Nachricht, die manche
    // WebViews fallen lassen. Ein PNG von 200 kB geht weiter in einem Stück —
    // ein zweiter Weg für kleine Dateien wäre ein zweiter Weg, der schiefgehen
    // kann.
    if (bytes.length > CHUNK_BYTES && typeof api.write_chunk === 'function') {
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
        const piece = bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length));
        const step = await api.write_chunk(path, base64Of(piece), at === 0);
        if (!step || !step.ok) {
          return { ok: false, error: (step && step.error) || 'unbekannter Fehler' };
        }
      }
      return { ok: true, path };
    }

    const result = await api.write_file(path, base64Of(bytes));
    return result && result.ok
      ? { ok: true, path: result.path }
      : { ok: false, error: (result && result.error) || 'unbekannter Fehler' };
  }

  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.download = name;
  link.href = url;
  link.click();
  // Erst im nächsten Tick freigeben: sofort widerrufen bricht den Download in
  // Firefox ab, bevor er begonnen hat.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ok: true, path: name };
}

/** Ein Canvas als PNG. Ohne toDataURL: der Datenstring wird bei großen Bildern
 *  megabytegroß, und in der Hülle wurde genau daraus die Adresse, zu der sie
 *  navigierte. */
export async function saveCanvas(name, canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return { ok: false, error: 'Das Bild konnte nicht erzeugt werden.' };
  return saveBytes(name, blob);
}
