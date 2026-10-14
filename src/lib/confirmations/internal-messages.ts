// Persist inbound coaching-chat messages. Called only after the group has
// been classified internal — prospect bodies never reach this function.
import { prisma } from "@/lib/db";
import type { InternalInboundDraft } from "./internal-group";

export async function saveInternalInboundMessage(
  draft: InternalInboundDraft,
  internalName: string | null
): Promise<void> {
  if (draft.messageHandle) {
    const existing = await prisma.sendblueInternalMessage.findUnique({
      where: { messageHandle: draft.messageHandle },
      select: { id: true },
    });
    if (existing) return;
  }
  try {
    await prisma.sendblueInternalMessage.create({
      data: {
        groupId: draft.groupId,
        senderNumber: draft.senderNumber,
        text: draft.text,
        mediaUrl: draft.mediaUrl,
        sentAt: draft.sentAt,
        messageHandle: draft.messageHandle,
        internalName,
      },
    });
  } catch (err) {
    // Retry landed between the find and the insert.
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002";
}
