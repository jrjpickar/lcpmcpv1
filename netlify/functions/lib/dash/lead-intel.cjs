// Lead intelligence for the Leads page: who needs action today, where
// qualified sellers come from, and what is blocking the next contract.
// Pure functions shared by the browser (window.LeadIntel) and node tests.
// Nothing here writes to GHL, Twilio or the dashboard store.
(function (root) {
  const HOUR = 3600000, DAY = 86400000;

  /* ---------------- Tunables (one place to change the rules) ---------------- */
  const CONFIG = {
    replySlaHours: { hot: 1, default: 4 },          // team owes a reply within
    callbackSlaHours: 4,                            // seller asked for a call
    replyLookbackDays: 21,                          // older unanswered replies fall to follow-up
    followUpDays: { hot: 2, warm: 3, nurture: 14, unknown: 3 },
    evalToOfferDays: 2,                             // Run Numbers / Eval Done -> offer
    offerDecisionDays: 3,                           // Offer Sent -> decision
    verbalToContractDays: 1,                        // Verbal Acceptance -> contract out
    readinessDecayDays: 45,
    staleAfterMinutes: { calls: 30, texts: 30, contacts: 180, opportunities: 180, appointments: 360 },
    minWorkedForRanking: 30,
    contactCallSeconds: 65,                         // a call longer than this counts as a contact (65s screens out most voicemails)
  };

  // ACQ stage groups. Stage names are compared case/punctuation-insensitively.
  const ACQ_PIPELINE = 'ACQ Pipeline';
  const FOLLOW_UP_PIPELINES = ['ACQ Pipeline', 'Retail Pipeline'];
  const stageKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const NOT_READY_STAGE = 'notready';   // never counts toward qualified sellers
  const GHOSTED_STAGE = 'ghosted';      // counts, shown as the Ghosted branch
  const STAGES = {
    eval: ['runnumbers', 'evaldone'],
    verbal: ['verbalacceptance'],
    offer: ['offersent'],
    contract: ['inescrow', 'inspectionperiod', 'pending', 'closed'],
    declined: ['offerdeclinedhot', 'offerdeclinedwarm', 'offerdeclinedcold'],
  };
  function stageGroup(opp) {
    if (!opp || opp.pipeline !== ACQ_PIPELINE) return '';
    if (opp.status === 'won') return 'contract';
    const k = stageKey(opp.stage);
    for (const [group, list] of Object.entries(STAGES)) if (list.includes(k)) return group;
    return 'early';
  }
  // Funnel stages (stage name only, status ignored): offers presented =
  // Verbal Acceptance, Offer Sent or any Offer Declined stage; contracts signed =
  // In Escrow, Pending or Closed.
  const isAcqPipeline = name => /^\s*acq/i.test(String(name || ''));
  function funnelStage(opp) {
    if (!opp || !isAcqPipeline(opp.pipeline)) return '';
    const k = stageKey(opp.stage);
    if (STAGES.contract.includes(k)) return 'contract';
    if (STAGES.verbal.includes(k) || STAGES.offer.includes(k) || STAGES.declined.includes(k)) return 'offer';
    return '';
  }
  const OFFER_GROUPS = new Set(['verbal', 'offer', 'contract', 'declined']);

  /* ---------------- Message + conversation dispositions ---------------- */
  const DISPOSITIONS = ['ownership_confirmed', 'open_to_selling', 'offer_requested', 'callback_requested', 'future_follow_up', 'price_mismatch', 'wrong_number', 'rejection', 'opt_out'];
  const LABELS = {
    ownership_confirmed: 'Ownership confirmed', open_to_selling: 'Open to selling', offer_requested: 'Offer requested',
    callback_requested: 'Callback requested', future_follow_up: 'Future follow-up', price_mismatch: 'Price mismatch',
    wrong_number: 'Wrong number', rejection: 'Rejection', opt_out: 'Opt-out', none: 'No reply yet', unclear: 'Replied - no clear signal',
  };
  const DEAD = new Set(['wrong_number', 'rejection', 'opt_out']);
  const INTEREST = new Set(['open_to_selling', 'offer_requested', 'callback_requested']);

  const P = {
    opt_out: [/^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove)\s*[.!]*\s*$/i, /\b(remove me|take me off|unsubscribe|do not (text|contact|message|call)|don'?t (text|contact|message|call) me|stop (texting|messaging|contacting|calling)|never (text|contact|call)|lose (this|my) number)\b/i],
    wrong_number: [/\bwrong (number|person|house|address)\b/i, /\b(i'?m|i am|we'?re|we are) not (the )?owners?\b/i, /\b(don'?t|do not|never) (own|owned)\b/i, /\bno longer own\b/i, /\b(already )?sold (it|the (house|property|home)|that (house|property))\b/i, /\bno (one|body) (here )?by that name\b/i, /\bnot (my|our) (house|property|home)\b/i],
    rejection: [/\bnot interested\b/i, /\bno interest\b/i, /\bnot open to\b/i, /\b(i'?m|i am|we'?re|we are) good\b[\s,.!]*(thanks?|thank you|no)?[\s.!]*$/i, /\bplease (stop|remove)\b/i, /\bno,? thanks?( you)?\b/i, /\bnot (for sale|selling)\b/i, /\b(don'?t|do not|never) (want|plan|intend) to sell\b/i, /\bnot looking to sell\b/i, /\bleave me alone\b/i, /\bhard pass\b/i, /\b(keeping|keep) (it|the (house|property))\b/i],
    price_mismatch: [/\btoo low\b/i, /\blow ?ball/i, /\bway (too )?low\b/i, /\b(won'?t|will not|wouldn'?t|not going to) (take|accept|go|sell for) (less|lower|under|below|that)\b/i, /\bneed (at least|more)\b/i, /\bworth (more|at least)\b/i, /\b(that'?s|it'?s|thats|its) not enough\b/i, /\binsult/i, /\b(zillow|redfin|appraised|appraisal) (says|at|for|is)\b/i],
    offer_requested: [/\bwhat('?s| is| would be| will be) (your|the) offer\b/i, /\bmake (me )?an offer\b/i, /\bsend (me )?(an |your |the )?offer\b/i, /\bhow much (would|will|can|could|are) you (pay|offer|give|offering)\b/i, /\bwhat (would|can|could|will) you (pay|offer|give)\b/i, /^\s*how much\s*[?.!]*\s*$/i, /\bhow much\s*[?.!]*\s*$/i, /\b(what|how much) (are|r) (you|u) (offering|paying)\b/i, /\b(cash|best) offer\b/i, /\bwhat('?s| is) your (number|price)\b/i],
    future_follow_up: [/\bnot (right )?now\b/i, /\bnot (at the moment|at this time|yet)\b/i, /\bmaybe (later|next|in)\b/i, /\bnext (year|month|spring|summer|fall|winter)\b/i, /\bin a (few|couple( of)?) (months|weeks|years)\b/i, /\b(check|reach|follow) (back|up)( with me)? (later|in|next|after)\b/i, /\bnot ready\b/i, /\bdown the road\b/i, /\b(contact|text|call|reach) (me|out|us) (later|in a|next|after)\b/i, /\bafter the (holidays|new year|first)\b/i],
    callback_requested: [/\bcall me\b/i, /\bgive me a (call|ring)\b/i, /\b(can|could) you (call|give me a call)\b/i, /\bplease call\b/i, /\bcall (me )?(back|tomorrow|tonight|after|at|anytime|any time)\b/i, /\b(you can|feel free to) call\b/i, /\bbest time to (call|reach)\b/i, /\bavailable to talk\b/i],
    open_to_selling: [/\b(i'?m|i am|we'?re|we are|would be|might be|could be|i'?d be) (open|interested|willing)\b/i, /\bopen to (selling|offers?|an offer|it|that)\b/i, /\binterested in selling\b/i, /\b(i|we) (want|would like|need|'?d like|might want|plan) to sell\b/i, /\bthinking (about|of) selling\b/i, /\b(it'?s|its|is) for sale\b/i, /\bdepends on (the )?(price|offer|number)\b/i, /\bfor the right (price|number|offer)\b/i, /\btell me more\b/i, /\bsend (me )?(info|information|details)\b/i, /\blet'?s (talk|chat|do it)\b/i, /\bi'?m (listening|all ears)\b/i],
    ownership_confirmed: [/\b(i|we) (still )?own (it|the (house|property|home)|that)\b/i, /\b(i'?m|i am|we'?re|we are) the (owners?|homeowners?)\b/i, /\b(it'?s|its|that'?s|thats) (mine|ours|my (house|property|home))\b/i, /\bmy (house|property|home)\b/i, /\bthis is (the )?owner\b/i, /\byes,? (i|we) (do|own)\b/i],
  };
  // Short replies whose meaning depends on what the team just asked.
  const WEAK = {
    open_to_selling: /^\s*(yes+|yeah|yea|ya|yep|yup|sure|ok(ay)?|k|maybe|possibly|perhaps|depends|si|sí|correct|absolutely|definitely|of course|i do|i am|i would|i might|we do|we are|we would|sounds good|that works|works for me|why not|could be|potentially)\b(\s*(,|\.|!)?\s*(i am|i do|it is|we are|we do|i would|sir|ma'?am|please|thanks?|thank you|it'?s me|that'?s me|this is (he|she|him|her|me)))?[\s.!?,]*$/i,
    rejection: /^\s*(no+|nope|nah|pass|not really|no sir|no ma'?am|no thanks?|negative)\b[\s.!?,]*$/i,
    identity: /^\s*(speaking|this is (he|she|him|her|me)|that'?s me|it'?s me|yes,? (it is|this is (he|she|him|her|me))|you got (him|her|me))\b[\s.!?,]*$/i,
  };
  // Positive phrases that a nearby negation turns around ("no need to call me",
  // "I'm not open to selling", "don't make me an offer").
  const NEGATABLE = new Set(['open_to_selling', 'offer_requested', 'callback_requested']);
  const NEGATION_BEFORE = /\b(not|no|don'?t|do not|never|stop|won'?t|wouldn'?t|no need to|nobody|isn'?t|aren'?t)\b[\w\s']{0,14}$/i;
  function matches(key, text) {
    return P[key].some(re => {
      const m = re.exec(text);
      if (!m) return false;
      if (!NEGATABLE.has(key)) return true;
      return !NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index));
    });
  }

  // What the team's last outbound text asked, so a short "yes" / "no" can be
  // read in context. Only the final question in the text counts ("Hi, is this
  // the owner of 12 Main St? Would you take a cash offer?" asks about selling).
  const PROMPTS = [
    ['offer_review', /\b((would|will|could|does|do) (that|this|it) (number|price|offer|amount)? ?(work|be ok|be okay|be acceptable)|(would|will|could) you (accept|take|consider) (\$|[0-9]|that|this|it|our)|accept (an? |our |the |this )?offer|work for you)\b/i],
    ['call', /\b((good|best|ok|okay|convenient|better) time to (call|talk|chat|connect)|(can|may|could|should) (i|we) (give you a |call|ring)|(free|available|around) (to|for a|for) (call|talk|chat|quick call)|hop on a (quick )?call|(talk|chat|speak) (by|over the) phone|set up a (quick )?call)\b/i],
    ['interest', /\b(interested|open|willing|consider(ing)?|thinking|thought|plans?|looking) (in|to|about|on|of)? ?(an? |our |a cash )?(sell|selling|sale|offer|offers|cash offer|letting it go)|\b(sell|selling) (it|the (house|property|home|lot|land)|your (house|property|home|lot|land))|\b(cash )?offer on (it|the|your)|\b(would|will|do|could) you (want to |like to |be willing to |ever )?sell|\bstill (interested|thinking|considering|want to sell)|\bany (interest|chance)|\bmake (you )?an offer|\bready to sell|\bfor sale\?/i],
    ['ownership', /\b((are|r) (you|u) (still )?(the )?(home ?|property )?owners?|(do|did) (you|u) (still )?own|is this (still )?(the )?(home ?|property )?owners?|owner of (record|the property)|still own)\b/i],
    ['identity', /^\s*(hi|hey|hello|good (morning|afternoon|evening))?[\s,]*(is this|am i (speaking|talking) (to|with)|are you) [a-z][a-z'-]+( [a-z][a-z'-]+)?\s*\?/i],
  ];
  function promptType(prompt) {
    const text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const questions = text.split(/(?<=\?)/).filter(q => q.includes('?'));
    const last = questions.length ? questions[questions.length - 1] : '';
    for (const scope of [last, text]) {
      if (!scope) continue;
      for (const [type, re] of PROMPTS) if (re.test(scope)) return type;
      if (scope === last) continue;
    }
    return questions.length ? 'question' : 'statement';
  }
  // Meaning of a short reply, given the question it answers.
  const CONTEXT_READING = {
    interest: { yes: 'open_to_selling', no: 'rejection' },
    offer_review: { yes: 'open_to_selling', no: 'price_mismatch' },
    call: { yes: 'callback_requested', no: null },
    ownership: { yes: 'ownership_confirmed', no: 'wrong_number' },
    identity: { yes: 'ownership_confirmed', no: 'wrong_number' },
  };
  // Within one message: a definite "not the owner / no" outranks interest; a
  // softened no ("not interested right now") is a future follow-up.
  const PRIORITY = ['opt_out', 'wrong_number', 'price_mismatch', 'rejection', 'offer_requested', 'future_follow_up', 'callback_requested', 'open_to_selling', 'ownership_confirmed'];

  const REACTION = /^\s*(liked|loved|laughed at|emphasi[sz]ed|disliked|questioned|reacted\s+\S{1,12}\s+to|removed\s+an?\s+\S+(\s+\S+)?\s+from)\s+["“'‘]/i;
  function stripQuoted(text) {
    let t = String(text || '');
    const cut = t.search(/(^|\n)\s*(on .{3,120}wrote:|-{2,}\s*original message|from:\s.+\nsent:)/i);
    if (cut >= 0) t = t.slice(0, cut);
    const lines = t.split(/\r?\n/);
    const kept = lines.filter(l => !/^\s*>/.test(l));
    return { text: kept.join('\n').trim(), quoted: cut >= 0 || kept.length !== lines.length };
  }
  function isEmojiOnly(text) {
    if (!text) return false;
    let rest;
    try { rest = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣\s\p{P}\p{S}]/gu, ''); }
    catch { rest = text.replace(/[\s.!?,]/g, ''); }
    return rest.length === 0;
  }

  function classifyMessage(body, opts = {}) {
    const raw = String(body || '');
    const system = `${opts.status || ''} ${opts.error || ''}`;
    if (REACTION.test(raw)) return { kind: 'reaction', signals: [], primary: null, strength: null, quoted: false };
    const { text, quoted } = stripQuoted(raw);
    if (!text && !/opt.?out/i.test(system)) return { kind: quoted ? 'quote_only' : 'empty', signals: [], primary: null, strength: null, quoted };
    if (isEmojiOnly(text) && !/opt.?out/i.test(system)) return { kind: 'reaction', signals: [], primary: null, strength: null, quoted };
    const signals = [];
    if (/opt.?out/i.test(system)) signals.push('opt_out');
    for (const key of PRIORITY) if (!signals.includes(key) && matches(key, text)) signals.push(key);
    let strength = signals.length ? 'explicit' : null;
    const prompt = promptType(opts.prompt);
    if (!signals.length) {
      // A short reply is read against the team's last question when there is one.
      const answer = WEAK.identity.test(text) ? 'identity' : WEAK.rejection.test(text) ? 'no' : WEAK.open_to_selling.test(text) ? 'yes' : '';
      const reading = CONTEXT_READING[prompt];
      if (answer === 'identity') { signals.push('ownership_confirmed'); strength = reading ? 'context' : 'weak'; }
      else if (answer && reading) {
        const d = reading[answer];
        if (d) { signals.push(d); strength = 'context'; }
      } else if (answer === 'no') { signals.push('rejection'); strength = 'weak'; }
      // "ok" / "sure" after a plain statement is an acknowledgment, not interest.
      else if (answer === 'yes' && prompt !== 'statement') { signals.push('open_to_selling'); strength = 'weak'; }
    }
    // "Not interested right now" is a softened no -> future follow-up.
    if (signals.includes('rejection') && signals.includes('future_follow_up')) signals.splice(signals.indexOf('rejection'), 1);
    const primary = PRIORITY.find(k => signals.includes(k)) || null;
    return { kind: 'text', signals, primary, strength, quoted, text, prompt };
  }

  const TAG_SIGNALS = [
    [/^(opt ?out|opted ?out|unsubscribed?)$/, 'opt_out'],
    [/wrong ?(number|person)|not ?(the )?owner|dead ?number/, 'wrong_number'],
    [/not ?interested|do ?not ?contact|not ?for ?sale/, 'rejection'],
    [/offer ?requested|wants? ?offer/, 'offer_requested'],
    [/call ?back|callback/, 'callback_requested'],
    [/follow ?up ?later|future ?follow|nurture|not ?ready/, 'future_follow_up'],
    [/price ?(too ?high|mismatch)|too ?high/, 'price_mismatch'],
    [/motivated|interested|hot ?lead|warm ?lead|open ?to ?sell/, 'open_to_selling'],
    [/owner(ship)? ?(verified|confirmed)|verified ?owner/, 'ownership_confirmed'],
  ];
  function tagSignal(tags) {
    for (const tag of tags || []) {
      const k = String(tag).toLowerCase().replace(/[_-]+/g, ' ').trim();
      for (const [re, d] of TAG_SIGNALS) if (re.test(k)) return d;
    }
    return null;
  }
  const ownershipTag = tags => (tags || []).some(t => /owner(ship)?[\s_-]*(verified|confirmed)|verified[\s_-]*owner/i.test(String(t)));

  // Classify the whole conversation, oldest to newest. The latest explicit
  // intent wins; opt-out is terminal; "wrong number" stands unless a later
  // message confirms ownership. Confidence = how sure the classifier is, and is
  // reported separately from readiness (how close the seller is to a deal).
  // Gives each inbound message the body of the team's latest text sent before
  // it (within PROMPT_WINDOW), as `prompt`. Both lists need { at, body }.
  const PROMPT_WINDOW_MS = 14 * DAY;
  function attachPrompts(inbound, outbound) {
    const outs = (outbound || []).filter(o => o.at != null && String(o.body || '').trim()).sort((a, b) => a.at - b.at);
    let i = -1;
    for (const m of (inbound || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
      while (i + 1 < outs.length && outs[i + 1].at <= (m.at || 0)) i++;
      m.prompt = i >= 0 && (m.at || 0) - outs[i].at <= PROMPT_WINDOW_MS ? outs[i].body : '';
    }
    return inbound;
  }

  function classifyConversation(messages, tags = []) {
    const sorted = (messages || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    let reactionsIgnored = 0, quotedIgnored = 0, meaningful = 0;
    const seen = new Set();
    let latest = null, optOut = null, ownershipStated = false, lastMeaningfulAt = null;
    for (const m of sorted) {
      const c = classifyMessage(m.body, m);
      if (c.quoted) quotedIgnored++;
      if (c.kind === 'reaction') { reactionsIgnored++; continue; }
      if (c.kind !== 'text') continue;
      meaningful++; lastMeaningfulAt = m.at || lastMeaningfulAt;
      c.signals.forEach(s => seen.add(s));
      if (c.signals.includes('ownership_confirmed')) ownershipStated = true;
      if (c.signals.includes('opt_out')) optOut = { at: m.at, strength: c.strength };
      if (!c.primary) continue;
      if (latest && latest.primary === 'wrong_number' && c.primary !== 'ownership_confirmed' && !c.signals.includes('ownership_confirmed') && c.strength === 'weak') continue;
      // A bare "yes" / "ok" with no question to answer does not undo a clearer
      // earlier reply, and confirming ownership does not erase stated intent.
      if (latest && c.strength === 'weak' && latest.strength !== 'weak') continue;
      if (latest && c.primary === 'ownership_confirmed' && latest.primary !== 'wrong_number' && latest.primary !== 'ownership_confirmed') continue;
      latest = { primary: c.primary, strength: c.strength, at: m.at };
    }
    const tagged = tagSignal(tags);
    let disposition, source, confidence;
    if (optOut || (tagged === 'opt_out' && !latest)) {
      disposition = 'opt_out'; source = optOut ? 'text' : 'tag'; confidence = optOut ? 'high' : 'medium';
    } else if (latest) {
      disposition = latest.primary; source = 'text';
      const conflicting = [...seen].some(s => s !== disposition && (DEAD.has(s) !== DEAD.has(disposition)) && s !== 'ownership_confirmed');
      confidence = latest.strength === 'weak' ? (tagged === disposition ? 'medium' : 'low') : (conflicting ? 'medium' : 'high');
      if (tagged && tagged !== disposition && DEAD.has(tagged) !== DEAD.has(disposition)) confidence = 'low';
    } else if (tagged) {
      disposition = tagged; source = 'tag'; confidence = 'medium';
    } else {
      disposition = meaningful ? 'unclear' : 'none'; source = meaningful ? 'text' : ''; confidence = meaningful ? 'low' : '';
    }
    if (ownershipTag(tags)) ownershipStated = true;
    // Positive response: the conversation currently reads as interest and the
    // classifier is reasonably sure (a lone "yes" with no question is not enough).
    const positive = INTEREST.has(disposition) && source === 'text' && confidence !== 'low';
    return { disposition, label: LABELS[disposition], source, confidence, positive, signals: [...seen], ownershipStated,
      lastSignalAt: latest?.at || optOut?.at || null, lastReplyAt: lastMeaningfulAt, reactionsIgnored, quotedIgnored, replies: meaningful };
  }

  function readiness(conv, ctx = {}) {
    const now = ctx.now || Date.now();
    const d = conv?.disposition || 'none';
    const group = ctx.stageGroup || '';
    const activeOpp = Boolean(ctx.activeOpp);
    if (activeOpp && ['eval', 'offer', 'verbal'].includes(group)) return 'hot';
    if (DEAD.has(d) && !activeOpp) return 'dead';
    let r = 'unknown';
    if (['offer_requested', 'callback_requested'].includes(d)) r = 'hot';
    else if (d === 'open_to_selling') r = ctx.qualified ? 'hot' : 'warm';
    else if (['price_mismatch', 'ownership_confirmed'].includes(d)) r = 'warm';
    else if (d === 'future_follow_up') r = 'nurture';
    if (r === 'unknown' && (ctx.qualified || activeOpp)) r = 'warm';
    const age = conv?.lastSignalAt ? now - conv.lastSignalAt : Infinity;
    if (!activeOpp && age > CONFIG.readinessDecayDays * DAY && Number.isFinite(age)) r = r === 'hot' ? 'warm' : r === 'warm' ? 'nurture' : r;
    return r;
  }

  /* ---------------- Qualification ---------------- */
  const QUAL_KEYS = ['ownership', 'condition', 'timeline', 'motivation', 'price'];
  const QUAL_LABELS = { ownership: 'Verified ownership', condition: 'Condition', timeline: 'Timeline', motivation: 'Motivation', price: 'Price expectation' };
  const NEGATIVE_VALUE = /^(no|false|n|0|unverified|not verified|unknown|tbd|n\/a|na|none|-)$/i;
  function qualificationOf(contact) {
    const q = contact?.q || {};
    const have = {};
    for (const k of QUAL_KEYS) {
      const v = String(q[k] ?? '').trim();
      if (v && !NEGATIVE_VALUE.test(v)) have[k] = v;
    }
    if (!have.ownership && ownershipTag(parseTags(contact?.t))) have.ownership = 'tag';
    const missing = QUAL_KEYS.filter(k => !have[k]);
    return { have, missing, qualified: missing.length === 0, ownershipVerified: Boolean(have.ownership) };
  }

  /* ---------------- Batches ---------------- */
  const STATUS_TAG = /^(raw-opps$|dialer|queue|dnc|opt|stop|do ?not|not ?interested|wrong|positive|negative|neutral|hot|warm|cold|dead|bad|qualified|motivated|appointment|appt|call ?back|callback|follow|offer|contract|closed|won|lost|ghost|voicemail|vm\b|no ?answer|answered|left ?message|replied|responded|interested|owner|verified|spanish|english|nurture|sms|text|priority|undeliverable|undelivered|litigator|deceased)/i;
  function parseTags(t) {
    if (Array.isArray(t)) return t.map(String).map(x => x.trim()).filter(Boolean);
    return String(t || '').split(',').map(x => x.trim()).filter(Boolean);
  }

  /* ---------------- Exclusions ---------------- */
  // Contacts carrying these tags are removed from the Leads page entirely
  // (queue, funnel, dispositions, rankings, activity). Matching ignores case,
  // spaces and punctuation: "Wrong Number", "wrong_number", "DNC/Undelivered".
  // "Not Qualified" is NOT removed: those sellers were worked and reached, so
  // they stay in worked / contacted and branch off as "Not qualified" instead
  // of counting as qualified sellers (see notQualifiedTag).
  const EXCLUDED_TAGS = { wrongnumber: 'Wrong number', dncundelivered: 'DNC/Undelivered' };
  const notQualifiedTag = tags => parseTags(tags).some(t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '').includes('notqualified'));
  function excludedTagReason(tags) {
    for (const t of parseTags(tags)) {
      const key = String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (EXCLUDED_TAGS[key]) return EXCLUDED_TAGS[key];
      // Variants such as "Wrong Number - SMS", "wrong num" or "DNC - Undeliverable".
      if (/wrongn(umber|um\b|o\b)|wrongnum/.test(key)) return EXCLUDED_TAGS.wrongnumber;
      if (key.includes('dnc') && key.includes('undeliver')) return EXCLUDED_TAGS.dncundelivered;
    }
    return '';
  }
  // Opportunity status from GHL: lost/abandoned opportunities are dropped.
  const CLOSED_LOST = new Set(['lost', 'abandoned', 'abandon']);
  const isLostOpp = o => CLOSED_LOST.has(String(o?.status || '').toLowerCase());

  /* ---------------- Lead model ---------------- */
  const AUTOMATED_SOURCE = /workflow|bulk|campaign|drip|automation|trigger|ai_bot|autoresponder/i;
  function toMs(v) { if (v == null || v === '') return null; if (v instanceof Date) return v.valueOf(); const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; }


  function qualificationDay(value, keyOf) {
    const usDate = typeof value === 'string' && /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    if (usDate) value = `${usDate[3]}-${usDate[1]}-${usDate[2]}`;
    const at = toMs(value);
    if (at == null) return null;
    // A date-only field describes a reporting day without a timezone.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(at).toISOString().slice(0, 10) === value ? value : null;
    }
    return keyOf(at);
  }

  // Builds one record per GHL contact that has any activity, opportunity,
  // appointment or recorded qualification. Rows without a contact ID cannot
  // be joined and are counted in `stats` for the reliability panel.
  function buildLeads(input) {
    const { contacts = [], calls = [], sms = [], opps = [], appointments = [], userNames = {}, isBatchTag = () => true, canonicalRep = x => x, now = Date.now(), dateKeyOf = null } = input;
    const repName = id => (id && userNames[id]) ? canonicalRep(userNames[id]) : '';
    const contactById = new Map(contacts.filter(c => c && c.id).map(c => [c.id, c]));
    const stats = { excluded: {}, excludedIds: new Set(), oppsLost: 0, lostOnlyContacts: 0, callsNoContact: 0, smsNoContact: 0, outboundTextsNoRep: 0, outboundTexts: 0, oppsNoContact: 0, oppsNoRep: 0, apptsNoContact: 0, calls: calls.length, sms: sms.length, opps: opps.length, appointments: appointments.length, reactionsIgnored: 0, quotedIgnored: 0, notQualified: 0 };
    const leads = new Map();
    const excludedReason = new Map();
    for (const c of contactById.values()) {
      const reason = excludedTagReason(c.t);
      if (reason) excludedReason.set(c.id, reason);
    }
    const skip = id => {
      const reason = excludedReason.get(id);
      if (!reason) return false;
      if (!stats.excludedIds.has(id)) { stats.excludedIds.add(id); stats.excluded[reason] = (stats.excluded[reason] || 0) + 1; }
      return true;
    };
    const lead = id => {
      if (!leads.has(id)) {
        const c = contactById.get(id) || {};
        leads.set(id, { id, name: c.n || '(unknown contact)', phone: c.p || '', contact: c, known: contactById.has(id), touches: [], inbound: [], opps: [], allOpps: [], appointments: [] });
      }
      return leads.get(id);
    };
    const keyOf = ms => (dateKeyOf ? dateKeyOf(ms) : new Date(ms).toISOString().slice(0, 10));
    for (const c of contactById.values()) {
      if (/^hot\b/i.test(String(c.q?.temperature || '').trim()) && !skip(c.id)) lead(c.id);
    }

    for (const r of calls) {
      if (!r.contactId) { stats.callsNoContact++; continue; }
      if (skip(r.contactId)) continue;
      const at = toMs(r.dateObj || r.created || r.co);
      if (at == null) continue;
      const duration = Number(r.duration ?? r.du ?? 0) || 0;
      lead(r.contactId).touches.push({ at, dateKey: r.dateKey || keyOf(at), kind: 'call', dir: 'out', rep: r.rep || '', duration, meaningful: duration > 60 });
    }
    for (const m of sms) {
      if (!m.contactId) { stats.smsNoContact++; continue; }
      if (skip(m.contactId)) continue;
      const at = toMs(m.dateObj || m.createdAt || m.created);
      if (at == null) continue;
      const inbound = m.isInbound ?? String(m.direction).toLowerCase() === 'inbound';
      const L = lead(m.contactId);
      if (inbound) {
        const c = classifyMessage(m.body, m);
        const entry = { at, body: m.body || '', status: m.status, error: m.error };
        L.inbound.push(entry);
        L.touches.push({ at, dateKey: m.dateKey || keyOf(at), kind: 'text', dir: 'in', rep: '', body: m.body || '', meaningful: c.kind === 'text', disposition: c.primary, inbound: entry });
      } else {
        stats.outboundTexts++;
        const rep = m.rep || repName(m.userId);
        if (!rep) stats.outboundTextsNoRep++;
        const automated = AUTOMATED_SOURCE.test(String(m.source || ''));
        L.touches.push({ at, dateKey: m.dateKey || keyOf(at), kind: 'text', dir: 'out', rep, body: m.body || '', automated, meaningful: !automated });
      }
    }
    const lostOppContacts = new Set();
    // Every ACQ opportunity in an offer or contract stage is listed, counted
    // or not, so the funnel can show exactly which deals it includes and why
    // any are left out.
    const deals = [];
    for (const o of opps) {
      const fs = funnelStage(o);
      if (fs) {
        const at = toMs(o.stageAt) ?? toMs(o.dateObj || o.created);
        deals.push({ id: o.id, contactId: o.contactId || '', name: o.leadName || o.oppName || '', stage: o.stage, status: o.status, rep: o.rep || '', funnel: fs, at, dateKey: at == null ? null : keyOf(at), dated: toMs(o.stageAt) != null ? 'stage change' : 'created', excluded: excludedReason.get(o.contactId) || '' });
      }
      if (!o.contactId) { stats.oppsNoContact++; continue; }
      if (skip(o.contactId)) continue;
      // Funnel stages ignore opportunity status, so every opportunity is kept
      // in allOpps; the action queue only works from non-lost ones (opps).
      lead(o.contactId).allOpps.push(o);
      if (isLostOpp(o)) { stats.oppsLost++; lostOppContacts.add(o.contactId); continue; }
      if (!o.rep || o.rep === 'Unassigned') stats.oppsNoRep++;
      lead(o.contactId).opps.push(o);
    }
    for (const a of appointments) {
      if (!a.contactId) { stats.apptsNoContact++; continue; }
      if (skip(a.contactId)) continue;
      lead(a.contactId).appointments.push(a);
    }
    for (const c of contacts) if (c.id && c.q && Object.keys(c.q).length && !skip(c.id)) lead(c.id);
    // A contact whose opportunities were all lost is closed out of the action
    // queue (funnel counts still include it, since they ignore status).
    for (const id of lostOppContacts) {
      const L = leads.get(id);
      if (L && !L.opps.length) { L.lostOnly = true; stats.lostOnlyContacts++; }
    }

    // Batch start = earliest date any contact carrying the tag was added.
    const batchStart = new Map();
    for (const c of contacts) {
      const tags = parseTags(c.ot || c.t);
      const da = toMs(c.da) ?? Infinity;
      for (const t of tags) if (isBatchTag(t) && !STATUS_TAG.test(t)) batchStart.set(t, Math.min(batchStart.get(t) ?? Infinity, da));
    }

    for (const L of leads.values()) {
      const c = L.contact;
      L.touches.sort((a, b) => a.at - b.at);
      attachPrompts(L.inbound, L.touches.filter(t => t.kind === 'text' && t.dir === 'out'));
      for (const t of L.touches) if (t.kind === 'text' && t.dir === 'in' && t.inbound?.prompt) t.disposition = classifyMessage(t.body, t.inbound).primary;
      L.tags = parseTags(c.t);
      const original = parseTags(c.ot || c.t).filter(t => isBatchTag(t) && !STATUS_TAG.test(t));
      original.sort((a, b) => (batchStart.get(a) ?? Infinity) - (batchStart.get(b) ?? Infinity) || a.localeCompare(b));
      L.originalBatch = original[0] || '';
      L.batchOverlap = original.length > 1;
      L.batchCandidates = original;
      L.ownerId = c.o || '';
      // Owner = contact owner in GHL; falls back to the opportunity's assigned rep.
      const primary = pickPrimaryOpp(L.opps);
      L.opp = primary;
      L.owner = repName(c.o) || (primary && primary.rep !== 'Unassigned' ? primary.rep : '') || '';
      L.stageGroup = stageGroup(primary);
      L.activeOpp = Boolean(primary && primary.status === 'open' && FOLLOW_UP_PIPELINES.includes(primary.pipeline));
      L.followUpStart = Math.min(...L.opps.filter(o => FOLLOW_UP_PIPELINES.includes(o.pipeline)).map(o => toMs(o.dateObj || o.created) ?? Infinity), Infinity);
      // Funnel outcomes come from the ACQ stage only; opportunity status is ignored.
      const offerOpps = L.allOpps.filter(o => funnelStage(o) === 'offer');
      const contractOpps = L.allOpps.filter(o => funnelStage(o) === 'contract');
      L.offerPresented = offerOpps.length > 0;
      L.contractSigned = contractOpps.length > 0;
      const latest = list => list.map(o => toMs(o.stageAt) ?? toMs(o.dateObj)).filter(v => v != null).sort((a, b) => b - a)[0] || null;
      L.offerAt = latest(offerOpps);
      L.contractAt = latest(contractOpps);
      L.offerDay = L.offerAt == null ? null : keyOf(L.offerAt);
      L.contractDay = L.contractAt == null ? null : keyOf(L.contractAt);
      L.temperature = String(c.q?.temperature || '').trim();
      L.hot = /^hot\b/i.test(L.temperature);
      const held = L.appointments.filter(a => a.status === 'showed').map(a => toMs(a.start)).filter(v => v != null);
      if (!held.length && L.tags.some(t => /(appointment|appt)[\s_-]*(held|showed|completed|done)/i.test(t))) held.push(null);
      L.appointmentsHeld = held;
      L.appointmentHeld = held.length > 0;
      L.qual = qualificationOf(c);
      // Qualified seller = an ACQ/Retail opportunity (any status) that is not
      // in the Not Ready stage, or Temperature = Hot. Nothing else counts
      // (raw-opps, First Qualified At and other fields are not used).
      L.qualOpps = L.allOpps.filter(o => FOLLOW_UP_PIPELINES.includes(o.pipeline) && stageKey(o.stage) !== NOT_READY_STAGE);
      L.notReadyOnly = !L.qualOpps.length && L.allOpps.some(o => FOLLOW_UP_PIPELINES.includes(o.pipeline) && stageKey(o.stage) === NOT_READY_STAGE);
      const qualificationEvents = L.qualOpps.map(opp => ({
        day: opp.dateKey || qualificationDay(opp.created || opp.dateObj, keyOf),
        rep: opp.rep, source: `${opp.pipeline} opportunity created`,
      }));
      const first = qualificationEvents.filter(event => event.day)
        .sort((a, b) => a.day.localeCompare(b.day) || Number(Boolean(b.rep)) - Number(Boolean(a.rep)))[0];
      L.qualifiedDay = first?.day || null;
      L.qualificationSource = first?.source || '';
      L.qualifiedBy = first?.rep ? repName(first.rep) || canonicalRep(first.rep) : '';
      L.qualifiedSeller = L.hot || L.qualOpps.length > 0;
      L.qualifiedWeight = L.qualifiedSeller ? 1 : 0;
      // Ghosted branch: still a qualified seller, but every counted
      // opportunity sits in the Ghosted stage.
      L.ghosted = L.qualOpps.length > 0 && L.qualOpps.every(o => stageKey(o.stage) === GHOSTED_STAGE);
      // Not Qualified branch: kept as worked / contacted, never qualified.
      L.notQualified = notQualifiedTag(c.t);
      if (L.notQualified) {
        stats.notQualified++;
        L.qualifiedWeight = 0; L.qualifiedSeller = false; L.ghosted = false;
        L.qualifiedDay = null; L.qualificationSource = ''; L.qualifiedBy = '';
      }
      L.contactUpdatedDay = L.hot ? qualificationDay(c.updatedAt, keyOf) : null;
      L.conv = classifyConversation(L.inbound, L.tags);
      stats.reactionsIgnored += L.conv.reactionsIgnored; stats.quotedIgnored += L.conv.quotedIgnored;
      if (L.conv.ownershipStated && !L.qual.ownershipVerified) L.ownershipStatedOnly = true;
      L.readiness = readiness(L.conv, { now, qualified: L.hot, activeOpp: L.activeOpp, stageGroup: L.stageGroup });
      const meaningful = L.touches.filter(t => t.meaningful);
      L.lastMeaningful = meaningful[meaningful.length - 1] || null;
      L.ballInCourt = L.lastMeaningful ? (L.lastMeaningful.dir === 'in' ? 'team' : 'seller') : null;
      L.longCall = L.touches.some(t => t.kind === 'call' && t.duration > 60);
      // Estimated qualification date for Hot sellers with no date:
      // the first contact (call over the contact threshold, or a seller reply
      // to a team text), else the first outreach. Fixed per seller, so the
      // seller is counted in one period only.
      L.estimatedQualification = estimateQualification(L);
      // Contact = a call over CONFIG.contactCallSeconds, or a two-way text conversation (team
      // texted and the seller replied), unless the seller said wrong number.
      // Contacts tagged Wrong Number are already removed above.
      const textedOut = L.touches.some(t => t.kind === 'text' && t.dir === 'out');
      L.contacted = L.conv.disposition !== 'wrong_number' && (L.touches.some(t => t.kind === 'call' && t.duration > CONFIG.contactCallSeconds) || (textedOut && L.conv.replies > 0));
      L.reached = (L.conv.replies > 0 && !['wrong_number', 'opt_out'].includes(L.conv.disposition)) || L.qual.ownershipVerified || L.conv.ownershipStated || L.opps.some(o => FOLLOW_UP_PIPELINES.includes(o.pipeline)) || L.appointmentHeld;
      L.outcomeRecorded = L.conv.disposition !== 'none' || L.opps.length > 0 || Object.keys(L.qual.have).length > 0;
      // Cold prospecting = outbound work before the contact had an ACQ/Retail
      // opportunity; closer follow-up = outbound work on or after it.
      for (const t of L.touches) t.phase = t.at >= L.followUpStart ? 'closer' : 'cold';
      // Prospecting credit: the rep with the most cold touches (latest wins ties).
      const counts = new Map();
      for (const t of L.touches) if (t.dir === 'out' && t.phase === 'cold' && t.rep) counts.set(t.rep, { n: (counts.get(t.rep)?.n || 0) + 1, at: t.at });
      L.prospector = [...counts].sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)[0]?.[0] || '';
      L.closer = primary && primary.rep && primary.rep !== 'Unassigned' ? primary.rep : L.owner;
    }
    leads.deals = deals;
    return { leads, stats };
  }

  function pickPrimaryOpp(opps) {
    if (!opps.length) return null;
    const rank = o => (o.pipeline === ACQ_PIPELINE ? 0 : FOLLOW_UP_PIPELINES.includes(o.pipeline) ? 1 : 2) * 10 + (o.status === 'open' ? 0 : o.status === 'won' ? 1 : 2);
    return opps.slice().sort((a, b) => rank(a) - rank(b) || (toMs(b.stageAt) ?? toMs(b.dateObj) ?? 0) - (toMs(a.stageAt) ?? toMs(a.dateObj) ?? 0))[0];
  }

  /* ---------------- Action queue ---------------- */
  const QUEUES = {
    reply: 'Unanswered seller reply', followup: 'Overdue qualified follow-up', eval: 'Evaluation awaiting offer', offer: 'Offer awaiting decision',
  };
  function describeTouch(t) {
    if (!t) return 'No meaningful interaction yet';
    if (t.kind === 'call') return `${t.rep || 'Team'} call ${Math.floor(t.duration / 60)}m ${String(Math.round(t.duration % 60)).padStart(2, '0')}s`;
    return t.dir === 'in' ? 'Seller texted' : `${t.rep || 'Team'} texted`;
  }
  function replyAction(d) {
    return d === 'callback_requested' ? 'Call seller back' : d === 'offer_requested' ? 'Call with offer numbers' : d === 'price_mismatch' ? 'Address price gap' : d === 'future_follow_up' ? 'Acknowledge and set follow-up date' : d === 'open_to_selling' ? 'Qualify: condition, timeline, motivation, price' : 'Reply to seller';
  }

  // Saved queue edits (shared, from dashboard-data?settings=queue-overrides).
  // An edit holds until something new happens on that seller: a meaningful
  // call/text or an opportunity stage change after the edit. Then the queue
  // recalculates on its own, so a deleted action can come back when the seller
  // replies again, and a moved due date lapses once someone works the lead.
  function newActivitySince(L, iso) {
    const since = toMs(iso);
    if (since == null) return true;
    if (L.touches.some(t => t.meaningful && t.at > since)) return true;
    const stageAt = L.opp ? toMs(L.opp.stageAt) : null;
    return stageAt != null && stageAt > since;
  }
  function actionQueue(leads, now = Date.now(), opts = {}) {
    const overrides = opts.overrides || {};
    const items = [];
    for (const L of leads.values ? leads.values() : leads) {
      if (!L.known || L.notQualified) continue;
      const d = L.conv.disposition;
      const dead = DEAD.has(d) && !L.activeOpp;
      if (d === 'opt_out' && !L.activeOpp) continue;
      if (L.lostOnly) continue;
      const last = L.lastMeaningful;
      const lastIn = [...L.touches].reverse().find(t => t.dir === 'in' && t.meaningful);
      const base = { lead: L, id: L.id, seller: L.name, phone: L.phone, owner: L.owner || 'Unassigned', stage: L.opp ? `${L.opp.pipeline.replace(' Pipeline', '')} · ${L.opp.stage || '-'}${L.opp.status && L.opp.status !== 'open' ? ` (${L.opp.status})` : ''}` : '-', oppStatus: L.opp?.status || '', disposition: d, readiness: L.readiness, lastTouch: last, lastLabel: describeTouch(last), lastAt: last?.at || null, waitingOn: L.ballInCourt };
      let item = null;
      // 1. Seller replied and the team has not responded (any meaningful team touch after clears it).
      if (L.ballInCourt === 'team' && lastIn && now - lastIn.at <= CONFIG.replyLookbackDays * DAY && !dead) {
        const sla = (L.readiness === 'hot' ? CONFIG.replySlaHours.hot : CONFIG.replySlaHours.default) * HOUR;
        const stageAction = L.activeOpp && { eval: 'Reply, then present offer', offer: 'Reply on the offer', verbal: 'Reply and send contract', contract: 'Reply - contract in progress' }[L.stageGroup];
        item = { queue: 'reply', nextAction: d === 'callback_requested' ? 'Call seller back' : (stageAction || replyAction(d)), due: lastIn.at + sla };
      }
      // Seller asked for a call; a text reply alone does not satisfy it.
      if (!item && d === 'callback_requested' && !dead && L.conv.lastSignalAt) {
        const called = L.touches.some(t => t.kind === 'call' && t.at > L.conv.lastSignalAt);
        if (!called && now - L.conv.lastSignalAt <= CONFIG.replyLookbackDays * DAY) item = { queue: 'reply', nextAction: 'Call seller back', due: L.conv.lastSignalAt + CONFIG.callbackSlaHours * HOUR, waitingOn: 'team' };
      }
      const stageAt = L.opp ? (toMs(L.opp.stageAt) ?? toMs(L.opp.dateObj)) : null;
      if (!item && L.activeOpp && L.stageGroup === 'verbal') item = { queue: 'offer', nextAction: 'Send contract', due: (stageAt ?? now) + CONFIG.verbalToContractDays * DAY, waitingOn: 'team' };
      if (!item && L.activeOpp && L.stageGroup === 'offer') item = { queue: 'offer', nextAction: L.ballInCourt === 'team' ? 'Respond to seller on offer' : 'Get a decision on the offer', due: Math.max(stageAt ?? 0, last?.at ?? 0) + CONFIG.offerDecisionDays * DAY };
      if (!item && L.activeOpp && L.stageGroup === 'eval') item = { queue: 'eval', nextAction: stageKey(L.opp.stage) === 'runnumbers' ? 'Finish numbers and present offer' : 'Present offer', due: (stageAt ?? now) + CONFIG.evalToOfferDays * DAY, waitingOn: 'team' };
      if (!item && !dead && (L.hot || (L.activeOpp && L.stageGroup !== 'contract'))) {
        const days = CONFIG.followUpDays[L.readiness] ?? CONFIG.followUpDays.unknown;
        const due = (last?.at ?? stageAt ?? now) + days * DAY;
        if (due <= now + 12 * HOUR) item = { queue: 'followup', nextAction: L.ballInCourt === 'seller' ? 'Follow up - seller has not replied' : 'Follow up with seller', due };
      }
      if (!item) continue;
      const edit = overrides[L.id];
      const result = { ...base, ...item, waitingOn: item.waitingOn || base.waitingOn || 'team', autoDue: item.due, edited: null };
      if (edit?.dismissedAt && !newActivitySince(L, edit.dismissedAt)) {
        if (!opts.includeDismissed) continue;
        result.dismissed = true; result.dismissedAt = edit.dismissedAt;
      } else if (edit?.due && !newActivitySince(L, edit.setAt)) {
        result.due = toMs(edit.due) ?? item.due; result.edited = 'due';
      }
      result.overdue = !result.dismissed && result.due < now;
      items.push(result);
    }
    return items.sort((a, b) => a.due - b.due);
  }

  // Contact made in the period: a call over CONFIG.contactCallSeconds in the period, or a seller
  // text reply in the period to a conversation the team texted (two-way).
  // Never a wrong number. Contacts tagged Wrong Number are removed earlier.
  // With a rep, only that rep's contacts count: their own call over the
  // threshold, or a seller reply whose latest team text before it was theirs.
  function contactedIn(L, inPeriod, rep = '') {
    if (L.conv.disposition === 'wrong_number') return false;
    let textedOut = false, lastTextRep = '';
    for (const t of L.touches) {
      if (t.kind === 'text' && t.dir === 'out') { textedOut = true; lastTextRep = t.rep || ''; }
      if (!inPeriod(t.dateKey)) continue;
      if (t.kind === 'call' && t.duration > CONFIG.contactCallSeconds && (!rep || t.rep === rep)) return true;
      if (t.kind === 'text' && t.dir === 'in' && t.meaningful && textedOut && t.disposition !== 'wrong_number' && (!rep || lastTextRep === rep)) return true;
    }
    return false;
  }

  // First contact (else first outreach) with the rep credited for it.
  function estimateQualification(L) {
    let lastTextRep = '', textedOut = false, firstOut = null;
    for (const t of L.touches) {
      if (t.dir === 'out' && !firstOut) firstOut = t;
      if (t.kind === 'text' && t.dir === 'out') { textedOut = true; lastTextRep = t.rep || ''; }
      if (t.kind === 'call' && t.duration > CONFIG.contactCallSeconds) return { day: t.dateKey, rep: t.rep || '', evidence: 'first contact date' };
      if (t.kind === 'text' && t.dir === 'in' && t.meaningful && textedOut && t.disposition !== 'wrong_number') return { day: t.dateKey, rep: lastTextRep, evidence: 'first contact date' };
    }
    if (firstOut) return { day: firstOut.dateKey, rep: firstOut.rep || '', evidence: 'first outreach date' };
    return null;
  }

  /* ---------------- Funnel ---------------- */
  // A dated qualification wins across all sources. When only a current Hot
  // field exists, report period activity as an estimate.
  // One seller = one phone number (last 10 digits), else one GHL contact, so
  // duplicate contacts for the same seller count once in worked / contacted.
  function sellerKey(L) {
    const digits = String(L.phone || '').replace(/\D/g, '');
    return digits.length >= 10 ? `phone:${digits.slice(-10)}` : `contact:${L.id}`;
  }

  function funnel(leads, inPeriod, opts = {}) {
    const sellers = new Map(); // sellerKey -> { base, contacted }
    const matchRep = opts.rep ? (t => t.rep === opts.rep) : (() => true);
    const out = { worked: 0, contactBase: 0, contacted: 0, qualified: 0, ghosted: 0, notReady: 0, estimatedQualified: 0, offers: 0, contracts: 0,
      members: { worked: [], contacted: [], qualified: [], ghosted: [], notQualified: [], notReady: [] },
      diag: { dials: 0, texts: 0, callsOver60: 0, callsOver90: 0, longCallNoOutcome: 0, replies: 0, ownershipStatedNotRecorded: 0, hotNoOpp: 0, wrongNumberByText: 0, overlapBatches: 0 } };
    for (const L of leads.values()) {
      if (opts.include && !opts.include(L)) continue;
      const touches = L.touches.filter(t => inPeriod(t.dateKey));
      const work = touches.filter(t => t.dir === 'out' && matchRep(t));
      if (L.qualifiedDay) {
        if (inPeriod(L.qualifiedDay) && (!opts.rep || L.qualifiedBy === opts.rep)) out.members.qualified.push(L);
      } else if (L.hot && !L.notQualified) {
        // One estimated date per seller (see estimateQualification), so the
        // seller is never counted again in a later period.
        const est = L.estimatedQualification || (L.contactUpdatedDay ? { day: L.contactUpdatedDay, rep: L.owner, evidence: 'contact update date' } : null);
        const day = est && inPeriod(est.day) && (!opts.rep || est.rep === opts.rep) ? est.day : null;
        if (day) {
          out.members.qualified.push({ id: L.id, name: L.name, qualifiedDay: day, qualificationSource: `Hot temperature · estimated from ${est.evidence}`, ghosted: false });
          out.estimatedQualified++;
        }
      }
      if (!work.length) continue;
      // Worked, contact base and contacted are unique sellers in the period.
      const key = sellerKey(L);
      let seller = sellers.get(key);
      if (!seller) { seller = { base: false, contacted: false, notQualified: false, notReady: false }; sellers.set(key, seller); out.members.worked.push(L); }
      if (L.notQualified && !seller.notQualified) { seller.notQualified = true; out.members.notQualified.push(L); }
      // Sellers whose only opportunity is in Not Ready (and not Hot) are not qualified.
      if (L.notReadyOnly && !L.hot && !L.notQualified && !seller.notReady) { seller.notReady = true; out.members.notReady.push(L); }
      // Contact-rate base leaves out sellers who said "wrong number" by text.
      // (Contacts tagged Wrong Number or DNC/Undelivered are already removed.)
      if (L.conv.disposition === 'wrong_number') out.diag.wrongNumberByText++; else seller.base = true;
      out.diag.dials += work.filter(t => t.kind === 'call').length;
      out.diag.texts += work.filter(t => t.kind === 'text').length;
      out.diag.callsOver60 += work.filter(t => t.kind === 'call' && t.duration > 60).length;
      out.diag.replies += touches.filter(t => t.dir === 'in' && t.meaningful).length;
      if (work.some(t => t.kind === 'call' && t.duration > 60) && !L.outcomeRecorded) out.diag.longCallNoOutcome++;
      out.diag.callsOver90 += work.filter(t => t.kind === 'call' && t.duration > CONFIG.contactCallSeconds).length;
      if (!seller.contacted && contactedIn(L, inPeriod, opts.rep)) { seller.contacted = true; out.members.contacted.push(L); }
      if (L.hot && !L.notQualified && !L.allOpps.some(o => FOLLOW_UP_PIPELINES.includes(o.pipeline))) out.diag.hotNoOpp++;
      if (L.ownershipStatedOnly) out.diag.ownershipStatedNotRecorded++;
    }
    out.worked = sellers.size;
    out.contactBase = [...sellers.values()].filter(x => x.base).length;
    out.contacted = [...sellers.values()].filter(x => x.contacted).length;
    // Not qualified branch: unique sellers worked in the period tagged Not Qualified.
    out.notQualified = [...sellers.values()].filter(x => x.notQualified).length;
    out.notQualifiedContacted = [...sellers.values()].filter(x => x.notQualified && x.contacted).length;
    out.notReady = out.members.notReady.length;
    // Qualified sellers: one per seller. Ghosted branch = qualified sellers
    // whose opportunities are all in Ghosted (still counted as qualified).
    out.qualified = out.members.qualified.length;
    out.members.ghosted = out.members.qualified.filter(m => m.ghosted);
    out.ghosted = out.members.ghosted.length;
    // Offers presented / contracts signed: ACQ opportunities currently in those
    // stages whose stage date (last stage change, else created) falls in the
    // period - whether or not the seller was dialed in the period.
    const counted = { offer: new Set(), contract: new Set() };
    out.deals = [];
    for (const d of opts.deals || leads.deals || []) {
      const L = d.contactId ? leads.get(d.contactId) : null;
      let reason = '';
      if (d.excluded) reason = `contact tagged ${d.excluded}`;
      else if (!d.dateKey || !inPeriod(d.dateKey)) reason = `outside the selected period (${d.dated} ${d.dateKey || 'unknown'})`;
      else if (opts.rep && d.rep !== opts.rep) reason = `assigned to ${d.rep || 'nobody'}, not the selected rep`;
      else if (opts.include && L && !opts.include(L)) reason = 'hidden by the tag or name filter';
      const key = d.contactId || d.id;
      if (!reason && counted[d.funnel].has(key)) reason = 'same seller already counted';
      if (!reason) counted[d.funnel].add(key);
      out.deals.push({ ...d, name: d.name || L?.name || '(no contact)', counted: !reason, reason });
    }
    out.offers = counted.offer.size;
    out.contracts = counted.contract.size;
    return out;
  }

  /* ---------------- Rankings ---------------- */
  function rankCold(leads, inPeriod) {
    const reps = new Map();
    const row = rep => { if (!reps.has(rep)) reps.set(rep, { rep, worked: 0, dials: 0, texts: 0, contacted: 0, qualified: 0, offers: 0, contracts: 0 }); return reps.get(rep); };
    for (const L of leads.values()) {
      const byRep = new Map();
      for (const t of L.touches) if (t.dir === 'out' && t.phase === 'cold' && t.rep && inPeriod(t.dateKey)) {
        const r = byRep.get(t.rep) || { dials: 0, texts: 0 };
        r[t.kind === 'call' ? 'dials' : 'texts']++;
        byRep.set(t.rep, r);
      }
      for (const [rep, n] of byRep) {
        const r = row(rep);
        r.worked++; r.dials += n.dials; r.texts += n.texts;
        // Contacted = this rep's own contact (their call, or a reply to their text).
        if (contactedIn(L, inPeriod, rep)) r.contacted++;
        if (L.prospector !== rep) continue;
        r.qualified += L.qualifiedWeight;
        if (L.offerDay && inPeriod(L.offerDay)) r.offers++;
        if (L.contractDay && inPeriod(L.contractDay)) r.contracts++;
      }
    }
    return [...reps.values()].map(r => ({ ...r, qualPer100: r.worked ? (r.qualified / r.worked) * 100 : 0, lowSample: r.worked < CONFIG.minWorkedForRanking }))
      .sort((a, b) => b.contracts - a.contracts || b.offers - a.offers || b.qualPer100 - a.qualPer100);
  }

  function rankClosers(leads, inPeriod, inPeriodMs, now = Date.now(), overrides = {}) {
    const reps = new Map();
    const row = rep => { if (!reps.has(rep)) reps.set(rep, { rep, sellers: 0, touches: 0, offers: 0, contracts: 0, overdue: 0, qualifiedSellers: 0 }); return reps.get(rep); };
    const queue = actionQueue(leads, now, { overrides });
    const overdueBy = new Map();
    queue.forEach(i => { if (i.overdue) overdueBy.set(i.lead.closer || i.owner, (overdueBy.get(i.lead.closer || i.owner) || 0) + 1); });
    for (const L of leads.values()) {
      if (!L.allOpps.some(o => FOLLOW_UP_PIPELINES.includes(o.pipeline))) continue;
      const rep = L.closer || 'Unassigned';
      const r = row(rep);
      if (L.activeOpp) r.sellers++;
      r.qualifiedSellers += L.qualifiedWeight;
      r.touches += L.touches.filter(t => t.dir === 'out' && t.phase === 'closer' && inPeriod(t.dateKey)).length;
      if (L.offerAt && inPeriodMs(L.offerAt)) r.offers++;
      if (L.contractAt && inPeriodMs(L.contractAt)) r.contracts++;
    }
    for (const [rep, n] of overdueBy) row(rep).overdue = n;
    return [...reps.values()].map(r => ({ ...r, offerToContract: r.offers ? r.contracts / r.offers : null }))
      .sort((a, b) => b.contracts - a.contracts || b.offers - a.offers);
  }

  function rankSources(leads, inPeriod, opts = {}) {
    const lists = new Map();
    const row = b => { if (!lists.has(b)) lists.set(b, { batch: b, contacts: 0, worked: 0, contacted: 0, qualified: 0, offers: 0, contracts: 0, overlap: 0 }); return lists.get(b); };
    for (const L of leads.values()) {
      const b = L.originalBatch || '(no source batch)';
      const r = row(b);
      if (!L.touches.some(t => t.dir === 'out' && inPeriod(t.dateKey) && (!opts.rep || t.rep === opts.rep))) continue;
      r.worked++;
      if (L.batchOverlap) r.overlap++;
      if (contactedIn(L, inPeriod, opts.rep)) r.contacted++;
      r.qualified += L.qualifiedWeight;
      if (L.offerDay && inPeriod(L.offerDay)) r.offers++;
      if (L.contractDay && inPeriod(L.contractDay)) r.contracts++;
    }
    for (const c of opts.contacts || []) {
      // List size: every contact whose original batch is this list (deduplicated).
      const L = leads.get(c.id);
      const b = L ? (L.originalBatch || '(no source batch)') : null;
      if (b && lists.has(b)) lists.get(b).contacts++;
    }
    return [...lists.values()].filter(r => r.worked).map(r => ({ ...r, qualPer100: r.worked ? (r.qualified / r.worked) * 100 : 0, lowSample: r.worked < CONFIG.minWorkedForRanking }))
      .sort((a, b) => (a.lowSample - b.lowSample) || b.qualPer100 - a.qualPer100 || b.contracts - a.contracts);
  }

  function dispositionTable(leads, inPeriod) {
    const rows = new Map([...DISPOSITIONS, 'unclear'].map(d => [d, { disposition: d, label: LABELS[d], contacts: 0, high: 0, medium: 0, low: 0, hot: 0, warm: 0, nurture: 0, dead: 0, unknown: 0 }]));
    for (const L of leads.values()) {
      if (!L.touches.some(t => t.dir === 'in' && inPeriod(t.dateKey))) continue;
      const r = rows.get(L.conv.disposition);
      if (!r) continue;
      r.contacts++;
      if (r[L.conv.confidence] !== undefined) r[L.conv.confidence]++;
      r[L.readiness] = (r[L.readiness] || 0) + 1;
    }
    return [...rows.values()];
  }

  /* ---------------- Data reliability ---------------- */
  function feedFreshness(sources, now = Date.now()) {
    const out = {};
    for (const [feed, at] of Object.entries(sources)) {
      const ms = toMs(at);
      const limit = (CONFIG.staleAfterMinutes[feed] || 60) * 60000;
      out[feed] = { at: ms, age: ms == null ? null : Math.max(0, now - ms), stale: ms == null || now - ms > limit, missing: ms == null, limitMinutes: limit / 60000 };
    }
    return out;
  }
  // A metric is "incomplete" when any feed it depends on is stale/missing or a
  // required mapping is absent. Callers show "Incomplete data", never a zero.
  function metricState(deps, feeds, extra = []) {
    const reasons = [];
    for (const d of deps) {
      const f = feeds[d];
      if (!f) continue;
      if (f.missing) reasons.push(`${d} feed not connected`);
      else if (f.stale) reasons.push(`${d} feed is ${Math.round(f.age / 60000)} min old`);
    }
    reasons.push(...extra.filter(Boolean));
    return { ok: reasons.length === 0, reasons };
  }

  const api = { EXCLUDED_TAGS, excludedTagReason, notQualifiedTag, isLostOpp, CONFIG, STAGES, DISPOSITIONS, LABELS, QUEUES, QUAL_KEYS, QUAL_LABELS, INTEREST, DEAD, stageGroup, funnelStage, contactedIn, sellerKey, estimateQualification, FOLLOW_UP_PIPELINES, NOT_READY_STAGE, GHOSTED_STAGE, stageKey, classifyMessage, classifyConversation, readiness, qualificationOf, buildLeads, actionQueue, funnel, rankCold, rankClosers, rankSources, dispositionTable, feedFreshness, metricState, stripQuoted, isEmojiOnly, promptType, attachPrompts, newActivitySince, parseTags, STATUS_TAG };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LeadIntel = api;
})(typeof window !== 'undefined' ? window : globalThis);
