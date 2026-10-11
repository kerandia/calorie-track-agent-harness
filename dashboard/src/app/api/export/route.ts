import { getSessionTenantId } from "@/lib/auth";
import { exportTenantData } from "@/lib/redis";

// "Download everything": the signed-in user's raw records as one JSON file.

export const dynamic = "force-dynamic";

export async function GET() {
  const tenantId = await getSessionTenantId();
  if (!tenantId) return new Response("Sign in first.", { status: 401 });

  const exported = {
    exported_at: new Date().toISOString(),
    about:
      "Everything Sezar stores about you: meals, daily totals, profile, what it learned (assumptions), photo memory, " +
      "saved place lists, published pages and maps (with links), and the conversation. Keys are storage keys.",
    data: await exportTenantData(tenantId),
  };
  const day = exported.exported_at.slice(0, 10);
  return new Response(JSON.stringify(exported, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="sezar-export-${day}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
