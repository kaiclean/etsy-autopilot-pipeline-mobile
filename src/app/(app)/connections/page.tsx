import { PageHeader } from "@/components/common";
import { ConnectionsPanel } from "@/components/connections-panel";
import { GoLiveControl } from "@/components/go-live-control";
import { SetupGuide } from "@/components/setup-guide";
import { etsyRedirectUri } from "@/lib/setup-guide";
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
      <SetupGuide
        presence={data.presence}
        etsyConnected={data.etsyConnected}
        canConnectEtsy={data.canConnectEtsy}
        redirectUri={etsyRedirectUri()}
      />
    </div>
  );
}
