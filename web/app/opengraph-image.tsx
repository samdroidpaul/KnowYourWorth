import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #070a14 0%, #0e1320 55%, #0d5038 140%)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 44 }}>
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: 18,
              background: "linear-gradient(135deg, #42d894, #0d7c51)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 800,
              color: "white",
            }}
          >
            K
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: "white", letterSpacing: -0.5 }}>
              Know Your Worth
            </div>
            <div style={{ fontSize: 18, color: "#8b94a8" }}>
              Supporting information for any salary discussions.
            </div>
          </div>
        </div>
        <div style={{ fontSize: 54, fontWeight: 800, color: "white", lineHeight: 1.15, maxWidth: 920 }}>
          Walk in knowing what you&apos;re worth.
        </div>
        <div style={{ fontSize: 24, color: "#c7cbd4", marginTop: 24, maxWidth: 820 }}>
          A short conversation, grounded in real market data — for Australia and New Zealand.
        </div>
      </div>
    ),
    { ...size }
  );
}
