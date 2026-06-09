import { NextResponse, type NextRequest } from "next/server";
import { verifyTelegramAuth, setSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN not configured" },
      { status: 500 },
    );
  }

  const data: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    data[key] = value;
  });

  const result = verifyTelegramAuth(data, botToken);
  if (!result.ok) {
    return NextResponse.json(
      { error: `Telegram auth failed: ${result.reason}` },
      { status: 401 },
    );
  }

  await setSession(result.tenantId);
  return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
}
