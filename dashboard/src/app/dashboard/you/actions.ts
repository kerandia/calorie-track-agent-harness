"use server";

import { revalidatePath } from "next/cache";
import { getSessionTenantId } from "@/lib/auth";
import { setAssumptionStatus, unlinkPhone } from "@/lib/redis";

// Server actions run with the signed-in session; Next checks the request's
// origin, so another site can't post these on the user's behalf.

export async function decideAssumption(formData: FormData): Promise<void> {
  const tenantId = await getSessionTenantId();
  if (!tenantId) return;
  const id = String(formData.get("id") ?? "");
  const status = formData.get("status");
  if (status !== "confirmed" && status !== "rejected") return;
  await setAssumptionStatus(tenantId, id, status);
  revalidatePath("/dashboard/you");
}

export async function unlinkMyPhone(): Promise<void> {
  const tenantId = await getSessionTenantId();
  if (!tenantId) return;
  await unlinkPhone(tenantId);
  revalidatePath("/dashboard/you");
}
