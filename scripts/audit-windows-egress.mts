import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyDevelopmentPackage } from '../src/package-integrity.mjs';
import { assessWindowsEgressPolicy } from '../src/windows-egress-policy.mjs';
const [root, approvedManifestHash] = process.argv.slice(2);
if (process.platform !== 'win32' || !root || !approvedManifestHash)
  throw new Error('usage on Windows: node scripts/audit-windows-egress.mjs PACKAGE_DIRECTORY APPROVED_MANIFEST_SHA256');
const directory = resolve(root);
await verifyDevelopmentPackage({ root: directory, approvedManifestHash });
const program = join(directory, 'open-meeting-notes.exe');
// Fixed read-only query. No path interpolation, policy writes, elevation, or execution-policy override.
const query = `
$ErrorActionPreference = 'Stop'
$profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
  @{ name = [string]$_.Name; enabled = [string]$_.Enabled }
})
$rules = @(Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object { $_.Group -ceq 'open-meeting-notes offline deployment' } | ForEach-Object {
  $rule = $_
  $application = @($rule | Get-NetFirewallApplicationFilter)
  $port = @($rule | Get-NetFirewallPortFilter)
  $address = @($rule | Get-NetFirewallAddressFilter)
  $service = @($rule | Get-NetFirewallServiceFilter)
  $interface = @($rule | Get-NetFirewallInterfaceFilter)
  $type = @($rule | Get-NetFirewallInterfaceTypeFilter)
  if ($application.Count -ne 1 -or $port.Count -ne 1 -or $address.Count -ne 1 -or $service.Count -ne 1 -or $interface.Count -ne 1 -or $type.Count -ne 1) { throw 'Ambiguous firewall filters' }
  @{ name = [string]$rule.Name; program = [string]$application[0].Program;
     enabled = [string]$rule.Enabled; direction = [string]$rule.Direction; action = [string]$rule.Action;
     profile = [string]$rule.Profile; primaryStatus = [string]$rule.PrimaryStatus;
     protocol = [string]$port[0].Protocol; localPort = @($port[0].LocalPort); remotePort = @($port[0].RemotePort);
     localAddress = @($address[0].LocalAddress); remoteAddress = @($address[0].RemoteAddress);
     service = [string]$service[0].Service; interfaceAlias = @($interface[0].InterfaceAlias); interfaceType = [string]$type[0].InterfaceType }
})
@{ profiles = $profiles; rules = $rules } | ConvertTo-Json -Depth 6 -Compress
`;
let snapshot = null, inspectionError;
try {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
    { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  snapshot = JSON.parse(stdout.trim());
} catch (error) { inspectionError = String(error.message).slice(0, 1500); }
const assessment = assessWindowsEgressPolicy(snapshot, program);
console.log(JSON.stringify({ program, approvedManifestHash, snapshot, ...assessment,
  ...(inspectionError ? { inspectionError } : {}) }, null, 2));
process.exitCode = assessment.prerequisitesSatisfied ? 0 : 1;
