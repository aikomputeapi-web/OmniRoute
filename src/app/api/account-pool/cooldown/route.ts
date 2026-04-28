import { NextResponse } from "next/server";
import { cooldownAccount } from "@/lib/sessionPersistence";

export async function POST(request: Request) {
  try {
    const { accountId, seconds } = await request.json();
    
    if (!accountId || !seconds) {
      return NextResponse.json({ error: "Missing accountId or seconds" }, { status: 400 });
    }

    await cooldownAccount(accountId, seconds);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to cooldown account:", error);
    return NextResponse.json({ error: "Failed to cooldown account" }, { status: 500 });
  }
}
