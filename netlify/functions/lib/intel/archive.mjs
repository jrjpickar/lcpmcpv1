// Minimal archive helpers with no dependencies: ZIP writer (deflate) and a tar.gz reader for GitHub tarballs.
// The tar reader refuses absolute paths, "..", links and device files, and enforces file count and size caps.
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib';

export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const dos = date => {
    const d = date || new Date();
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), day: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  };
  for (const file of files) {
    const name = Buffer.from(file.path.replace(/^\/+/, ''), 'utf8');
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8');
    const packed = deflateRawSync(data);
    const method = packed.length < data.length ? 8 : 0;
    const body = method ? packed : data;
    const crc = crc32(data) >>> 0;
    const { time, day } = dos(file.date);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100644 << 16 >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Returns [{ path, content: Buffer }] with the top folder (GitHub's "<repo>-<sha>/") stripped.
export function untarGz(buffer, { maxFiles = 5000, maxBytes = 80 * 1048576, maxFileBytes = 5 * 1048576 } = {}) {
  const tar = gunzipSync(buffer, { maxOutputLength: maxBytes });
  const files = [];
  let offset = 0, longName = null, paxPath = null;
  const str = (start, length) => tar.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(str(offset + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(offset + 345, 155);
    let name = paxPath || longName || (prefix ? prefix + '/' : '') + str(offset, 100);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { paxPath = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'))?.[1] || null; continue; }
    if (type === 'g') continue;
    longName = null; paxPath = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue; // directories, links and devices are skipped
    const parts = name.split('/').slice(1); // strip top folder
    if (!parts.length || parts.some(part => part === '..' || part === '') || name.startsWith('/')) continue;
    if (size > maxFileBytes) continue;
    files.push({ path: parts.join('/'), content: Buffer.from(data) });
    if (files.length >= maxFiles) throw new Error('The archive has more than ' + maxFiles + ' files.');
  }
  return files;
}

// Unified diff with one hunk per file: common prefix and suffix trimmed, the middle shown as removed then added lines.
// Always a valid patch (git apply / patch -p1), just not minimal for scattered edits.
export function unifiedDiff(path, before, after, context = 3) {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n'), b = after === null ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length - 1, endA + context), toB = Math.min(b.length - 1, endB + context);
  const lines = [];
  for (let i = from; i < start; i++) lines.push(' ' + a[i]);
  for (let i = start; i <= endA; i++) lines.push('-' + a[i]);
  for (let i = start; i <= endB; i++) lines.push('+' + b[i]);
  for (let i = endA + 1; i <= toA; i++) lines.push(' ' + a[i]);
  const countA = toA - from + 1, countB = toB - from + 1;
  return ['--- ' + (before === null ? '/dev/null' : 'a/' + path), '+++ ' + (after === null ? '/dev/null' : 'b/' + path),
    '@@ -' + (countA ? from + 1 : 0) + ',' + countA + ' +' + (countB ? from + 1 : 0) + ',' + countB + ' @@', ...lines, ''].join('\n');
}
