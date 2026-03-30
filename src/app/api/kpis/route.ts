import { NextRequest, NextResponse } from "next/server";
import { calculateWeeklyKPIs } from "@/lib/kpis";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  try {
    const kpis = await calculateWeeklyKPIs(weekId);
    return NextResponse.json(kpis);
  } catch (error) {
    console.error("KPI calculation error:", error);
    return NextResponse.json({ error: "Failed to calculate KPIs" }, { status: 500 });
  }
}
