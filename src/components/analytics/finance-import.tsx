"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FINANCE_IMPORT_MAX_BYTES } from "@/lib/finance-import-limits";

export function FinanceImport({ etsyShopId }: { etsyShopId: string | null }) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const example = {
    etsyShopId: etsyShopId ?? "YOUR_NUMERIC_ETSY_SHOP_ID",
    authorizedSellerData: true,
    sourceKind: "seller_export",
    sourceRef: "ledger-2026-10",
    observations: [{
      observationRef: "entry-123",
      ledgerType: "transaction_fee",
      component: "fee",
      status: "actual",
      amount: "-125",
      divisor: 100,
      currency: "CHF",
      occurredAt: "2026-10-01T12:00:00Z",
    }],
  };
  return (
    <details className="space-y-3 text-xs">
      <summary className="cursor-pointer font-medium">Import authorized financial observations</summary>
      <p className="mt-3 text-muted-foreground">
        No financial API endpoint is verified. Normalize a seller export into the JSON format below;
        do not upload raw CSV, buyer names, emails, addresses or descriptions.
        This only records evidence. It never changes orders, listings, inventory or ads.
      </p>
      <p className="text-muted-foreground">
        Keep sourceRef stable for the same ledger and observationRef stable for each entry.
        Re-imports are idempotent; changed evidence needs a new sourceRef. Amount is the original
        signed integer string, divided by divisor, in the original currency. Use a negative amount
        for charges; a component is not a profit calculation. Unknown types use component unknown
        and retain their ledgerType code. Optional etsyListingId and receiptId must match this shop.
        Status is actual, estimated, or unavailable (amount null).
        Actual means seller-reported evidence, not independent API verification or complete profit.
      </p>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3">{JSON.stringify(example, null, 2)}</pre>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
        I am authorized to import this shop&apos;s seller data and have removed all personal data.
      </label>
      <input
        aria-label="Normalized financial evidence JSON"
        type="file"
        accept=".json,application/json"
        disabled={!authorized || !etsyShopId || busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          event.target.value = "";
          setBusy(true);
          setMessage("");
          try {
            if (file.size > FINANCE_IMPORT_MAX_BYTES) throw new Error("Import exceeds 256000 bytes.");
            const response = await fetch("/api/etsy/finance/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: await file.text(),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error ?? "Import failed.");
            setMessage(`${result.accepted} unique observations accepted (including unchanged re-imports). Actual profit remains unavailable pending reconciliation.`);
            router.refresh();
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "Import failed.");
          } finally { setBusy(false); }
        }}
      />
      {!etsyShopId && <p>Connect an Etsy shop identity before importing evidence.</p>}
      <p role="status">{busy ? "Importing evidence…" : message}</p>
    </details>
  );
}
