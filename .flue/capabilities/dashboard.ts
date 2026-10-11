import type { ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import { createLoginToken } from "../lib/loginToken.js";

const SECTIONS = {
  health: "/dashboard",
  saved: "/dashboard/saved",
  published: "/dashboard/published",
  you: "/dashboard/you",
} as const;

type Section = keyof typeof SECTIONS;

/** Where a dashboard link lands; a list id deep-links into Saved. */
export function dashboardPath(section: Section, listId?: string): string {
  if (section === "saved" && listId && /^[a-f0-9]{12}$/.test(listId)) return `/dashboard/saved/${listId}`;
  return SECTIONS[section];
}

export function createDashboardCapability(tenantId: string) {
  // ── Links into the web dashboard (one-time login, lands on the right tab) ──

  const dashboardLinkTool: ToolDef = {
    name: "dashboard_link",
    description:
      "A one-time login link (valid 10 minutes) that opens the user's web dashboard on a section: health (calorie calendar, meals), saved (their place lists, or one list with list_id), published (every page and map you made), you (profile, what you've learned about them, linked chats, export and deletion of their data). Use it when they want to see something on a bigger screen, browse a long list, find an old page, or manage their data. Put the link on its own line.",
    parameters: Type.Object({
      section: Type.Union([Type.Literal("health"), Type.Literal("saved"), Type.Literal("published"), Type.Literal("you")]),
      list_id: Type.Optional(Type.String({ description: "A Sezar place list id, to open that list directly." })),
    }),
    execute: async (args) => {
      const base = process.env.DASHBOARD_URL?.replace(/\/+$/, "");
      if (!base) return "The dashboard isn't configured; describe what they'd find there instead.";
      const token = await createLoginToken(tenantId);
      const next = dashboardPath(args.section as Section, args.list_id);
      return `${base}/login/confirm?token=${token}&next=${encodeURIComponent(next)}`;
    },
  };

  return { tools: [dashboardLinkTool] };
}
