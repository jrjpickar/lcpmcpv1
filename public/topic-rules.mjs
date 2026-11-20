const rules = [
  ['Email', /\b(?:e-?mails?|inbox|mailbox|sender|reply|newsletter)\b/i],
  ['Acquisitions', /\b(?:acquisitions?|sellers?|offers?|escrow|title company)\b/i],
  ['Outreach', /\b(?:dial\w*|outreach|sms|cold calls?|opt-?outs?)\b/i],
  ['Accounting', /\b(?:accounting|ledger|fees?|payments?|invoices?)\b/i],
  ['Scheduling', /\b(?:schedul\w*|calendar|deadline|appointments?)\b/i],
  ['QC', /\b(?:qc|quality control|inspection|audit|defect)\b/i],
  ['Development', /\b(?:develop\w*|code|sql|module|software|bug|build)\b/i],
  ['Systems', /\b(?:systems?|kpis?|metrics?|runway|health|pipeline)\b/i],
];

export function topicFor(text) {
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || 'General';
}
