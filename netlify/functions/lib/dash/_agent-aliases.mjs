// Reporting identity only. Never use these mappings to rewrite GHL ownership or authentication.
export const AGENT_ALIASES = Object.freeze({
  '7M056fuz0hlzKFwbnQpt': '0o04fuZfD8lslmrIP4s5',
  // Same account as the dialer spells it (capital I). The dialer's signed-in ownership
  // export sends this ID, so it has to map to Art too.
  '7M056fuz0hIzKFwbnQpt': '0o04fuZfD8lslmrIP4s5',
  Xqzhd9NEv3P9RBtLQXc2: 'Dcc7H7rZQIwkLFNphrOc',
  hSqLPoj7jitlBhV15AHo: 'tkcNLziNqC1TOgoj0FE1',
  AZwkJsS35OfWgNjcVTVg: 'Dcc7H7rZQIwkLFNphrOc',
  '7sqeqQ908dQMAnAfKYy2': 'Dcc7H7rZQIwkLFNphrOc',
  I1cDDFX8pnoZf8sH3BM3: 'Dcc7H7rZQIwkLFNphrOc',
  ezD8vajvh6virQdCjoTz: 'Dcc7H7rZQIwkLFNphrOc',
  '8P1CxQ9IPw59aqVddqLn': 'Dcc7H7rZQIwkLFNphrOc',
  ToFkQDHGNEim7FehEpWi: 'Dcc7H7rZQIwkLFNphrOc',
  '1GKnDD5qrz03D7m1acQt': '0o04fuZfD8lslmrIP4s5',
  '7cUxSW6aY8Q5zgobUIcM': 'UxhQAXoTQ3k8St26dRwH',
});
export const reportingAgentId = id => AGENT_ALIASES[id] || id || '';
