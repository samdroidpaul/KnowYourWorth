import { NextRequest } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import { GoogleAuth } from "google-auth-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const streamAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

type ChatBody = {
  userId?: string;
  sessionId?: string;
  message?: string;
};

function env() {
  const base = process.env.AGENT_SERVICE_URL;
  const app = process.env.AGENT_APP_NAME || "orchestrator";
  if (!base) throw new Error("AGENT_SERVICE_URL is not set.");
  return { base: base.replace(/\/$/, ""), app };
}

const auth = new GoogleAuth();
let idTokenProviderPromise: ReturnType<GoogleAuth["getIdTokenClient"]> | null = null;
async function getIdToken(audience: string): Promise<string> {
  if (!idTokenProviderPromise) {
    idTokenProviderPromise = auth.getIdTokenClient(audience);
  }
  const client = await idTokenProviderPromise;
  return client.idTokenProvider.fetchIdToken(audience);
}

function sseError(message: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const payload = JSON.stringify({ type: "error", message });
      controller.enqueue(enc.encode(`event: client_error\ndata: ${payload}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return sseError("Invalid request body.");
  }
  const { userId, sessionId, message } = body;
  if (!userId || !sessionId || !message) {
    return sseError("userId, sessionId, and message are required.");
  }

  let cfg: { base: string; app: string };
  try {
    cfg = env();
  } catch (e) {
    console.error("chat proxy config error", e);
    return sseError(e instanceof Error ? e.message : "Service not configured");
  }

  let token: string;
  try {
    token = await getIdToken(cfg.base);
  } catch (e) {
    console.error("chat proxy token mint error", e);
    return sseError(`Could not authenticate to the agent service: ${String(e)}`);
  }

  const payload = {
    appName: cfg.app,
    userId,
    sessionId,
    streaming: true,
    newMessage: {
      role: "user",
      parts: [{ text: message }],
    },
  };

  let upstream: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    upstream = await undiciFetch(`${cfg.base}/run_sse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      dispatcher: streamAgent,
    });
  } catch (e) {
    console.error("chat proxy fetch error", e);
    return sseError(`Could not reach the agent service: ${String(e)}`);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("chat upstream error", upstream.status, text.slice(0, 300));
    return sseError(
      `Agent service returned ${upstream.status}. ${text.slice(0, 300)}`
    );
  }

  return new Response(upstream.body as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}