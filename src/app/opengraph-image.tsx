import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Lumenbay secure P2P marketplace preview";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default async function Image() {
  const icon = await readFile(join(process.cwd(), "public/logo-icon.png"));
  const iconSrc = `data:image/png;base64,${icon.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background:
            "radial-gradient(circle at top left, rgba(59,130,246,0.35), transparent 32%), linear-gradient(135deg, #050505 0%, #0a0f1f 55%, #111827 100%)",
          color: "#ffffff",
          padding: "64px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              fontSize: "28px",
              fontWeight: 700,
              letterSpacing: "-0.04em",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain img only */}
            <img src={iconSrc} alt="" width={72} height={72} />
            Lumenbay
          </div>
          <div
            style={{
              padding: "14px 20px",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              fontSize: "18px",
              color: "#dbeafe",
            }}
          >
            Stellar Soroban Marketplace
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "840px" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: "88px",
              lineHeight: 0.95,
              fontWeight: 900,
              letterSpacing: "-0.06em",
            }}
          >
            Secure P2P
            <br />
            commerce, built
            <br />
            for trust.
          </div>
          <div
            style={{
              fontSize: "30px",
              lineHeight: 1.4,
              color: "#cbd5e1",
              maxWidth: "760px",
            }}
          >
            Decentralized listings, escrow protection, and a premium marketplace experience on Stellar.
          </div>
        </div>

        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {["Escrow", "Marketplace", "Stellar", "Soroban"].map((item) => (
            <div
              key={item}
              style={{
                padding: "12px 18px",
                borderRadius: "999px",
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#e2e8f0",
                fontSize: "18px",
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
