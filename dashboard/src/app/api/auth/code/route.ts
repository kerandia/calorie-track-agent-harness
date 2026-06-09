import { NextResponse, type NextRequest } from "next/server";
import { consumeLoginToken } from "@/lib/redis";
import { setSession } from "@/lib/auth";

export const runtime = "nodejs";

// Magic-link login: the bot mints a one-time token (login:{token} -> telegram
// id) and DMs the user this link. We consume the token and set the session.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim();
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }

  const tenantId = await consumeLoginToken(token);
  if (!tenantId) {
    return NextResponse.redirect(
      new URL("/?error=expired", req.nextUrl.origin),
    );
  }

  await setSession(tenantId);
  return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
}
