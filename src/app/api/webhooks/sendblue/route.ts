import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/confirmations/worklist";
import { maybeSendOriginationReply } from "@/lib/confirmations/origination";
import { SENDBLUE_LINE } from "@/lib/sendblue";
import {
  classifyInboundGroup,
  draftInternalInbound,
  internalGroupConfigFromEnv,
  internalGroupWrite,
  mergeParticipants,
  participantsToStore,
  shouldRecordInbound,
  withSenderEmail,
} from "@/lib/confirmations/internal-group";
import { saveInternalInboundMessage } from "@/lib/confirmations/internal-messages";

// SendBlue inbound webhook. Two jobs:
//  1. Learn group_ids and match them to bookings by prospect phone. The setter
//     creates the iMessage group at booking and adds our line — the first
//     message in that group is the inbound event that registers the group here
//     and makes the booking sendable.
//  2. Origination reply: answer that first setter text within seconds
//     ("Thanks Jake, talk Tuesday John. Definitely check out the FAQ^!").
//     Gated + deduped in lib/confirmations/origination.ts — safe to call on
//     every inbound message.
//
// Coaching groups (setters, closers, any other SENDBLUE_INTERNAL_GROUPS
// entry) are the exception. Each is still saved — the bot needs group_id —
// but never matched and never answered. The id is only known once this
// webhook fires, so the group is recognized from its member list first.
// See lib/confirmations/internal-group.ts.
//
// Prospect replies themselves are read by the rep in the SendBlue app (no
// content parsing); we only stamp lastInboundAt. Inbound text is persisted
// only for an exact internal-group match.
//
// iMessage-by-email members show up as the Apple ID email in `participants`
// and, when they are the sender, in `from_number` / `number`. Those emails are
// part of the roster (and are stored) so a setters chat that includes one can
// still match. A phone from_number is not merged in — that field alone is not
// a roster. Groups that merely contain an internal handle are not flagged
// here; origination refuses them on its own.

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Only care about inbound messages that carry a group_id
    const groupId: string | undefined = body.group_id;
    const fromNumber: string | undefined = body.from_number || body.number;
    const isOutbound: boolean = body.is_outbound === true;

    if (!groupId) {
      return NextResponse.json({ received: true, action: "no_group_ignored" });
    }

    // Collect the roster from the payload (shape varies — log-friendly, never
    // trust a single field). An explicit participants array is the full roster;
    // from_number alone is not. An Apple ID email on from_number is folded in
    // when the array omitted it. Stored rows keep phones as sent and emails
    // canonical, so a later origination read can see the email handle.
    const participantsExplicit = Array.isArray(body.participants);
    const listed: unknown[] = participantsExplicit
      ? (body.participants as unknown[])
      : fromNumber
        ? [fromNumber]
        : [];
    const participants = participantsExplicit ? withSenderEmail(listed, fromNumber) : listed;
    // Booking match stays phone-only, and only against this payload — an email
    // handle must not be looked up as a prospect number.
    const candidateNumbers = participantsToStore(participants, SENDBLUE_LINE).filter(
      (n) => !n.includes("@")
    );

    const existing = await prisma.sendblueGroup.findUnique({ where: { groupId } });
    const storedParticipants = mergeParticipants(
      existing?.participants,
      participants,
      SENDBLUE_LINE
    );
    const cfg = internalGroupConfigFromEnv();
    if (cfg.error) console.error(cfg.error);
    const match = classifyInboundGroup({
      groupId,
      participants,
      participantsExplicit,
      lineNumber: SENDBLUE_LINE,
      groups: cfg.groups,
      alreadyInternal: existing?.internal === true,
      alreadyName: existing?.internalName,
    });
    const internal = match.internal;
    if (internal && !existing?.internal) {
      console.log(
        `SendBlue group ${groupId} classified as internal group "${match.name ?? "unnamed"}"; skipping booking match and origination`
      );
    }

    // Try to match a booking by any candidate number (upcoming or recent demos).
    // Skipped entirely for the internal chat so a setter's own number can never
    // attach a booking. Prospect groups run the same loop as before.
    let matchedBookingId: string | null = null;
    let matchedPhone: string | null = null;
    if (!internal) {
      const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      for (const num of candidateNumbers) {
        const norm = normalizePhone(num);
        if (!norm) continue;
        const booking = await prisma.booking.findFirst({
          where: {
            supersededAt: null,
            prospectPhone: { contains: norm },
            demoDate: { gte: windowStart },
          },
          orderBy: { demoDate: "desc" },
          select: { id: true, prospectPhone: true },
        });
        if (booking) {
          matchedBookingId = booking.id;
          matchedPhone = booking.prospectPhone;
          break;
        }
      }
    }

    // internalGroupWrite is {} for a prospect group, so that upsert's columns
    // stay exactly the pre-existing ones. For the coaching chat it clears any
    // booking link. Applied on update only — create sets the same fields
    // explicitly so keys aren't overwritten in the object literal.
    const internalFields = internalGroupWrite(match);
    const fallbackPhone =
      candidateNumbers[0] == null ? null : String(candidateNumbers[0]);
    if (existing) {
      await prisma.sendblueGroup.update({
        where: { groupId },
        data: {
          ...(isOutbound ? {} : { lastInboundAt: new Date() }),
          // Backfill a match if we didn't have one yet — never overwrite one.
          // Internal groups never backfill; internalFields clears a prior link.
          ...(matchedBookingId && !existing.bookingId && !internal
            ? { bookingId: matchedBookingId, prospectPhone: matchedPhone }
            : {}),
          ...internalFields,
          participants: JSON.stringify(storedParticipants),
        },
      });
    } else {
      await prisma.sendblueGroup.create({
        data: {
          groupId,
          participants: JSON.stringify(storedParticipants),
          prospectPhone: internal ? null : matchedPhone || fallbackPhone,
          bookingId: internal ? null : matchedBookingId,
          lastInboundAt: isOutbound ? null : new Date(),
          ...(internal ? { internal: true as const, internalName: match.name } : {}),
        },
      });
    }

    // Coaching log: inbound bodies from configured internal groups only
    // (setters, closers, …). A failure here must not echo the message text
    // back to SendBlue — retry on 500.
    if (shouldRecordInbound(internal, isOutbound)) {
      const draft = draftInternalInbound(body, groupId);
      if (!draft) {
        console.error(`Internal group ${groupId} inbound had no sender; message not stored`);
      } else {
        try {
          await saveInternalInboundMessage(draft, match.name);
        } catch (err) {
          console.error(`Failed to store internal group message for ${groupId}`);
          throw new Error(`internal_message_store_failed:${groupId}`, { cause: err });
        }
      }
    }

    // Origination reply on inbound traffic only (our own sends echo back with
    // is_outbound=true). Never let a reply failure 500 the webhook — SendBlue
    // would retry and we'd rather log and move on. The internal chat never
    // gets this reply, including the time-match fallback.
    let origination: { action: string; reason?: string } | null = null;
    if (!isOutbound && internal) {
      origination = { action: "skipped", reason: "internal_group" };
    } else if (!isOutbound) {
      try {
        origination = await maybeSendOriginationReply(groupId);
      } catch (err) {
        console.error("Origination reply failed:", err);
        origination = { action: "failed", reason: String(err) };
      }
    }

    return NextResponse.json({
      received: true,
      action: existing ? "group_updated" : "group_captured",
      matched: !!matchedBookingId,
      origination,
    });
  } catch (error) {
    console.error("SendBlue webhook error:", error);
    const safe =
      error instanceof Error && error.message.startsWith("internal_message_store_failed:")
        ? error.message
        : String(error);
    return NextResponse.json({ error: safe }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "sendblue" });
}
