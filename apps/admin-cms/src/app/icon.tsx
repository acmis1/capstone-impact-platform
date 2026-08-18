import { ImageResponse } from 'next/og';
import {
  APP_MARK_CORNER_RADIUS,
  APP_MARK_ICON_COLORS,
  APP_MARK_PATHS,
  APP_MARK_VIEW_BOX,
} from '../components/ui/app-mark-geometry';

export const size = {
  width: 32,
  height: 32,
};

export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={APP_MARK_VIEW_BOX}
        width="32"
        height="32"
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      >
        <rect
          width="32"
          height="32"
          rx={APP_MARK_CORNER_RADIUS}
          fill={APP_MARK_ICON_COLORS.background}
        />
        {APP_MARK_PATHS.map((path) => (
          <path key={path} d={path} fill={APP_MARK_ICON_COLORS.foreground} />
        ))}
      </svg>
    ),
    {
      ...size,
    }
  );
}
