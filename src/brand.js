/**
 * Tenant branding.
 *
 * The platform is deployed per operator. Everything that identifies whose
 * operation this is — the wordmark, the accent ink, the name a broker sees on a
 * tracking link — is declared here rather than scattered through components, so
 * standing up a new tenant is a data change and not a hunt through the UI.
 *
 * The accent is applied by writing the same custom properties index.css defines,
 * which is why one value re-accents the whole product: every component reads the
 * Tailwind `accent` token, and that token resolves to these variables.
 */

const BRANDS = {
  skyway: {
    id: 'skyway',
    name: 'Skyway Aviation',
    shortName: 'Skyway',
    legalName: 'Skyway Aviation Services',
    contactEmail: 'charters@flyskyway.com',
    contactPhone: '727-605-5000',
    wordmark: {
      full: { light: '/skyway-logo', dark: '/skyway-logo-reverse' },
      compact: { light: '/skyway-logo-nav', dark: '/skyway-logo-nav-reverse' },
    },
    // Brand cyan. The dark shell needs a lighter ink than the light shell.
    accent: {
      dark: {
        base: '#3FA9CC',
        soft: 'rgba(63, 169, 204, 0.12)',
        border: 'rgba(63, 169, 204, 0.40)',
        contrast: '#06171E',
      },
      light: {
        base: '#12708C',
        soft: 'rgba(18, 112, 140, 0.09)',
        border: 'rgba(18, 112, 140, 0.32)',
        contrast: '#FFFFFF',
      },
    },
  },

  elite: {
    id: 'elite',
    name: 'Elite Jets',
    shortName: 'Elite',
    legalName: 'Elite Jets',
    contactEmail: 'charters@elitejets.com',
    contactPhone: '239-330-4114',
    wordmark: {
      full: { light: '/elite-logo', dark: '/elite-logo-reverse' },
      compact: { light: '/elite-logo-nav', dark: '/elite-logo-nav-reverse' },
    },
    // Brand gold. Lifted slightly on dark so it does not go muddy against
    // graphite, and deepened on light so it holds contrast against white.
    accent: {
      dark: {
        base: '#C9A24B',
        soft: 'rgba(201, 162, 75, 0.13)',
        border: 'rgba(201, 162, 75, 0.42)',
        contrast: '#1A1408',
      },
      light: {
        base: '#8A6A18',
        soft: 'rgba(138, 106, 24, 0.10)',
        border: 'rgba(138, 106, 24, 0.34)',
        contrast: '#FFFFFF',
      },
    },
  },
};

export const DEFAULT_BRAND_ID = 'skyway';

/**
 * Which tenant this instance is running as.
 *
 * A deployment sets VITE_TENANT at build time. The window override exists for
 * the preview harness and tests, which need to switch tenant without a rebuild.
 */
export function activeBrandId() {
  if (typeof window !== 'undefined' && window.__TENANT__) {
    const requested = String(window.__TENANT__);
    if (BRANDS[requested]) return requested;
  }
  const configured = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_TENANT : null;
  if (configured && BRANDS[configured]) return configured;
  return DEFAULT_BRAND_ID;
}

export function brand(id = activeBrandId()) {
  return BRANDS[id] || BRANDS[DEFAULT_BRAND_ID];
}

export function brandIds() {
  return Object.keys(BRANDS);
}

/**
 * Writes the active brand's accent into the document for the given theme.
 *
 * Called on boot and whenever the theme changes, because the two themes carry
 * different inks: an accent that reads on graphite is too pale on white.
 */
export function applyBrandAccent(themeMode = 'dark', id = activeBrandId()) {
  if (typeof document === 'undefined') return;
  const palette = brand(id).accent;
  // Only the light theme ships a separate ink; every dark variant uses the dark set.
  const ink = themeMode === 'classy' ? palette.light : palette.dark;
  const root = document.documentElement;
  root.style.setProperty('--sw-accent', ink.base);
  root.style.setProperty('--sw-accent-soft', ink.soft);
  root.style.setProperty('--sw-accent-border', ink.border);
  root.style.setProperty('--sw-accent-contrast', ink.contrast);
}
