import { defineTheme } from '@astryxdesign/core/theme'

/** Brand constants for places that need literal colors (SVG strokes,
 * WebGL uniforms): the #285A48 brand family on ChatGPT blacks. */
export const cellPalette = {
  background: '#000000',
  surface: '#171717',
  text: '#ECECEC',
  textSecondary: '#AFAFAF',
  brand: '#285A48',
  brandBright: '#35805F',
  brandTint: '#7FB8A4',
} as const
import { neutralTheme } from '@astryxdesign/theme-neutral/built'

/**
 * Cell theme — ChatGPT-style blacks (pure black ground, gray
 * surfaces, #ECECEC text) with #285A48 as the subtle brand accent
 * (logo, highlights). The app forces dark mode.
 */
export const cellTheme = defineTheme({
  name: 'cell-carbon',
  extends: neutralTheme,
  tokens: {
    // ChatGPT-style blacks; #285A48 appears only as branding accent
    '--color-background-body': ['#F7F7F7', '#000000'],
    '--color-background-surface': ['#FFFFFF', '#0A0A0A'],
    '--color-background-card': ['#FFFFFF', '#171717'],
    '--color-background-popover': ['#FFFFFF', '#1F1F1F'],
    '--color-background-muted': ['#EDEDED', '#262626'],
    '--color-text-primary': ['#0D0D0D', '#ECECEC'],
    '--color-text-secondary': ['#5D5D5D', '#AFAFAF'],
    '--color-text-accent': ['#285A48', '#7FB8A4'],
    '--color-accent': ['#285A48', '#285A48'],
    '--color-accent-muted': ['#DCE8E1', '#12291F'],
    '--color-border': ['#E3E3E3', '#2A2A2A'],
    '--color-border-emphasized': ['#C9C9C9', '#3A3A3A'],
    '--color-icon-primary': ['#0D0D0D', '#ECECEC'],
    '--color-icon-accent': ['#285A48', '#7FB8A4'],
    '--color-success': ['#285A48', '#7FB8A4'],
  },
})
