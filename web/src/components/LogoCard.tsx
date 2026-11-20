import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { DEFAULT_BACKGROUND } from '../api/appearance';
import { describeError } from '../api/client';
import {
  fileToBase64,
  LOGO_ACCEPT,
  LOGO_MAX_BYTES,
  logoSrc,
  type OrganizationLogo,
} from '../api/logo';
import { useSession } from '../session/session';

/**
 * The logo of an organization, shown next to its name in the Telegram Mini App: read, uploaded
 * and removed at `path` (the platform console or the organization's own settings, the same
 * checks on the server). The preview stands on the background of the Mini App.
 */
export function LogoCard({
  path,
  queryKey,
  invalidate,
  background,
}: {
  path: string;
  queryKey: readonly unknown[];
  /** What to refresh after a change (the logo's own query is under it). */
  invalidate: readonly unknown[];
  /** The background of the Mini App, to see the logo as it will look; the grey by default. */
  background?: string | null;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const query = useQuery({
    queryKey,
    queryFn: () => api<OrganizationLogo | null>(path),
  });
  const done = async () => {
    setFile(null);
    setInputKey((k) => k + 1);
    await queryClient.invalidateQueries({ queryKey: invalidate });
  };
  const upload = useMutation({
    mutationFn: async (chosen: File) =>
      api(path, {
        method: 'POST',
        body: { contentType: chosen.type, data: await fileToBase64(chosen) },
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api(path, { method: 'DELETE' }),
    onSuccess: done,
  });
  const tooLarge = file !== null && file.size > LOGO_MAX_BYTES;
  const failure = upload.error ?? remove.error;
  const logo = query.data;

  return (
    <section className="card form" aria-labelledby="logo-title">
      <h2 id="logo-title">Logo</h2>
      <p className="muted">
        Compare nella Mini App di Telegram accanto al nome dell’organizzazione, sul fondo scuro
        della Mini App: va bene un logo bianco o chiaro. SVG, PNG, JPEG o WebP, al massimo{' '}
        {LOGO_MAX_BYTES / 1024} KB; gli SVG con script o collegamenti esterni sono rifiutati.
      </p>
      <div className="logo-preview" style={{ background: background ?? DEFAULT_BACKGROUND }}>
        {query.isPending ? (
          <span>Caricamento…</span>
        ) : logo ? (
          <img src={logoSrc(logo)} alt="Logo attuale" />
        ) : (
          <span>Nessun logo: la Mini App mostra le iniziali.</span>
        )}
      </div>
      <label htmlFor="logo-file">Nuovo logo</label>
      <input
        key={inputKey}
        id="logo-file"
        type="file"
        accept={LOGO_ACCEPT}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {tooLarge && (
        <p className="error" role="alert">
          Il file supera {LOGO_MAX_BYTES / 1024} KB.
        </p>
      )}
      <span className="actions">
        <button
          type="button"
          disabled={!file || tooLarge || upload.isPending}
          onClick={() => file && upload.mutate(file)}
        >
          Carica il logo
        </button>
        {logo && (
          <button
            type="button"
            className="secondary"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Togli il logo
          </button>
        )}
      </span>
      {(upload.isSuccess || remove.isSuccess) && !failure && (
        <p className="notice" role="status">
          {upload.isSuccess ? 'Logo caricato.' : 'Logo tolto.'}
        </p>
      )}
      {failure && (
        <p className="error" role="alert">
          {describeError(failure)}
        </p>
      )}
    </section>
  );
}
