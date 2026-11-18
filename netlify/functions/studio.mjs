import { createStudioHandler } from './lib/studio.mjs';

export default createStudioHandler(async () => {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'lcp-studio', consistency: 'strong' });
});

export const config = { path: '/api/studio' };
