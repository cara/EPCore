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

/** Ob wir in der Desktop-Hülle laufen. */
export function inShell() {
  return Boolean(typeof window !== 'undefined'
      && window.pywebview && window.pywebview.api
      && typeof window.pywebview.api.save_file_dialog === 'function');
}

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

  if (inShell()) {
    const path = await window.pywebview.api.save_file_dialog(name);
    if (!path) return { ok: false, cancelled: true };
    const result = await window.pywebview.api.write_file(path, base64Of(bytes));
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
