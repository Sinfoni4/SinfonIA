/**
 * The address of the public staging (`npm run staging:start -- --public`), from the tunnel.
 */
/** https only, no path, query or credentials; returns the origin. */
export function checkPublicUrl(value: string | undefined): string {
  if (!value) throw new Error('--public needs --public-url=https://<indirizzo>');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--public-url non valido: ${value}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      '--public-url deve essere un indirizzo https:// senza credenziali né parametri',
    );
  }
  if (url.pathname !== '/') throw new Error('--public-url: solo l’indirizzo, senza percorso');
  return url.origin;
}
