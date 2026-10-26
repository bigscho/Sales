import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET: Load setter's demos + verification state for a given week
export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  const setterId = request.nextUrl.searchParams.get("setter");
  if (!weekId || !setterId) {
    return NextResponse.json({ error: "weekId and setter required" }, { status: 400 });
  }

  const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
  if (!setter || setter.role !== "setter") {
    return NextResponse.json({ error: "Setter not found" }, { status: 404 });
  }

  const week = await prisma.week.findUnique({ where: { id: weekId } });
  if (!week) {
    return NextResponse.json({ error: "Week not found" }, { status: 404 });
  }

  // Get demos for this setter in this week
  const demos = await prisma.demo.findMany({
    where: { weekId, booking: { setterId } },
    include: {
      booking: { select: { prospectName: true, prospectEmail: true, demoDate: true, source: true } },
      closer: { select: { id: true, name: true } },
      flags: {
        where: { verification: { setterId } },
        select: { id: true, flagType: true, note: true, ceoAction: true, createdAt: true },
      },
    },
    orderBy: { booking: { demoDate: "asc" } },
  });

  // Get day locks for this week
  const dayLocks = await prisma.dayLock.findMany({
    where: { weekId },
    select: { date: true },
  });
  const lockedDates = new Set(dayLocks.map(l => l.date.toISOString().slice(0, 10)));

  // Get existing verification record
  const verification = await prisma.setterVerification.findUnique({
    where: { setterId_weekId: { setterId, weekId } },
    include: {
      flags: {
        include: { demo: { select: { id: true, booking: { select: { prospectName: true } } } } },
      },
    },
  });

  // Build demo list with lock status and existing flag info
  const demoList = demos.map(d => {
    const demoDateStr = new Date(d.booking.demoDate).toISOString().slice(0, 10);
    const isLocked = lockedDates.has(demoDateStr);
    const existingFlag = d.flags.length > 0 ? d.flags[0] : null;
    return {
      id: d.id,
      prospectName: d.booking.prospectName,
      prospectEmail: d.booking.prospectEmail,
      demoDate: d.booking.demoDate,
      status: d.status,
      closer: d.closer?.name || null,
      source: d.booking.source,
      isLocked,
      existingFlag: existingFlag ? {
        id: existingFlag.id,
        flagType: existingFlag.flagType,
        note: existingFlag.note,
        ceoAction: existingFlag.ceoAction,
      } : null,
    };
  });

  // Missing demo flags (not tied to a demo)
  const missingFlags = verification?.flags.filter(f => f.flagType === "missing_demo") || [];

  return NextResponse.json({
    setter: { id: setter.id, name: setter.name },
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    demos: demoList,
    missingFlags: missingFlags.map(f => ({
      id: f.id,
      prospectName: f.missingProspectName,
      prospectEmail: f.missingProspectEmail,
      demoDate: f.missingDemoDate,
      note: f.note,
      ceoAction: f.ceoAction,
    })),
    verification: verification ? {
      status: verification.status,
      confirmedAt: verification.confirmedAt,
    } : null,
  });
}

// POST: Submit confirmation and/or flags
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { weekId, setterId, flags } = body as {
    weekId: string;
    setterId: string;
    confirmedDemoIds?: string[];
    flags: Array<{
      demoId?: string;
      flagType: "wrong_status" | "not_mine" | "missing_demo";
      note?: string;
      missingProspectName?: string;
      missingProspectEmail?: string;
      missingDemoDate?: string;
    }>;
  };

  if (!weekId || !setterId) {
    return NextResponse.json({ error: "weekId and setter required" }, { status: 400 });
  }

  const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
  if (!setter) {
    return NextResponse.json({ error: "Setter not found" }, { status: 404 });
  }

  // Upsert verification record
  const hasFlags = flags && flags.length > 0;
  const verification = await prisma.setterVerification.upsert({
    where: { setterId_weekId: { setterId, weekId } },
    create: {
      setterId,
      weekId,
      status: hasFlags ? "has_flags" : "confirmed",
      confirmedAt: new Date(),
    },
    update: {
      status: hasFlags ? "has_flags" : "confirmed",
      confirmedAt: new Date(),
    },
  });

  // Award verification bonus credits if confirmed (no flags)
  if (!hasFlags) {
    try {
      const { awardVerificationBonus } = await import("@/lib/credits");
      await awardVerificationBonus(setterId, weekId);
    } catch (err) {
      console.error("Failed to award verification bonus:", err);
    }
  }

  // Create flag records
  const createdFlags = [];
  if (flags && flags.length > 0) {
    for (const flag of flags) {
      const created = await prisma.setterFlag.create({
        data: {
          verificationId: verification.id,
          demoId: flag.demoId || null,
          flagType: flag.flagType,
          note: flag.note || null,
          missingProspectName: flag.missingProspectName || null,
          missingProspectEmail: flag.missingProspectEmail || null,
          missingDemoDate: flag.missingDemoDate || null,
        },
      });
      createdFlags.push(created);
    }
  }

  return NextResponse.json({
    success: true,
    verification: { status: verification.status, confirmedAt: verification.confirmedAt },
    flagsCreated: createdFlags.length,
  });
}
