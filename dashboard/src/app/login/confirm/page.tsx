// Side-effect-free landing page for magic-link login. Crawlers (Telegram's
// link preview, messenger prefetchers) GET this page harmlessly; the actual
// token consumption happens only on the POST below, which crawlers don't do.
export default async function LoginConfirm({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";

  return (
    <div className="container">
      <div className="panel" style={{ textAlign: "center", padding: 40 }}>
        {token ? (
          <>
            <p style={{ fontSize: 16, marginBottom: 20 }}>
              Tap to open your dashboard:
            </p>
            <form method="POST" action="/api/auth/code">
              <input type="hidden" name="token" value={token} />
              <button
                className="btn"
                type="submit"
                style={{ fontSize: 16, padding: "12px 28px" }}
              >
                Log in
              </button>
            </form>
          </>
        ) : (
          <p className="muted">
            Missing login token — request a fresh link by sending /login to the
            bot.
          </p>
        )}
      </div>
    </div>
  );
}
