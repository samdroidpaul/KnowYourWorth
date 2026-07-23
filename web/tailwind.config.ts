import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        ink: {
          50: "#f7f8fa",
          100: "#eef0f4",
          200: "#dde1ea",
          300: "#bfc6d4",
          400: "#8b94a8",
          500: "#5b6577",
          600: "#3f4859",
          700: "#2b3344",
          800: "#1b2230",
          900: "#0e1320",
          950: "#070a14",
        },
        accent: {
          50: "#effdf6",
          100: "#d8fbe9",
          200: "#b3f5d3",
          300: "#7eebb6",
          400: "#42d894",
          500: "#1cbf78",
          600: "#0f9c63",
          700: "#0d7c51",
          800: "#0e6243",
          900: "#0d5038",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(255,255,255,0.04), 0 30px 80px -20px rgba(28,191,120,0.25)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 30px 60px -30px rgba(7,10,20,0.5)",
      },
      animation: {
        "fade-in": "fadeIn 0.4s ease-out both",
        "pulse-soft": "pulseSoft 1.6s ease-in-out infinite",
        shimmer: "shimmer 2.2s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
