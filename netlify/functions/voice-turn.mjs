// POST /api/voice-turn { action: "turn", ... } with x-lcp-voice: one Call Brain turn (ported from A2Z, where turns share /api/ask).
import { voice } from './voice.mjs';

export default (request, context) => voice(request, context, true);
export const config = { path: '/api/voice-turn' };
