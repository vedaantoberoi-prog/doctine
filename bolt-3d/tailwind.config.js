/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        cobalt: {
          DEFAULT: '#246BDB',
          deep: '#123B78',
        },
        midnight: '#101C2B',
        ivory: '#F3F1EB',
        sage: '#527D76',
        silver: '#D8DEE6',
        champagne: '#C89A57',
      },
      fontFamily: {
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
