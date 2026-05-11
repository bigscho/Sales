import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MAX_EXPORT = 30_000;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = Math.min(parseInt(params.get("limit") || String(MAX_EXPORT)), MAX_EXPORT);
  const search = params.get("search");
  const state = params.get("state");
  const city = params.get("city");
  const minProd = params.get("minProd") ? parseInt(params.get("minProd")!) : null;
  const maxProd = params.get("maxProd") ? parseInt(params.get("maxProd")!) : null;
  const minVolume = params.get("minVolume") ? BigInt(params.get("minVolume")!) : null;
  const maxVolume = params.get("maxVolume") ? BigInt(params.get("maxVolume")!) : null;
  const contacted = params.get("contacted");

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { brokerage: { contains: search, mode: "insensitive" } },
    ];
  }

  if (state) where.state = { equals: state, mode: "insensitive" };
  if (city) where.city = { contains: city, mode: "insensitive" };

  if (minProd !== null || maxProd !== null) {
    where.avgTransactions = {};
    if (minProd !== null) (where.avgTransactions as Record<string, unknown>).gte = minProd;
    if (maxProd !== null) (where.avgTransactions as Record<string, unknown>).lte = maxProd;
  }

  if (minVolume !== null || maxVolume !== null) {
    where.avgVolumeCents = {};
    if (minVolume !== null) (where.avgVolumeCents as Record<string, unknown>).gte = minVolume;
    if (maxVolume !== null) (where.avgVolumeCents as Record<string, unknown>).lte = maxVolume;
  }

  if (contacted === "true") {
    where.outboundPushes = { some: {} };
  } else if (contacted === "false") {
    where.outboundPushes = { none: {} };
  }

  const agents = await prisma.agent.findMany({
    where,
    orderBy: { avgTransactions: "desc" },
    take: limit,
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      city: true,
      state: true,
      totalTransactions: true,
      totalVolumeCents: true,
    },
  });

  // Build CSV — matches enrichment tool column format
  const rows = [
    ["first_name", "last_name", "email", "Phone Number", "City", "State", "total_transactions", "total_value"],
    ...agents.map((a) => [
      a.firstName,
      a.lastName,
      a.email ?? "",
      a.phone ?? "",
      a.city ?? "",
      a.state ?? "",
      a.totalTransactions?.toString() ?? "",
      a.totalVolumeCents ? (Number(a.totalVolumeCents) / 100).toFixed(0) : "",
    ]),
  ];

  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

  const filename = `agents_export_${agents.length}_${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
