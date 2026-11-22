// Deterministic text helpers for retrieval: tokenizing, chunking, BM25, cosine, hashing, vector packing.
// No model calls here. Everything is pure so it runs the same on Netlify, the VM and in tests.
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const stop = new Set(('a an the and or but if then else for with without from into onto over under that this these those what which who whom how why when where ' +
  'is are was were be been being am do does did done have has had having can could should would will shall may might must of on in at to by as it its ' +
  'you your yours we our ours they their them he she his her i me my not no yes so than too very just also only each any all some such please about').split(' '));

export function tokenize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_$.#/-]+/).flatMap(word => word.split(/[./#-]+/).concat(word.includes('.') || word.includes('/') ? [word] : []))
    .filter(word => word.length > 1 && word.length < 40 && !stop.has(word));
}

export const clip = (value, max) => {
  const text = String(value ?? '').replace(/[–—]/g, '-');
  return text.length > max ? text.slice(0, Math.max(0, max - 3)).trimEnd() + '...' : text;
};
export const approxTokens = value => Math.ceil(String(value || '').length / 4);

// Split text into chunks near `size` characters. Breaks on headings, then blank lines, then sentences.
// Each chunk keeps the closest heading so a retrieved passage still says where it came from.
export function chunkText(text, { size = 900, overlap = 120, maxChunks = 400 } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let heading = '', buffer = [];
  const flush = () => { const body = buffer.join('\n').trim(); if (body) blocks.push({ heading, text: body }); buffer = []; };
  for (const line of lines) {
    const label = /^([A-Z][A-Za-z0-9 ,&/()-]{2,60}):$/.exec(line.trim());
    const h = /^(#{1,6})\s+(.+)$/.exec(line) || (label && [null, '', label[1]]);
    if (h && h[2] && line.trim().length < 100) { flush(); heading = h[2].trim().slice(0, 120); continue; }
    if (!line.trim()) { buffer.push(''); continue; }
    buffer.push(line);
  }
  flush();
  const chunks = [];
  for (const block of blocks) {
    const paragraphs = block.text.split(/\n{2,}/);
    let current = '';
    const push = () => { if (current.trim()) chunks.push({ heading: block.heading, text: current.trim() }); };
    for (const paragraph of paragraphs) {
      if ((current + '\n\n' + paragraph).length <= size) { current = current ? current + '\n\n' + paragraph : paragraph; continue; }
      push();
      if (paragraph.length <= size) { current = paragraph; continue; }
      // Long paragraph: sentence windows with overlap.
      const sentences = paragraph.match(/[^.!?\n]+[.!?]?\s*/g) || [paragraph];
      current = '';
      for (const sentence of sentences) {
        if ((current + sentence).length > size && current) {
          push();
          current = current.slice(-overlap) + sentence;
        } else current += sentence;
        while (current.length > size * 1.5) { chunks.push({ heading: block.heading, text: current.slice(0, size) }); current = current.slice(size - overlap); }
      }
    }
    push();
    if (chunks.length >= maxChunks) break;
  }
  return chunks.slice(0, maxChunks).map((chunk, index) => ({ i: index, ...chunk }));
}

// CSV: one chunk per group of rows with the header repeated, so each chunk is readable alone.
export function chunkCsv(text, { rowsPerChunk = 25, maxChunks = 400 } = {}) {
  const rows = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  if (rows.length < 2) return chunkText(text, { maxChunks });
  const [header, ...body] = rows;
  const chunks = [];
  for (let start = 0; start < body.length && chunks.length < maxChunks; start += rowsPerChunk) {
    chunks.push({ i: chunks.length, heading: 'rows ' + (start + 1) + '-' + Math.min(body.length, start + rowsPerChunk), text: [header, ...body.slice(start, start + rowsPerChunk)].join('\n') });
  }
  return chunks;
}

// Okapi BM25 over a list of documents (already tokenized). Returns scores aligned with docs.
export function bm25(queryTokens, docs, { k1 = 1.2, b = 0.75 } = {}) {
  if (!docs.length || !queryTokens.length) return docs.map(() => 0);
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const df = new Map();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  const terms = [...new Set(queryTokens)];
  return docs.map(doc => {
    const tf = new Map();
    for (const term of doc) tf.set(term, (tf.get(term) || 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.length / avg));
    }
    return score;
  });
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Vectors are stored as int8 (scaled by the max magnitude) in base64. About 4x smaller than JSON floats.
export function packVector(vector) {
  const max = Math.max(1e-9, ...vector.map(Math.abs));
  const bytes = Int8Array.from(vector, value => Math.round(value / max * 127));
  return Buffer.from(bytes.buffer).toString('base64');
}
export function unpackVector(packed) {
  if (typeof packed !== 'string') return null;
  const buffer = Buffer.from(packed, 'base64');
  return Array.from(new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
}

// Pick the sentences of a passage that best match the query, keeping order. Used to compress context.
export function bestSentences(text, query, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const sentences = value.match(/[^.!?\n]+[.!?]?/g) || [value];
  const q = new Set(tokenize(query));
  const scored = sentences.map((sentence, index) => ({ index, sentence: sentence.trim(), score: tokenize(sentence).filter(t => q.has(t)).length }));
  const picked = [];
  let size = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (size + item.sentence.length + 1 > maxChars) continue;
    picked.push(item); size += item.sentence.length + 1;
  }
  return picked.sort((a, b) => a.index - b.index).map(item => item.sentence).join(' ') || clip(value, maxChars);
}

// Jaccard similarity on token sets, for memory deduplication.
export function jaccard(a, b) {
  const x = new Set(tokenize(a)), y = new Set(tokenize(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

// Run tasks with at most `limit` in flight. Keeps order of results.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}
