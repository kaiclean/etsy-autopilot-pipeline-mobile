import { NextResponse } from "next/server";
import { saveAutomation, setKillSwitch } from "@/app/actions";
import { getSettingsData } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSettingsData());
}

export async function PATCH(req: Request) {
  const body = await req.json();
  if (typeof body.killSwitch === "boolean") await setKillSwitch(body.killSwitch);
  const rest = { ...body };
  delete rest.killSwitch;
  if (Object.keys(rest).length) await saveAutomation(rest);
  return NextResponse.json(await getSettingsData());
}
