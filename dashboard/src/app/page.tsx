import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import ManifestoField from "@/components/ManifestoField";

// Full-viewport typographic manifesto landing (nell.ai spirit) driven by a
// real particle system: each word is a body with a home spring, wind drag,
// and soft-contact repulsion — words flow toward each other but can never
// touch (see ManifestoField). Previous conventional landing: /classic.

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "Sezo_AI_bot";
const TG_URL = `https://t.me/${BOT}`;

export default async function Landing() {
  const tenantId = await getSessionTenantId();
  if (tenantId) redirect("/dashboard");

  return (
    <div className="mani">
      <a className="m-logo" href="/classic" title="Sezo">
        <span className="m-logo-mark">🍎</span> sezo
      </a>
      <a className="m-top-btn" href="/login" title="Login to dashboard">
        →
      </a>

      <main className="m-viewport">
        <ManifestoField tgUrl={TG_URL} />
        <div className="m-wind m-wind-1" aria-hidden="true" />
        <div className="m-wind m-wind-2" aria-hidden="true" />
      </main>
    </div>
  );
}
