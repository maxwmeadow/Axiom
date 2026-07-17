import darkPlus from '@shikijs/themes/dark-plus'
import type { ThemeRegistration } from 'shiki/core'

/**
 * VS Code's Dark Modern inherits Dark+ token colors and replaces its editor
 * surface colors. Only those editor colors are relevant inside this read-only
 * source viewer; workbench/sidebar colors intentionally remain Axiom-owned.
 */
export const darkModernTheme: ThemeRegistration = {
  ...darkPlus,
  name: 'dark-modern',
  displayName: 'Dark Modern',
  colors: {
    ...darkPlus.colors,
    'editor.background': '#1F1F1F',
    'editor.foreground': '#CCCCCC',
  },
}
