// Opt-out gate. Inbound STOP / opted_out rows live in ConfirmationOptOut.
// A send checks the table before it claims. Unknown numbers are not held.

import { prisma } from "@/lib/db";
import { inboundOptOutIdentity, optOutPhone, type OptOutIdentity } from "./guards";

export { inboundOptOutIdentity, isOptOutText, optOutPhone } from "./guards";

export interface OptOutIndex {
  phones: Set<string>;
  groups: Set<string>;
}

export async function loadOptOutIndex(): Promise<OptOutIndex> {
  const rows = await prisma.confirmationOptOut.findMany({
    select: { phone: true, groupId: true },
  });
  return {
    phones: new Set(rows.map((r) => r.phone).filter((p) => p)),
    groups: new Set(rows.map((r) => r.groupId).filter((g) => g)),
  };
}

export function matchesOptOut(index: OptOutIndex, phone: string | null, groupId: string | null): boolean {
  const norm = optOutPhone(phone);
  if (norm && index.phones.has(norm)) return true;
  if (groupId && index.groups.has(groupId)) return true;
  return false;
}

export async function isRecipientOptedOut(phone: string | null, groupId: string | null): Promise<boolean> {
  const norm = optOutPhone(phone);
  const ors: Array<{ phone: string } | { groupId: string }> = [];
  if (norm) ors.push({ phone: norm });
  if (groupId) ors.push({ groupId });
  if (ors.length === 0) return false;
  const hit = await prisma.confirmationOptOut.findFirst({
    where: { OR: ors },
    select: { id: true },
  });
  return !!hit;
}

export async function saveOptOut(ident: OptOutIdentity): Promise<void> {
  await prisma.confirmationOptOut.upsert({
    where: { phone_groupId: { phone: ident.phone, groupId: ident.groupId } },
    create: ident,
    update: { reason: ident.reason, source: ident.source },
  });
}

export async function recordInboundOptOut(input: {
  content?: string | null;
  optedOut?: boolean;
  fromNumber?: string | null;
  groupId?: string | null;
}): Promise<boolean> {
  const ident = inboundOptOutIdentity(input);
  if (!ident) return false;
  await saveOptOut(ident);
  return true;
}
