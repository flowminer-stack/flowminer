/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Semantic surfaces — resolve via CSS variables
        surface: {
          0: 'rgb(var(--c-s0) / <alpha-value>)',
          1: 'rgb(var(--c-s1) / <alpha-value>)',
          2: 'rgb(var(--c-s2) / <alpha-value>)',
          3: 'rgb(var(--c-s3) / <alpha-value>)',
          4: 'rgb(var(--c-s4) / <alpha-value>)',
          5: 'rgb(var(--c-s5) / <alpha-value>)',
        },
        // Foreground (text)
        fg: {
          DEFAULT: 'rgb(var(--c-fg) / <alpha-value>)',
          secondary: 'rgb(var(--c-fg2) / <alpha-value>)',
          muted: 'rgb(var(--c-fgm) / <alpha-value>)',
          faint: 'rgb(var(--c-fgf) / <alpha-value>)',
          ghost: 'rgb(var(--c-fgg) / <alpha-value>)',
        },
        // Borders
        line: {
          DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
          strong: 'rgb(var(--c-lines) / <alpha-value>)',
        },
        // Subtle tint (hover states, pills)
        tint: {
          DEFAULT: 'rgb(var(--c-tint) / <alpha-value>)',
        },
        // Accent
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-h) / <alpha-value>)',
          muted: 'var(--c-accent-muted)',
          subtle: 'var(--c-accent-subtle)',
        },
        // Semantic status colors — target of the design-token codemod.
        // Everything flagged as "error", "success", "warning" across the
        // app routes through these so themes only need to define four
        // variables per mood.
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--c-success) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--c-warning) / <alpha-value>)',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in': 'slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(4px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
    },
  },
  plugins: [],
};
