import { POD_PRESETS } from "@/lib/fees";
import { landedCostChf, quoteIsFresh, sameSupplier, type SourcingChoice, type SourcingQuote } from "@/lib/sourcing";

export function SourcingTable({ quotes, choices, now = new Date() }: {
  quotes: SourcingQuote[];
  choices: (SourcingChoice & { preset: string; region: string })[];
  now?: Date;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr>{["Product", "Region", "Supplier / provider", "Stock", "Base USD", "Shipping USD", "Landed CHF", "Production days", "Fetched at", "Choice"].map((label) => <th className="p-2" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {quotes.map((quote) => {
            const chosen = choices.find((choice) => choice.preset === quote.preset && choice.region === quote.region && sameSupplier(choice, quote));
            const landed = landedCostChf(quote);
            return (
              <tr key={`${quote.preset}:${quote.region}:${quote.supplier}:${quote.providerRef}`} className="border-t">
                <td className="p-2">{POD_PRESETS[quote.preset].label}</td>
                <td className="p-2">{quote.region}</td>
                <td className="p-2">{quote.supplier} / {quote.providerRef ?? "—"}</td>
                <td className="p-2">{quote.inStock == null ? "—" : quote.inStock ? "In stock" : "Out of stock"}</td>
                <td className="p-2">{quote.baseCostUsd?.toFixed(2) ?? "—"}</td>
                <td className="p-2">{quote.shippingUsd?.toFixed(2) ?? "—"}</td>
                <td className="p-2">{landed?.toFixed(2) ?? "—"}</td>
                <td className="p-2">{quote.productionDays ?? "—"}</td>
                <td className="p-2">{quote.sourceUrl ? <a href={quote.sourceUrl} rel="noreferrer" target="_blank">{quote.fetchedAt.toISOString()}</a> : quote.fetchedAt.toISOString()}{!quoteIsFresh(quote.fetchedAt, now) ? " · stale" : ""}</td>
                <td className="p-2">{chosen ? "Chosen" : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!quotes.length && <p className="p-2 text-muted-foreground">No quotes yet. Run Maintenance after connecting a supplier.</p>}
    </div>
  );
}
