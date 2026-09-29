import { PageHeader } from "@/components/common";
import { ConnectionsPanel } from "@/components/connections-panel";
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
            ? "Command center health. Publishing is locked to dry-run."
            : "Command center health. PUBLISH_MODE is live."
        }
      />
      <ConnectionsPanel checks={data.checks} etsyConnected={data.etsyConnected} canConnectEtsy={data.canConnectEtsy} />
    </div>
  );
}
