import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Generates a banner illustration for a finished salary report using
 * Google's Gemini image model. The prompt is derived from the report's
 * dominant role(s) and location. Returns { image: dataUri | null } — null
 * whenever generation isn't possible (no key, upstream error), so the UI
 * can skip the banner without failing.
 *
 * Requires GEMINI_API_KEY (server-side only; free key from Google AI Studio).
 */

const MODEL = process.env.BANNER_IMAGE_MODEL || "gemini-2.5-flash-image";

type BannerBody = {
  roles?: Array<{ title?: string; pct?: number }>;
  location?: string;
};

export async function POST(req: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json({ image: null, reason: "not-configured" });
  }

  let body: BannerBody;
  try {
    body = (await req.json()) as BannerBody;
  } catch {
    return NextResponse.json({ image: null, reason: "bad-request" });
  }

  const roles = (body.roles ?? [])
    .filter((r) => typeof r.title === "string" && r.title)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  if (roles.length === 0) {
    return NextResponse.json({ image: null, reason: "no-roles" });
  }

  const main = roles[0].title as string;
  const others = roles
    .slice(1, 3)
    .map((r) => r.title)
    .join(" and ");
  const where = body.location ? ` in ${body.location}` : "";

  const prompt =
    `Wide panoramic banner illustration for a professional salary report. ` +
    `Main scene: a ${main} at work${where}.` +
    (others ? ` Subtle background hints of ${others} work.` : "") +
    ` Style: modern, calm, flat illustration with soft depth and gentle ` +
    `lighting; muted professional palette with green accents (#1cbf78). ` +
    `Composition must read well when cropped to a very wide, short banner. ` +
    `Strictly no text, no words, no numbers, no logos, no watermarks.`;

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "16:9" },
          },
        }),
        signal: AbortSignal.timeout(60000),
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error(`banner: upstream ${upstream.status}`, detail.slice(0, 300));
      return NextResponse.json({ image: null, reason: `upstream-${upstream.status}` });
    }

    const data = (await upstream.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
    };
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) {
      return NextResponse.json({ image: null, reason: "no-image-in-response" });
    }
    const mime = part.inlineData.mimeType || "image/png";
    return NextResponse.json({
      image: `data:${mime};base64,${part.inlineData.data}`,
      alt: `Illustration of a ${main} at work${where}`,
    });
  } catch (e) {
    console.error("banner: generation failed", e);
    return NextResponse.json({ image: null, reason: "error" });
  }
}
