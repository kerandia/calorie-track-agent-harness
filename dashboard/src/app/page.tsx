import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import LoginButton from "@/components/LoginButton";
import DevLogin from "@/components/DevLogin";

export default async function Home() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";

  return (
    <div className="container">
      <div className="header">
        <h1 className="h1">🍎 Calorie Dashboard</h1>
      </div>
      <div className="panel" style={{ textAlign: "center", padding: 40 }}>
        <p style={{ fontSize: 16, marginBottom: 8 }}>
          See every day&apos;s meals and your calorie calendar.
        </p>
        <p className="muted" style={{ marginBottom: 24 }}>
          Log in with the same Telegram account you chat with the bot from.
        </p>
        {botUsername ? (
          <LoginButton botUsername={botUsername} />
        ) : (
          <p className="muted">
            Set NEXT_PUBLIC_TELEGRAM_BOT_USERNAME to enable login.
          </p>
        )}
        {process.env.NODE_ENV !== "production" ? <DevLogin /> : null}
      </div>
    </div>
  );
}
