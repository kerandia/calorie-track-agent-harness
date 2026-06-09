import { NextResponse, type NextRequest } from "next/server";
import { consumeLoginToken } from "@/lib/redis";
import { setSession } from "@/lib/auth";

export const runtime = "nodejs";

// Magic-link login: the bot mints a one-time token (login:{token} -> telegram
// id) and DMs the user a link to /login/confirm, which POSTs here.
//
// Consumption happens ONLY on POST: link-preview crawlers GET every URL in a
// Telegram message, and a consuming GET would burn the token before the user
// ever taps it (this exact bug shipped once — don't reintroduce it).
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const token = form?.get("token")?.toString().trim();
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 400 });
  }

  const tenantId = await consumeLoginToken(token);
  if (!tenantId) {
    return NextResponse.redirect(
      new URL("/?error=expired", req.nextUrl.origin),
      { status: 303 },
    );
  }

  await setSession(tenantId);
  return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin), {
    status: 303,
  });
}

// Old links (or prefetchers) that GET this endpoint get bounced to the
// landing page without consuming anything.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const url = new URL("/login/confirm", req.nextUrl.origin);
  if (token) url.searchParams.set("token", token);
  return NextResponse.redirect(url);
}
