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
        // Legacy: the app-wide shell color. Kept because thousands of
        // existing class names reference it.
        slate: {
          950: '#0D1829',
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
