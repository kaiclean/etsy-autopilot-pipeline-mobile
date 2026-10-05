import type { ShopIdentity } from "@/lib/shop-identity";
import { cn } from "@/lib/utils";

export function ShopIdentityStrip({ identity }: { identity: ShopIdentity }) {
  return (
    <div data-testid="shop-identity-strip" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold" data-testid="shop-display-name">
          {identity.displayName}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" data-testid="shop-handle">
          {identity.handle}
        </div>
      </div>
      <span className="font-mono text-[11px] text-muted-foreground" data-testid="shop-id" title="ETSY_SHOP_ID">
        {identity.shopIdLabel}
      </span>
      <span
        data-testid="publish-pip"
        data-mode={identity.publishMode}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide",
          identity.publishMode === "live" ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground",
        )}
      >
        <span className={cn("size-1.5 rounded-full", identity.publishMode === "live" ? "bg-warning" : "bg-muted-foreground")} aria-hidden />
        {identity.publishMode}
      </span>
      <span
        data-testid="kill-pip"
        data-on={identity.killSwitch ? "true" : "false"}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide",
          identity.killSwitch ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
        )}
      >
        <span className={cn("size-1.5 rounded-full", identity.killSwitch ? "bg-destructive" : "bg-success")} aria-hidden />
        {identity.killSwitch ? "Kill on" : "Kill off"}
      </span>
      {identity.host ? (
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline" data-testid="shop-host">
          {identity.host}
        </span>
      ) : null}
    </div>
  );
}
