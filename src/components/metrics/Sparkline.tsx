/* Sparkline — tiny inline SVG sparkline rendered from a number array */

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}

export function Sparkline({
  data,
  width = 80,
  height = 28,
  color = '#7C5CFF',
  fill = false,
}: SparklineProps) {
  const allZero = data.length === 0 || data.every((v) => v === 0);

  if (allZero) {
    const y = height - 2;
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block' }}
        aria-hidden="true"
      >
        <line
          x1={0}
          y1={y}
          x2={width}
          y2={y}
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.3}
        />
      </svg>
    );
  }

  const max = Math.max(...data);
  const safeMax = max === 0 ? 1 : max;
  const points = data.map((v, i) => {
    const x = data.length === 1 ? width / 2 : (i / (data.length - 1)) * width;
    const y = height - 2 - ((v / safeMax) * (height - 4));
    return { x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const fillPath = fill
    ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(height - 2).toFixed(1)} L 0 ${(height - 2).toFixed(1)} Z`
    : '';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      {fill && (
        <path d={fillPath} fill={color} fillOpacity={0.12} stroke="none" />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
