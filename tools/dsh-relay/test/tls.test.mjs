/**
 * TLS 三模式测试（工单要求 6）：`off` / `selfsigned`（node:crypto 自签）/ `file`。
 *
 * 为什么必须真跑握手而不是只断言"文件存在"：
 * 自签证书是自己用最小 DER 编码器拼出来的，只有让 `node:tls` 真正完成一次握手，
 * 才能证明 ASN.1 结构、签名算法、SAN 都对（这正是最容易写错又最难自查的部分）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, defaultConfig, mergeConfig, validateConfig } from '../lib/config.mjs';
import { describeCertificateSubject, generateSelfSignedCertificate, inspectCertificate } from '../lib/tls.mjs';
import { httpRequest, makeSandbox, registerHomeToken, startRelay } from './helpers.mjs';
import { openTunnel, wsHandshake } from './ws-client.mjs';

test('自签证书：X.509 可解析、CN/SAN 正确、自验签通过、系统信任链校验被拒', () => {
  const material = generateSelfSignedCertificate({ commonName: 'relay.example.com', days: 30 });
  assert.match(material.cert, /^-----BEGIN CERTIFICATE-----/);
  assert.match(material.key, /^-----BEGIN PRIVATE KEY-----/);

  const x509 = new crypto.X509Certificate(material.cert);
  assert.match(x509.subject, /CN=relay\.example\.com/);
  assert.equal(x509.subject, x509.issuer, '自签证书 issuer 必须等于 subject');
  assert.equal(x509.checkHost('relay.example.com'), 'relay.example.com', 'SAN 必须覆盖 relayName');
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x509.checkIP('::1'), '::1');
  assert.equal(x509.verify(x509.publicKey), true, '自签名必须能被自己的公钥验证');
  assert.deepEqual(inspectCertificate(material.cert), { usable: true });
  assert.ok(material.notAfter - material.notBefore >= 30 * 86_400_000);
});

test('inspectCertificate：过期与非法内容都要判为不可用（避免用坏证书启动）', () => {
  const expired = generateSelfSignedCertificate({ commonName: 'old.local', days: 1, now: Date.now() - 10 * 86_400_000 });
  const verdict = inspectCertificate(expired.cert, Date.now());
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason, /过期|生效/);
  assert.equal(inspectCertificate('not a pem', Date.now()).usable, false);
});

test('tls.mode=selfsigned：HTTPS /health 与 WSS 隧道端到端可用，客户端能看到自签 CN', async (t) => {
  const h = await startRelay(t, { relayName: 'relay.selfsigned.test', tls: { mode: 'selfsigned' } });
  assert.match(h.baseUrl, /^https:/);
  assert.match(h.wsUrl, /^wss:/);

  const health = await h.request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.match(health.cert.subject.CN, /relay\.selfsigned\.test/);

  const registered = await h.registerHome({ homeName: 'PC-TLS' });
  const { tunnel, ready } = await h.openHomeTunnel(registered.json.homeToken, { rejectUnauthorized: false });
  assert.equal(ready.homeId, registered.json.homeId);
  tunnel.destroy();

  // 生产默认（严格校验）必须拒绝自签证书 —— 证明它确实是自签而不是被系统信任
  await assert.rejects(
    () => wsHandshake(`${h.wsUrl}/api/v2/tunnel/home`, { headers: { Authorization: `Bearer ${registered.json.homeToken}` } }),
    (err) => {
      assert.match(String(err.code ?? err.message), /SELF_SIGNED|self.signed|DEPTH_ZERO/i);
      return true;
    },
  );
});

test('tls.mode=selfsigned：证书落盘并在重启后复用（手机不必反复重新信任）', async (t) => {
  const h = await startRelay(t, { relayName: 'relay.reuse.test', tls: { mode: 'selfsigned' } });
  const certFile = path.join(h.config.tlsDir, 'relay.crt');
  const keyFile = path.join(h.config.tlsDir, 'relay.key');
  const first = await fs.readFile(certFile, 'utf8');
  assert.match(first, /BEGIN CERTIFICATE/);
  assert.equal(h.relay.tls.generated, true);

  // 同一个 home 目录再起一次：必须复用已有文件（不重新生成）
  const { createRelay } = await import('../lib/http.mjs');
  const again = await createRelay(validateConfig(h.config, { cliHome: h.home }));
  assert.equal(again.tls.generated, false);
  const second = await fs.readFile(certFile, 'utf8');
  assert.equal(second, first, '证书内容必须逐字节一致（复用而非重生成）');
  await fs.readFile(keyFile, 'utf8');
  await again.close();
});

test('tls.mode=file：指定 cert/key 生效；文件缺失时启动前就报错', async (t) => {
  const material = generateSelfSignedCertificate({ commonName: 'relay.file.test', days: 30 });
  const sandbox = await makeSandbox(t);
  const certFile = path.join(sandbox.home, 'custom.crt');
  const keyFile = path.join(sandbox.home, 'custom.key');
  await fs.writeFile(certFile, material.cert, 'utf8');
  await fs.writeFile(keyFile, material.key, 'utf8');

  const { createRelay } = await import('../lib/http.mjs');
  const config = validateConfig(
    mergeConfig(defaultConfig({}), { relayName: 'relay.file.test', host: '127.0.0.1', port: 0, log: { toConsole: false }, tls: { mode: 'file', certFile, keyFile } }),
    { cliHome: sandbox.home, requireTlsFiles: true },
  );
  const relay = await createRelay(config);
  const port = await relay.listen();
  const health = await httpRequest(`https://127.0.0.1:${port}`, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.match(health.cert.subject.CN, /relay\.file\.test/);
  await relay.close();

  // 缺文件必须在启动前报错（而不是等第一次握手才失败）
  assert.throws(
    () =>
      validateConfig(mergeConfig(defaultConfig({}), { tls: { mode: 'file', certFile: path.join(sandbox.home, 'missing.crt'), keyFile } }), {
        cliHome: sandbox.home,
        requireTlsFiles: true,
      }),
    ConfigError,
  );
  assert.throws(() => validateConfig(mergeConfig(defaultConfig({}), { tls: { mode: 'file' } }), { cliHome: sandbox.home }), ConfigError);
});

test('tls.mode=off：明文 ws 可用，且不会偷偷起 TLS', async (t) => {
  const h = await startRelay(t);
  assert.equal(h.relay.tls.mode, 'off');
  assert.match(h.wsUrl, /^ws:/);
  const health = await h.request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.cert, null);
  await assert.rejects(() => httpRequest(`https://127.0.0.1:${h.port}`, 'GET', '/health'), /socket hang up|ECONNRESET|wrong version|SSL/i);
});

test('tls.mode=selfsigned：device 隧道同样走 wss 并能完成配对往返', async (t) => {
  const h = await startRelay(t, { relayName: 'relay.duo.test', tls: { mode: 'selfsigned' } });
  const registered = await h.registerHome({ homeName: 'PC-TLS-2' });
  const { tunnel: homeTunnel } = await h.openHomeTunnel(registered.json.homeToken, { rejectUnauthorized: false });

  const { declarePairWindow, createFakeGateway } = await import('./helpers.mjs');
  createFakeGateway(homeTunnel, { 'POST /api/v2/pair/claim': { status: 200, body: { token: 'dshr_tls_token_0001', tokenId: 'tok_tls', serverName: 'PC-TLS-2', expiresAt: null, relay: { deviceToken: 'dshr_tls_token_0001' } } } });
  assert.equal((await declarePairWindow(homeTunnel, { code: '482913' })).status, 200);

  const claim = await h.request('POST', '/api/v2/pair/claim', { body: { code: '482913', deviceName: 'Xiaomi 14', deviceId: '8f3c1a2b-1111-4222-8333-444455556666' } });
  assert.equal(claim.status, 200, claim.text);
  assert.match(claim.json.relay.tunnelUrl, /^wss:\/\/relay\.duo\.test:\d+\/api\/v2\/tunnel\/device$/);

  const device = await openTunnel(`${h.wsUrl}/api/v2/tunnel/device`, { role: 'device', token: claim.json.relay.deviceToken, rejectUnauthorized: false });
  const ready = await device.handshake();
  assert.equal(ready.homeId, registered.json.homeId);
  device.destroy();
  homeTunnel.destroy();
});

test('describeCertificateSubject：空 subject 的证书（Let\'s Encrypt IP 证书形态）不得让启动崩溃', () => {
  // 真实证据（服务器实测 node v22.22.1 解析 LE 的 IP 地址证书）：
  //   X509Certificate.subject === undefined（typeof undefined），
  //   subjectAltName === 'IP Address:123.207.183.237'，证书身份**只在 SAN 里**。
  // 早先 tls.mode=file 分支直接写 `info.subject.replace(...)`，因此加载正式证书时抛
  // TypeError: Cannot read properties of undefined (reading 'replace') —— 也就是
  // 「公网 + 正式证书」这条唯一的生产形态既 init 不了也 serve 不起来。
  assert.equal(
    describeCertificateSubject({ subject: undefined, subjectAltName: 'IP Address:203.0.113.9' }),
    '空 subject，身份由 SAN 承载：IP Address:203.0.113.9',
    '空 subject 必须退化为 SAN 描述，而不是抛 TypeError',
  );
  assert.equal(describeCertificateSubject({ subject: '' }), '空 subject');
  assert.equal(describeCertificateSubject({ subject: null, subjectAltName: '' }), '空 subject');
  assert.equal(describeCertificateSubject(null), '空 subject', '必须容忍 undefined/null');
  // 普通证书保持旧日志语义：DN 里的换行折成一行
  assert.equal(describeCertificateSubject({ subject: 'CN=relay.example.com' }), 'CN=relay.example.com');
  assert.equal(describeCertificateSubject({ subject: "C=US\nO=Let's Encrypt\nCN=YE2" }), "C=US, O=Let's Encrypt, CN=YE2");
});
