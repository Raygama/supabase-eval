import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#3ecf8e', dark: '#249361' }, // Supabase green
      },
    },
  },
  plugins: [],
};

export default config;
