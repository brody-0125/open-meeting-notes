// Configuration prerequisites only. OS enforcement still needs independent egress tests.
export function assessWindowsEgressPolicy(snapshot, program) {
  if (typeof program !== 'string' || !/^[a-z]:\\/i.test(program) || /(?:^|\\)\.\.?(?:\\|$)/.test(program))
    throw new Error('absolute Windows executable path required');
  const problems = [], matchingRules = [];
  if (!Array.isArray(snapshot?.profiles) || !Array.isArray(snapshot?.rules)) problems.push('policy-inspection-unavailable');
  else {
    for (const name of ['Domain', 'Private', 'Public']) {
      const profiles = snapshot.profiles.filter(p => p?.name === name);
      if (profiles.length !== 1 || profiles[0].enabled !== 'True') problems.push(`profile-not-enabled:${name}`);
    }
    const any = value => Array.isArray(value) && value.length === 1 && value[0] === 'Any';
    for (const r of snapshot.rules) if (r && typeof r.name === 'string' &&
      typeof r.program === 'string' && r.program.toLowerCase() === program.toLowerCase() &&
      r.enabled === 'True' && r.direction === 'Outbound' && r.action === 'Block' && r.profile === 'Any' &&
      r.protocol === 'Any' && r.service === 'Any' && r.interfaceType === 'Any' && r.primaryStatus === 'OK' &&
      [r.localPort, r.remotePort, r.localAddress, r.remoteAddress, r.interfaceAlias].every(any)) matchingRules.push(r.name);
    if (!matchingRules.length) problems.push('full-outbound-block-not-found');
  }
  return { prerequisitesSatisfied: problems.length === 0, effectivePolicyVerified: false, problems, matchingRules };
}
