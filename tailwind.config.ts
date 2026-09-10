import type { Config } from 'tailwindcss';

/**
 * 语义化颜色 token：全部通过 CSS 变量驱动，支持亮暗主题切换。
 * 深色主题默认启用，沿用旧版 LibreTV（backup-2025）赛博配色并整体调深一档（#0b101a 页面 / #141c29 面板 / #0d141f 卡片 / #00ccff 霓虹蓝主色）。
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: 'rgb(var(--c-page) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          raised: 'rgb(var(--c-surface-raised) / <alpha-value>)',
        },
        card: 'rgb(var(--c-card) / <alpha-value>)',
        chip: 'rgb(var(--c-chip) / <alpha-value>)',
        hover: 'rgb(var(--c-hover) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        content: 'rgb(var(--c-content) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        faint: 'rgb(var(--c-faint) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
        },
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
