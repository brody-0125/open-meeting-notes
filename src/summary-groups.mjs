// Keep displayed, reviewed and exported candidates in the same order.
export function summaryGroups(result) {
  if (result.reconciliation?.state === 'complete') return [{ index: 0, summary: result.summary }];
  return result.summaryParts?.parts ?? (result.summary ? [{ index: 0, summary: result.summary }] : []);
}
