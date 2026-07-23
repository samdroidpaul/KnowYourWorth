import { NextRequest, NextResponse } from "next/server";
import { GoogleAuth } from "google-auth-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function env() {
  const base = process.env.AGENT_SERVICE_URL;
  const app = process.env.AGENT_APP_NAME || "orchestrator";
  if (!base) {
    throw new Error(
      "AGENT_SERVICE_URL is not set. Copy .env.local.example to .env.local and fill it in."
    );
  }
  return { base: base.replace(/\/$/, ""), app };
}

// One auth instance for the lifetime of the module. The audience is the
// orchestrator's base URL (no path). Cloud Run's IAM proxy validates the `aud`
// claim against exactly this value.
const auth = new GoogleAuth();
let clientPromise: ReturnType<GoogleAuth["getIdTokenClient"]> | null = null;
function getClient() {
  if (!clientPromise) {
    const { base } = env();
    clientPromise = auth.getIdTokenClient(base);
  }
  return clientPromise;
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") || "";
  const sessionId = req.nextUrl.searchParams.get("sessionId") || "";
  if (!userId || !sessionId) {
    return NextResponse.json(
      { error: "userId and sessionId are required" },
      { status: 400 }
    );
  }

  let cfg: { base: string; app: string };
  try {
    cfg = env();
  } catch (e) {
    console.error("proxy config error", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Service not configured" },
      { status: 500 }
    );
  }

  const url = `${cfg.base}/apps/${encodeURIComponent(cfg.app)}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`;

  try {
    const client = await getClient();
    const upstream = await client.request<string>({
      url,
      method: "GET",
      headers: { accept: "application/json" },
      responseType: "text",
      validateStatus: () => true,
    });
    const text = String(upstream.data ?? "");
    if (upstream.status < 200 || upstream.status >= 300) {
      console.error("upstream error", upstream.status, text.slice(0, 400));
      return NextResponse.json(
        { error: `Upstream ${upstream.status}`, detail: text.slice(0, 400) },
        { status: 502 }
      );
    }
    return new NextResponse(text, {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    console.error("proxy fetch error", e);
    return NextResponse.json(
      { error: "Could not reach the agent service.", detail: String(e) },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { userId?: string };
  try {
    body = (await req.json()) as { userId?: string };
  } catch {
    body = {};
  }
  const userId = (body.userId || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  let cfg: { base: string; app: string };
  try {
    cfg = env();
  } catch (e) {
    console.error("proxy config error", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Service not configured" },
      { status: 500 }
    );
  }

  const url = `${cfg.base}/apps/${encodeURIComponent(cfg.app)}/users/${encodeURIComponent(userId)}/sessions`;

  let text = "";
  let status = 0;
  try {
    const client = await getClient();
    const upstream = await client.request<string>({
      url,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      data: "{}",
      responseType: "text",
      validateStatus: () => true,
    });
    text = String(upstream.data ?? "");
    status = upstream.status;
  } catch (e) {
    console.error("proxy fetch error", e);
    return NextResponse.json(
      { error: "Could not reach the agent service.", detail: String(e) },
      { status: 502 }
    );
  }

  if (status < 200 || status >= 300) {
    console.error("upstream error", status, text.slice(0, 800));
    return NextResponse.json(
      { error: `Upstream ${status}`, detail: text.slice(0, 800) },
      { status: 502 }
    );
  }

  let sessionId = "";
  try {
    const parsed = JSON.parse(text);
    sessionId = parsed.id || parsed.session_id || parsed.sessionId || "";
  } catch {
    sessionId = text.replace(/^"|"$/g, "");
  }
  if (!sessionId) {
    return NextResponse.json(
      { error: "Agent did not return a session id.", detail: text.slice(0, 400) },
      { status: 502 }
    );
  }
  return NextResponse.json({ sessionId });
}