/** @type {import('tailwindcss').Config} */

/* =============================================================================
   SKYWAY DESIGN TOKENS
   =============================================================================
   Every token resolves to a CSS custom property defined in src/index.css.
   The variables are re-declared under [data-theme="classy"], so a single
   utility class renders correctly in both themes without a parallel
   !important override sheet.

   Use the semantic names (surface / border / content / status) rather than
   raw slate-* utilities in new code. The slate palette is kept intact so the
   existing screens keep rendering while they are migrated.
   ============================================================================= */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* ── LEGACY PALETTE REDEFINITION ────────────────────────────────────
           About 5,000 `slate-*` and 1,300 `cyan-*` utilities predate the token
           system, so the interface read as blue no matter what the tokens said.
           Redefining the two palettes here retunes every one of those call
           sites at once — including opacity modifiers and hover variants,
           which a stylesheet override could not reach cleanly.

           Slate becomes a neutral graphite: the same lightness at each step, so
           surfaces and hairlines keep their depth, with the blue cast removed.
           The brand cyan in the logo then becomes the only saturated colour on
           screen, which is what makes it read as deliberate. */
        slate: {
          50:  '#F7F8F9',
          100: '#EDEEF0',
          200: '#DCDEE1',
          300: '#C5C8CD',
          400: '#92969E',
          500: '#686D76',
          600: '#4B5058',
          700: '#363A41',
          800: '#212429',
          900: '#121417',
          950: '#0A0B0D',
        },

        /* Cyan keeps the logo's hue family but drops the neon. #09B0DC is the
           mark's exact blue; these sit a little deeper and less electric so
           large fills and borders stay comfortable at length. */
        cyan: {
          50:  '#EFF8FC',
          100: '#D5EDF6',
          200: '#A9D8EA',
          300: '#74C4DF',
          400: '#3FA9CC',
          500: '#1B90B8',
          600: '#166F8F',
          700: '#135A74',
          800: '#134A5E',
          900: '#133E4E',
        },

        // Backgrounds, lightest-on-top ordering.
        surface: {
          DEFAULT: 'var(--sw-surface)',        // cards + panels
          raised: 'var(--sw-surface-raised)',  // inputs, hovered rows, popovers
          sunken: 'var(--sw-surface-sunken)',  // wells, table headers
          shell: 'var(--sw-bg)',               // app background
        },

        // Hairlines. `strong` is for focused/active boundaries.
        edge: {
          DEFAULT: 'var(--sw-border)',
          strong: 'var(--sw-border-strong)',
        },

        // Text. Named `content` so it never collides with Tailwind's `text-*`
        // sizing utilities in a reader's head.
        content: {
          DEFAULT: 'var(--sw-text)',
          muted: 'var(--sw-text-muted)',
          subtle: 'var(--sw-text-subtle)',
          inverse: 'var(--sw-text-inverse)',
        },

        // The single brand accent. Reserved for active nav, primary actions,
        // and aircraft in motion — not for warnings, not for emphasis.
        accent: {
          DEFAULT: 'var(--sw-accent)',
          soft: 'var(--sw-accent-soft)',
          border: 'var(--sw-accent-border)',
          contrast: 'var(--sw-accent-contrast)',
        },

        // Semantic status. These must never be aliased to each other —
        // a warning that renders cyan is the bug this palette exists to stop.
        success: {
          DEFAULT: 'var(--sw-success)',
          soft: 'var(--sw-success-soft)',
          border: 'var(--sw-success-border)',
        },
        warning: {
          DEFAULT: 'var(--sw-warning)',
          soft: 'var(--sw-warning-soft)',
          border: 'var(--sw-warning-border)',
        },
        danger: {
          DEFAULT: 'var(--sw-danger)',
          soft: 'var(--sw-danger-soft)',
          border: 'var(--sw-danger-border)',
        },
        info: {
          DEFAULT: 'var(--sw-info)',
          soft: 'var(--sw-info-soft)',
          border: 'var(--sw-info-border)',
        },
      },

      fontFamily: {
        // Bebas: reserved for large numerals and hero headings only.
        display: ['Bebas Neue', 'sans-serif'],
        // DM Sans: every label, button, body string.
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        // JetBrains Mono: tail numbers, times, codes, IDs. Nothing else.
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },

      fontSize: {
        // Floor is 11px. The old 8-10px labels were the single biggest
        // reason the UI read as a debug overlay rather than a product.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],      // 11px
        xs: ['0.75rem', { lineHeight: '1.125rem' }],       // 12px
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],      // 13px — default UI
        base: ['0.9375rem', { lineHeight: '1.5rem' }],     // 15px
      },

      borderRadius: {
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
      },

      boxShadow: {
        card: 'var(--sw-shadow-card)',
        raised: 'var(--sw-shadow-raised)',
        overlay: 'var(--sw-shadow-overlay)',
      },

      // 8px base grid.
      spacing: {
        13: '3.25rem',
        18: '4.5rem',
      },

      keyframes: {
        'sw-toast-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'sw-fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'toast-in': 'sw-toast-in 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'sw-fade-in 0.15s ease-out',
      },
    },
  },
  plugins: [],
};
