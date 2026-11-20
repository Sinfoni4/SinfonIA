import { Navigate, useParams } from 'react-router';

import { dashboardSectorFeatures, type Me } from '../api/client';

import { Badge } from '@/components/ui/badge';

/**
 * A function of the organization's sector turned on from the console. While it is being built
 * the page says what it will do; a function not on for the organization goes back home.
 */
export function SectorFeaturePage({ me }: { me: Me }) {
  const { featureId } = useParams();
  const feature = dashboardSectorFeatures(me).find((f) => f.id === featureId);
  if (!feature) return <Navigate to="/" replace />;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">{feature.label}</h1>
        {!feature.ready && (
          <Badge variant="outline" className="px-1.5 text-muted-foreground">
            in preparazione
          </Badge>
        )}
      </div>
      <p className="m-0">{feature.description}</p>
      {!feature.ready && (
        <p className="m-0 text-muted-foreground">
          Questa funzione è stata attivata per la tua organizzazione ed è in preparazione: comparirà
          qui, e nella Mini App di Telegram, appena sarà pronta.
        </p>
      )}
    </div>
  );
}
