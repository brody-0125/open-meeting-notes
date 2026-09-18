import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWindowsEgressPolicy } from '../src/windows-egress-policy.mjs';
const program = 'C:\\Apps\\open-meeting-notes\\open-meeting-notes.exe';
const snapshot = () => ({ profiles: ['Domain', 'Private', 'Public'].map(name => ({ name, enabled: 'True' })),
  rules: [{ name: 'owned-rule', program, enabled: 'True', direction: 'Outbound', action: 'Block', profile: 'Any',
    protocol: 'Any', localPort: ['Any'], remotePort: ['Any'], localAddress: ['Any'], remoteAddress: ['Any'],
    service: 'Any', interfaceAlias: ['Any'], interfaceType: 'Any', primaryStatus: 'OK' }] });

test('matching policy is only a prerequisite, never proof of network isolation', () => {
  assert.deepEqual(assessWindowsEgressPolicy(snapshot(), program), {
    prerequisitesSatisfied: true, effectivePolicyVerified: false, problems: [], matchingRules: ['owned-rule'] });
});
test('missing or disabled profiles and missing rules fail closed', () => {
  for (const change of [s => s.profiles.pop(), s => s.profiles[0].enabled = 'False', s => s.rules = [],
    s => s.profiles.push(s.profiles[0])]) {
    const s = snapshot(); change(s);
    assert.equal(assessWindowsEgressPolicy(s, program).prerequisitesSatisfied, false);
  }
});
test('partial or differently scoped rules do not qualify as the full outbound block', () => {
  for (const [field, value] of Object.entries({ program: 'C:\\Other\\app.exe', enabled: 'False', direction: 'Inbound',
    action: 'Allow', profile: 'Private', protocol: 'TCP', localPort: ['443'], remotePort: ['443'],
    localAddress: ['LocalSubnet'], remoteAddress: ['LocalSubnet'], service: 'Dnscache',
    interfaceAlias: ['Ethernet'], interfaceType: 'Wireless', primaryStatus: 'Degraded' })) {
    const s = snapshot(); s.rules[0][field] = value;
    assert.equal(assessWindowsEgressPolicy(s, program).prerequisitesSatisfied, false, field);
  }
});
test('unavailable inspection and malformed snapshots cannot become successful checks', () => {
  for (const s of [null, {}, { profiles: [], rules: [] }, { profiles: null, rules: [] }])
    assert.equal(assessWindowsEgressPolicy(s, program).prerequisitesSatisfied, false);
});
test('case-insensitive Windows executable identity is accepted; relative paths are not', () => {
  assert.equal(assessWindowsEgressPolicy(snapshot(), program.toUpperCase()).prerequisitesSatisfied, true);
  assert.throws(() => assessWindowsEgressPolicy(snapshot(), 'open-meeting-notes.exe'), /absolute/);
});
