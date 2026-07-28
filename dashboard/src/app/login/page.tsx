import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import LoginButton from "@/components/LoginButton";
import DevLogin from "@/components/DevLogin";

export default async function Login() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";

  return (
    <div className="container" style={{ maxWidth: 560 }}>
      <div className="header">
        <h1 className="h1">
          <a href="/" style={{ color: "inherit" }}>
            🍎 Sezo
          </a>
        </h1>
      </div>
      <div className="panel" style={{ textAlign: "center", padding: 40 }}>
        <p style={{ fontSize: 16, marginBottom: 8 }}>
          See every day&apos;s meals and your calorie calendar.
        </p>
        <p className="muted" style={{ marginBottom: 24 }}>
          Fastest way in: send <strong>/login</strong> to the bot on Telegram
          and tap the link it sends back.
        </p>
        {botUsername ? (
          <>
            <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              Or use Telegram login directly:
            </p>
            <LoginButton botUsername={botUsername} />
          </>
        ) : (
          <p className="muted">
            Set NEXT_PUBLIC_TELEGRAM_BOT_USERNAME to enable login.
          </p>
        )}
        {process.env.NODE_ENV !== "production" ? <DevLogin /> : null}
        <p className="muted" style={{ fontSize: 13, marginTop: 26 }}>
          New here?{" "}
          <a
            href={`https://t.me/${botUsername || "Sezo_AI_bot"}`}
            target="_blank"
            rel="noreferrer"
          >
            Start chatting with Sezo on Telegram →
          </a>
        </p>
      </div>
    </div>
  );
}
