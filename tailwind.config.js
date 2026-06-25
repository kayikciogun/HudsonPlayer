/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07070a',
          900: '#0a0a0b',
          800: '#121214',
          700: '#1a1a1e',
          600: '#26262c',
          500: '#3a3a42',
          400: '#52525b',
        },
        accent: {
          DEFAULT: '#a78bfa',
          glow: '#c4b5fd',
          deep: '#7c3aed',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 30px -8px rgba(167, 139, 250, 0.45)',
        'glow-sm': '0 0 12px -2px rgba(167, 139, 250, 0.35)',
        'glow-lg': '0 0 50px -10px rgba(167, 139, 250, 0.55)',
        player: '0 -20px 40px -20px rgba(0, 0, 0, 0.6)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'eq-1': 'eq 0.8s ease-in-out infinite',
        'eq-2': 'eq 0.6s ease-in-out infinite 0.15s',
        'eq-3': 'eq 1s ease-in-out infinite 0.3s',
        'pulse-glow': 'pulse-glow 2.4s ease-in-out infinite',
      },
      keyframes: {
        eq: {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
      },
      backgroundImage: {
        'glow-radial':
          'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(167, 139, 250, 0.15), transparent)',
      },
    },
  },
  plugins: [],
}