import { NextResponse, type NextRequest } from "next/server";
import { setSession } from "@/lib/auth";

export const runtime = "nodejs";

// DEV-ONLY login bypass: set a session for a given Telegram id without the
// Login Widget (which needs a registered domain). Disabled in production.
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "disabled" }, { status: 404 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json(
      { error: "pass ?id=<your telegram numeric id>" },
      { status: 400 },
    );
  }
  await setSession(id);
  return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
}
