import { PageHeader } from "@/components/common";
import { ConnectionsPanel } from "@/components/connections-panel";
import { CronOpsPanel } from "@/components/cron-ops-panel";
import { GoLiveControl } from "@/components/go-live-control";
import { PrintifyWebhookCard } from "@/components/printify-webhook-card";
import { SetupGuide } from "@/components/setup-guide";
import { toStageSnapshots } from "@/lib/next-actions";
import { etsyRedirectUri, publicAppOrigin } from "@/lib/setup-guide";
import { getConnectionsData } from "@/lib/queries";

export const metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  const data = await getConnectionsData();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        subtitle={
          data.publishMode === "dry-run"
            ? "Command center health. Publishing stays dry-run until you confirm Go live."
            : "Command center health. Live writes are armed."
        }
      />
      <GoLiveControl mode={data.publishMode} envMode={data.envPublishMode} />
      <ConnectionsPanel checks={data.checks} etsyConnected={data.etsyConnected} canConnectEtsy={data.canConnectEtsy} />
      <PrintifyWebhookCard origin={publicAppOrigin()} secretSet={data.webhookSecretSet} events={data.printifyEvents} />
      <CronOpsPanel stages={toStageSnapshots(data.lastRuns, data.stages)} origin={publicAppOrigin()} />
      <SetupGuide
        presence={data.presence}
        etsyConnected={data.etsyConnected}
        canConnectEtsy={data.canConnectEtsy}
        redirectUri={etsyRedirectUri()}
      />
    </div>
  );
}
