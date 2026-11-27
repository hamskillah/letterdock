import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTailscaleIpv4,
  isTailscaleIpv6,
  isTailscaleMagicDns,
  isTailscaleHostname,
  isAllowedTailscaleOrigin,
  type TailscaleSettings,
  type TailscaleHostInfo
} from '../src/tailscale.js';

test('Tailscale IPv4 CGNAT range validation (100.64.0.0/10)', () => {
  // Valid lower bound
  assert.equal(isTailscaleIpv4('100.64.0.0'), true);
  assert.equal(isTailscaleIpv4('100.64.0.1'), true);

  // Valid upper bound
  assert.equal(isTailscaleIpv4('100.127.255.254'), true);
  assert.equal(isTailscaleIpv4('100.127.255.255'), true);

  // Valid internal IPs
  assert.equal(isTailscaleIpv4('100.121.221.90'), true);
  assert.equal(isTailscaleIpv4('100.85.12.34'), true);

  // Invalid: one below lower bound (100.63.x.x)
  assert.equal(isTailscaleIpv4('100.63.255.255'), false);

  // Invalid: one above upper bound (100.128.x.x)
  assert.equal(isTailscaleIpv4('100.128.0.0'), false);
  assert.equal(isTailscaleIpv4('100.200.1.1'), false);

  // Invalid: other private / public IPs
  assert.equal(isTailscaleIpv4('192.168.1.1'), false);
  assert.equal(isTailscaleIpv4('10.0.0.1'), false);
  assert.equal(isTailscaleIpv4('172.16.0.1'), false);
  assert.equal(isTailscaleIpv4('127.0.0.1'), false);
  assert.equal(isTailscaleIpv4('8.8.8.8'), false);
  assert.equal(isTailscaleIpv4('not-an-ip'), false);
  assert.equal(isTailscaleIpv4(''), false);
});

test('Tailscale IPv6 ULA range validation (fd7a:115c:a1e0::/48)', () => {
  assert.equal(isTailscaleIpv6('fd7a:115c:a1e0::1'), true);
  assert.equal(isTailscaleIpv6('fd7a:115c:a1e0::1a28:dd5b'), true);
  assert.equal(isTailscaleIpv6('[fd7a:115c:a1e0::1a28:dd5b]'), true);
  assert.equal(isTailscaleIpv6('FD7A:115C:A1E0:0000::ABCD'), true);

  // Invalid IPv6
  assert.equal(isTailscaleIpv6('2001:db8::1'), false);
  assert.equal(isTailscaleIpv6('fe80::1'), false);
  assert.equal(isTailscaleIpv6('::1'), false);
  assert.equal(isTailscaleIpv6('fd7a:115c:a1e1::1'), false);
  assert.equal(isTailscaleIpv6(''), false);
});

test('Tailscale MagicDNS hostname validation (*.ts.net)', () => {
  assert.equal(isTailscaleMagicDns('letterdock.tailnet-xyz.ts.net'), true);
  assert.equal(isTailscaleMagicDns('ip-172-31-40-150-1.tail77946f.ts.net'), true);
  assert.equal(isTailscaleMagicDns('my-server.ts.net'), true);
  assert.equal(isTailscaleMagicDns('my-server.ts.net.'), true); // trailing dot allowed

  // Invalid attempts / attacks
  assert.equal(isTailscaleMagicDns('ts.net'), false);
  assert.equal(isTailscaleMagicDns('.ts.net'), false);
  assert.equal(isTailscaleMagicDns('evil-ts.net.com'), false);
  assert.equal(isTailscaleMagicDns('fake.ts.net.attacker.org'), false);
  assert.equal(isTailscaleMagicDns('attacker-ts-net.io'), false);
  assert.equal(isTailscaleMagicDns('google.com'), false);
  assert.equal(isTailscaleMagicDns(''), false);
});

test('Tailscale combined hostname checker', () => {
  assert.equal(isTailscaleHostname('100.121.221.90'), true);
  assert.equal(isTailscaleHostname('fd7a:115c:a1e0::1a28:dd5b'), true);
  assert.equal(isTailscaleHostname('node.tailnet.ts.net'), true);
  assert.equal(isTailscaleHostname('example.com'), false);
  assert.equal(isTailscaleHostname('192.168.1.100'), false);
});

test('isAllowedTailscaleOrigin authorization logic', () => {
  const enabledSettings: TailscaleSettings = {
    enabled: true,
    configuredOrigin: 'https://letterdock.custom-tailnet.ts.net',
    mode: 'serve'
  };

  const disabledSettings: TailscaleSettings = {
    enabled: false,
    configuredOrigin: 'https://letterdock.custom-tailnet.ts.net',
    mode: 'serve'
  };

  const mockHost: TailscaleHostInfo = {
    installed: true,
    running: true,
    backendState: 'Running',
    ips: ['100.121.221.90'],
    ipv4: '100.121.221.90',
    ipv6: null,
    hostname: 'test-host',
    magicDns: 'test-host.tailnet.ts.net'
  };

  // 1. Rejected when disabled
  assert.equal(
    isAllowedTailscaleOrigin('http://100.121.221.90:3000', disabledSettings, mockHost).allowed,
    false
  );
  assert.equal(
    isAllowedTailscaleOrigin('https://letterdock.custom-tailnet.ts.net', disabledSettings, mockHost).allowed,
    false
  );

  // 2. Allowed when enabled with valid Tailscale CGNAT IP
  const cgnatCheck = isAllowedTailscaleOrigin('http://100.121.221.90:3000', enabledSettings, mockHost);
  assert.equal(cgnatCheck.allowed, true);
  assert.match(cgnatCheck.reason || '', /100.64.0.0\/10/);

  // 3. Allowed when enabled with valid MagicDNS
  const magicDnsCheck = isAllowedTailscaleOrigin('https://test-host.tailnet.ts.net', enabledSettings, mockHost);
  assert.equal(magicDnsCheck.allowed, true);

  // 4. Allowed when matching explicit configured origin
  const customOriginCheck = isAllowedTailscaleOrigin('https://letterdock.custom-tailnet.ts.net', enabledSettings, mockHost);
  assert.equal(customOriginCheck.allowed, true);
  assert.match(customOriginCheck.reason || '', /configured Tailscale origin/);

  // 5. Rejected for external origins
  const attackerCheck = isAllowedTailscaleOrigin('https://malicious-attacker.com', enabledSettings, mockHost);
  assert.equal(attackerCheck.allowed, false);

  const subdomainEvasionCheck = isAllowedTailscaleOrigin('https://fake.ts.net.attacker.com', enabledSettings, mockHost);
  assert.equal(subdomainEvasionCheck.allowed, false);

  const missingCheck = isAllowedTailscaleOrigin(undefined, enabledSettings, mockHost);
  assert.equal(missingCheck.allowed, false);
});
