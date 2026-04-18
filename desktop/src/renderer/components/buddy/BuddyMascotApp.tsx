import { useEffect } from 'react';
import { BuddyMascot } from './BuddyMascot';
import { ThemeProvider } from '../../state/theme-context';

export function BuddyMascotApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-mascot');
  }, []);

  // ThemeProvider is required for useThemeMascot to resolve theme-specific
  // mascot assets. Without it, useTheme() returns the default context where
  // activeTheme is undefined and every mascot call falls back to the emoji.
  // Transparency is preserved via the [data-mode="buddy-mascot"] rules in
  // buddy.css, which override --canvas and body background.
  return (
    <ThemeProvider>
      <BuddyMascot />
    </ThemeProvider>
  );
}
