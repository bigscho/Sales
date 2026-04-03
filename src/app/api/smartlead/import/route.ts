import { NextRequest, NextResponse } from "next/server";
import {
  findCampaignByName,
  importLeadsToCampaign,
  parseCSVToLeads,
} from "@/lib/smartlead";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const campaignName = formData.get("campaign_name") as string | null;
    const override = formData.get("override") === "true";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (!campaignName) {
      return NextResponse.json({ error: "No campaign_name provided" }, { status: 400 });
    }

    // Find campaign by name
    const campaign = await findCampaignByName(campaignName);
    if (!campaign) {
      return NextResponse.json(
        { error: `Campaign "${campaignName}" not found in Smartlead` },
        { status: 404 }
      );
    }

    // Parse CSV
    const csvContent = await file.text();
    const leads = parseCSVToLeads(csvContent);

    if (leads.length === 0) {
      return NextResponse.json({ error: "No valid leads found in CSV" }, { status: 400 });
    }

    // Import to Smartlead with override
    const result = await importLeadsToCampaign(campaign.id, leads, override);

    // Log the sync
    await prisma.syncLog.create({
      data: {
        source: "smartlead",
        syncType: override ? "import_override" : "import",
        status: result.ok ? "success" : "error",
        recordsSynced: leads.length,
        errorMessage: result.error,
        completedAt: new Date(),
      },
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      campaign: { id: campaign.id, name: campaign.name },
      leads_imported: leads.length,
      override_enabled: override,
      smartlead_response: result.data,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
