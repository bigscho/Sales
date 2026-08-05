import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/confirmations/worklist";
import { SENDBLUE_LINE } from "@/lib/sendblue";

// SendBlue inbound webhook. One job in v1: learn group_ids and match them to
// bookings by prospect phone. The setter creates the iMessage group at booking
// and adds our line — the first message in that group is the inbound event
// that registers the group here and makes the booking sendable.
//
// Replies themselves are read by the rep in the SendBlue app (v1 does no
// content parsing); we only stamp lastInboundAt.

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

    // Collect candidate participant numbers from the payload (shape varies —
    // log-friendly, never trust a single field)
    const participants: string[] = Array.isArray(body.participants)
      ? body.participants
      : [fromNumber].filter(Boolean);
    const lineNorm = normalizePhone(SENDBLUE_LINE);
    const candidateNumbers = participants.filter(
      (n) => normalizePhone(n) && normalizePhone(n) !== lineNorm
    );

    // Try to match a booking by any candidate number (upcoming or recent demos)
    let matchedBookingId: string | null = null;
    let matchedPhone: string | null = null;
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

    const existing = await prisma.sendblueGroup.findUnique({ where: { groupId } });
    if (existing) {
      await prisma.sendblueGroup.update({
        where: { groupId },
        data: {
          ...(isOutbound ? {} : { lastInboundAt: new Date() }),
          // Backfill a match if we didn't have one yet — never overwrite one
          ...(matchedBookingId && !existing.bookingId
            ? { bookingId: matchedBookingId, prospectPhone: matchedPhone }
            : {}),
          participants: JSON.stringify(
            Array.from(
              new Set([
                ...(existing.participants ? JSON.parse(existing.participants) : []),
                ...candidateNumbers,
              ])
            )
          ),
        },
      });
    } else {
      await prisma.sendblueGroup.create({
        data: {
          groupId,
          participants: JSON.stringify(candidateNumbers),
          prospectPhone: matchedPhone || candidateNumbers[0] || null,
          bookingId: matchedBookingId,
          lastInboundAt: isOutbound ? null : new Date(),
        },
      });
    }

    return NextResponse.json({
      received: true,
      action: existing ? "group_updated" : "group_captured",
      matched: !!matchedBookingId,
    });
  } catch (error) {
    console.error("SendBlue webhook error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "sendblue" });
}
