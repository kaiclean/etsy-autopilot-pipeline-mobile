import { AppShell } from "@/components/app-shell";
import { getShellData } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const shell = await getShellData();
  return <AppShell shell={shell}>{children}</AppShell>;
}
