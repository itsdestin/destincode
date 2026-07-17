import React from 'react';
import { useTheme } from '../state/theme-context';

export function ThemeBg() {
  const { bgStyle, patternStyle } = useTheme();
  return (
    <>
      {bgStyle && <div id="theme-bg" style={bgStyle as unknown as React.CSSProperties} aria-hidden="true" />}
      {patternStyle && <div id="theme-pattern" style={patternStyle as unknown as React.CSSProperties} aria-hidden="true" />}
    </>
  );
}
