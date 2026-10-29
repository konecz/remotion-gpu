// D. Heavy effects, no video: rotating conic and radial gradients fullscreen, blobs with a large filter: blur, frosted
// glass panels with backdrop-filter over them, an SVG wave recomputed every frame and an animated feTurbulence
// texture. The kind where rasterization (Vulkan on the GPU, or SwiftShader/Skia on the CPU) weighs the most.
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { color, font, seeded, type Props } from "../common";

const BLOBS = (() => {
  const r = seeded(11);
  return Array.from({ length: 6 }, () => ({ x: r(), y: r(), v: 0.2 + r() * 0.5, size: 300 + r() * 400, h: Math.floor(r() * 360) }));
})();

export const Effects: React.FC<Props> = () => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = width / 1920;
  const t = f / fps;
  const points = Array.from({ length: 160 }, (_, k) => {
    const x = (k / 159) * width;
    const y = height * 0.72 + Math.sin(k / 9 + t * 2.2) * 70 * u + Math.sin(k / 23 - t * 1.3) * 40 * u;
    return `${k === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <AbsoluteFill style={{ background: `conic-gradient(from ${t * 40}deg at 50% 50%, #0f1b2d, #1d4ed8, #7c3aed, #db2777, #f59e0b, #0f1b2d)`, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${50 + 30 * Math.sin(t)}% ${50 + 20 * Math.cos(t * 0.7)}%, rgba(255,255,255,0.35), transparent 55%)` }} />
      {BLOBS.map((m, k) => (
        <div
          key={k}
          style={{
            position: "absolute",
            left: (m.x + 0.15 * Math.sin(t * m.v + k)) * width - (m.size * u) / 2,
            top: (m.y + 0.15 * Math.cos(t * m.v * 1.3 + k)) * height - (m.size * u) / 2,
            width: m.size * u,
            height: m.size * u,
            borderRadius: "50%",
            background: `hsl(${(m.h + t * 30) % 360} 80% 60%)`,
            filter: `blur(${70 * u}px)`,
            opacity: 0.8,
          }}
        />
      ))}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <filter id="noise">
            <feTurbulence type="fractalNoise" baseFrequency={0.006 + 0.002 * Math.sin(t)} numOctaves={3} seed={3} />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="linear" slope={0.5} />
            </feComponentTransfer>
          </filter>
        </defs>
        <rect x={width * 0.06} y={height * 0.08} width={width * 0.36} height={height * 0.4} filter="url(#noise)" />
        <path d={points} stroke={color.light} strokeWidth={6 * u} fill="none" opacity={0.9} />
        <path d={`${points} L${width},${height} L0,${height} Z`} fill="rgba(15,27,45,0.45)" />
      </svg>
      {[0, 1].map((k) => (
        <div
          key={k}
          style={{
            position: "absolute",
            left: width * (0.48 + k * 0.22) + Math.sin(t + k) * 30 * u,
            top: height * (0.12 + k * 0.18),
            width: width * 0.32,
            height: height * 0.34,
            borderRadius: 32 * u,
            background: "rgba(255,255,255,0.12)",
            border: `${2 * u}px solid rgba(255,255,255,0.35)`,
            backdropFilter: `blur(${30 * u}px) saturate(1.6)`,
            boxShadow: `0 ${20 * u}px ${60 * u}px rgba(0,0,0,0.35)`,
            fontFamily: font,
            color: color.light,
            fontWeight: 800,
            fontSize: 64 * u,
            padding: 40 * u,
            boxSizing: "border-box",
          }}
        >
          {k === 0 ? "Frosted glass" : `${(t * 12.5).toFixed(1)} fps`}
        </div>
      ))}
    </AbsoluteFill>
  );
};
