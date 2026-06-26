/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Soften the darkest slate from near-black (#020617) to a deep
        // aviation navy (#0D1829). Every bg-slate-950 in the app was
        // almost pitch black — now it reads as a refined dark blue that's
        // easier on the eyes while staying clearly "dark ops mode."
        slate: {
          950: '#0D1829',
        },
      },
    },
  },
  plugins: [],
};
