import { BusinessBoard } from "@/components/businesses/business-board";
import { PageHeader } from "@/components/common";
import { getDb } from "@/db";
import { listBusinessCards } from "@/lib/businesses";
import { getSetting } from "@/lib/settings";
import { resolveRequestShop } from "@/lib/shops";

export const metadata = { title: "Businesses" };

export default async function BusinessesPage() {
  const db = await getDb();
  const [active, automation] = await Promise.all([
    resolveRequestShop(db).catch(() => null),
    getSetting(db, "automation"),
  ]);
  const cards = await listBusinessCards(db, active?.id ?? null);
  return (
    <div>
      <PageHeader
        title="Businesses"
        subtitle="Each new business starts in dry-run. Typing CONFIRM is required before that business can go live."
      />
      <BusinessBoard cards={cards} globalCap={automation.dailyAiCapChf} />
    </div>
  );
}
