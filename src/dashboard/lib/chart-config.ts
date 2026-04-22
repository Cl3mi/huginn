// Chart.js dark theme configuration for automotive/industrial aesthetic

export const COLORS = {
  background: '#0f1419',
  surface: '#1a1f26',
  border: '#2a3038',
  text: '#e4e6eb',
  textSecondary: '#a0a4ab',
  accent: {
    orange: '#ff6b35',
    red: '#d32f2f',
    green: '#43a047',
    blue: '#1e88e5',
  },
} as const;

export const FONTS = {
  mono: '"IBM Plex Mono", "Fira Code", monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

export function getChartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: {
        labels: {
          color: COLORS.text,
          font: { family: FONTS.mono, size: 12 },
          padding: 15,
          usePointStyle: true,
        },
        align: 'end' as const,
      },
      tooltip: {
        backgroundColor: COLORS.surface,
        titleColor: COLORS.text,
        bodyColor: COLORS.text,
        borderColor: COLORS.border,
        borderWidth: 1,
        padding: 12,
        titleFont: { family: FONTS.mono, size: 12, weight: 'bold' },
        bodyFont: { family: FONTS.mono, size: 11 },
      },
    },
    scales: {
      x: {
        grid: { color: COLORS.border, drawBorder: false },
        ticks: { color: COLORS.textSecondary, font: { family: FONTS.mono, size: 11 } },
      },
      y: {
        grid: { color: COLORS.border, drawBorder: false },
        ticks: { color: COLORS.textSecondary, font: { family: FONTS.mono, size: 11 } },
      },
    },
  };
}

export function scoreToColor(score: number): string {
  // 0-100 gradient: red → orange → green
  if (score < 33) return COLORS.accent.red;
  if (score < 66) return COLORS.accent.orange;
  return COLORS.accent.green;
}

export function scoreToGradient(scores: number[]): string[] {
  return scores.map(scoreToColor);
}
