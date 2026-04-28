import { NextResponse } from "next/server";
import { resetErrorCount } from "@/lib/accountPool";

export async function POST(request: Request) {
  try {
    const { accountId } = await request.json();
    
    if (!accountId) {
      return NextResponse.json({ error: "Missing accountId" }, { status: 400 });
    }

    await resetErrorCount(accountId);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to reset error count:", error);
    return NextResponse.json({ error: "Failed to reset error count" }, { status: 500 });
  }
}
