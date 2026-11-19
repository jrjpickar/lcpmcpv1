import { mountVoice } from './voice.js';

const launch = new URLSearchParams(location.hash.slice(1)).get('launch') || '';
history.replaceState(null, '', location.pathname + location.search);
const call = mountVoice(document.getElementById('voice-panel'), { launch });
if (!launch) call.unavailable();
