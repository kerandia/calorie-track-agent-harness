"use client";

import { useState } from "react";

export default function DevLogin() {
  const [id, setId] = useState("");
  return (
    <form
      action="/api/auth/dev"
      method="GET"
      style={{
        marginTop: 24,
        paddingTop: 20,
        borderTop: "1px dashed var(--border)",
      }}
    >
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Dev only — skip Telegram and view your data by entering your Telegram
        numeric id:
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <input
          name="id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 8416309828"
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 14,
            width: 200,
          }}
        />
        <button className="btn" type="submit">
          Enter
        </button>
      </div>
    </form>
  );
}
