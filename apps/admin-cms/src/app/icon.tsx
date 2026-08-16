import { ImageResponse } from 'next/og';

export const size = {
  width: 32,
  height: 32,
};

export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#e61e2a',
          borderRadius: '6px',
          color: '#ffffff',
          fontWeight: 800,
          fontSize: 16,
          fontFamily: 'sans-serif',
          letterSpacing: '-0.5px',
        }}
      >
        CI
      </div>
    ),
    {
      ...size,
    }
  );
}
