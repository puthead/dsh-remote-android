/**
 * TLS 三模式（契约/工单要求：`off` / `selfsigned` / `file`）。
 *
 * `selfsigned` 为什么自己写 DER 而不是调 openssl：
 * 1. 契约 §5.1 要求零第三方依赖、只用 Node 内置模块；`node:crypto` 能生成密钥与签名，
 *    但**没有**"生成自签证书"的 API，所以这里用最小 ASN.1/DER 编码器把 X.509 拼出来；
 * 2. 依赖 `openssl`/`New-SelfSignedCertificate` 会让"上传即启动"的部署在精简 VPS 上失败
 *    （本项目实测环境就没有 openssl），而自签证书必须能在任意机器上一键生成。
 *
 * 证书内容刻意保持最小可用：RSA-2048 + sha256WithRSAEncryption、CN=<relayName>、
 * SAN 含 relayName/localhost/127.0.0.1/::1、basicConstraints(cA=FALSE)、keyUsage、extKeyUsage(serverAuth)。
 * 注意：`selfsigned` **只适用于本机/内网与 PC 侧联调**。手机 App 不提供"信任自签证书"开关
 * （需求 FR-15 / O8：仅系统默认信任链），所以公网形态必须用 `file` + 正式证书；无域名时用
 * Let's Encrypt 的 IP 地址证书（其 `subject` 为空、身份全在 SAN，见本文件 `describeCertificateSubject`）。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, existsSync, hostName } from './util.mjs';

// ---------------------------------------------------------------- 最小 DER 编码器

/** DER 长度字段。 */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** TLV：tag + 长度 + 内容。 */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const derSeq = (...items) => tlv(0x30, Buffer.concat(items));
const derSet = (...items) => tlv(0x31, Buffer.concat(items));
const derNull = () => Buffer.from([0x05, 0x00]);
const derUtf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const derIa5 = (text) => tlv(0x16, Buffer.from(text, 'ascii'));
const derOctet = (buf) => tlv(0x04, buf);
/** BIT STRING：首字节是"未用位数"。 */
const derBitString = (buf, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
/** 上下文相关显式标签（X.509 的 version/extensions 用）。 */
const derExplicit = (tagNumber, content) => tlv(0xa0 | tagNumber, content);
/** INTEGER：内容首字节高位置 1 时要补 0x00，避免被解析成负数。 */
function derInt(buf) {
  const body = buf.length > 0 && buf[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
  return tlv(0x02, body);
}

/** 点分 OID → DER（base-128，首字节 = 40*a + b）。 */
export function encodeOid(dotted) {
  const parts = String(dotted).split('.').map((part) => Number(part));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`非法 OID：${dotted}`);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = Math.floor(part / 128);
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime（YYMMDDHHMMSSZ）；X.509 在 2050 年前用 UTCTime。 */
function derUtcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

/** Name ::= SEQUENCE OF RDN ::= SET OF AttributeTypeAndValue（这里只做单值 RDN）。 */
function derName(commonName) {
  const cn = derSet(derSeq(encodeOid('2.5.4.3'), derUtf8(commonName)));
  return derSeq(cn);
}

/** iPAddress 形式的 GeneralName：4 字节 IPv4 / 16 字节 IPv6。 */
function ipToBuffer(ip) {
  if (ip.includes(':')) {
    // IPv6：展开 :: 简写后再按 16 位分组
    const [head, tail = ''] = ip.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
    const buf = Buffer.alloc(16);
    full.slice(0, 8).forEach((part, index) => buf.writeUInt16BE(parseInt(part || '0', 16), index * 2));
    return buf;
  }
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`非法 IP：${ip}`);
  return Buffer.from(parts);
}

/** SAN 扩展（2.5.29.17）的 extnValue 内容（GeneralNames SEQUENCE）。 */
function derSubjectAltName(names) {
  const entries = names.map((name) => {
    if (name.type === 'ip') return tlv(0x87, ipToBuffer(name.value)); // [7] iPAddress
    return tlv(0x82, Buffer.from(name.value, 'ascii')); // [2] dNSName
  });
  return derSeq(...entries);
}

/** Extension ::= SEQUENCE { extnID, critical?, extnValue }。 */
function derExtension(oid, value, critical = false) {
  const parts = [encodeOid(oid)];
  if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
  parts.push(derOctet(value));
  return derSeq(...parts);
}

/** SignatureAlgorithmIdentifier：sha256WithRSAEncryption。 */
const SIG_ALG_SHA256_RSA = derSeq(encodeOid('1.2.840.113549.1.1.11'), derNull());

/**
 * 生成自签证书（RSA-2048 / SHA-256）。
 * @param {{commonName?: string, altNames?: Array<{type:'dns'|'ip', value:string}>, days?: number, now?: number}} [opts]
 * @returns {{cert: string, key: string, commonName: string, notBefore: number, notAfter: number, serialNumber: string, subjectAltNames: string[]}}
 */
export function generateSelfSignedCertificate({ commonName = null, altNames = null, days = 825, now = Date.now() } = {}) {
  const cn = (commonName && String(commonName).trim()) || hostName();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' }, // SPKI DER 可直接嵌入证书，省掉手工编码
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const names = altNames ?? [
    { type: 'dns', value: cn },
    { type: 'dns', value: 'localhost' },
    { type: 'ip', value: '127.0.0.1' },
    { type: 'ip', value: '::1' },
  ];

  const notBeforeMs = now - 86_400_000; // 回拨 1 天，避免"刚生成就因时钟偏差未生效"
  const notAfterMs = now + days * 86_400_000;
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // 保证正数
  if (serial.every((byte) => byte === 0)) serial[15] = 1;

  const extensions = derExplicit(
    3,
    derSeq(
      // basicConstraints：critical，cA=FALSE（叶子证书）
      derExtension('2.5.29.19', derSeq(), true),
      // keyUsage：critical，digitalSignature + keyEncipherment
      derExtension('2.5.29.15', derBitString(Buffer.from([0xa0]), 5), true),
      // extKeyUsage：serverAuth
      derExtension('2.5.29.37', derSeq(encodeOid('1.3.6.1.5.5.7.3.1'))),
      // subjectAltName：现代客户端只看 SAN，不看 CN
      derExtension('2.5.29.17', derSubjectAltName(names)),
    ),
  );

  const tbs = derSeq(
    derExplicit(0, derInt(Buffer.from([0x02]))), // version v3
    derInt(serial),
    SIG_ALG_SHA256_RSA,
    derName(cn), // issuer == subject（自签）
    derSeq(derUtcTime(new Date(notBeforeMs)), derUtcTime(new Date(notAfterMs))),
    derName(cn),
    publicKey, // SPKI DER
    extensions,
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = derSeq(tbs, SIG_ALG_SHA256_RSA, derBitString(signature));
  const cert = toPem(der, 'CERTIFICATE');

  return {
    cert,
    key: privateKey,
    commonName: cn,
    notBefore: notBeforeMs,
    notAfter: notAfterMs,
    serialNumber: serial.toString('hex'),
    subjectAltNames: names.map((name) => `${name.type}:${name.value}`),
  };
}

/** DER → PEM（64 列）。 */
export function toPem(der, label) {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 检查已有证书是否还能用（解析成功、且距过期还有 ≥1 天）。
 * @param {string} certPem
 * @param {number} [now]
 * @returns {{usable: boolean, reason?: string}}
 */
export function inspectCertificate(certPem, now = Date.now()) {
  try {
    const info = new crypto.X509Certificate(certPem);
    const notAfter = Date.parse(info.validTo);
    const notBefore = Date.parse(info.validFrom);
    if (!Number.isFinite(notAfter) || !Number.isFinite(notBefore)) return { usable: false, reason: '有效期字段无法解析' };
    if (notAfter - now < 86_400_000) return { usable: false, reason: `证书即将过期（${info.validTo}）` };
    if (notBefore - now > 60_000) return { usable: false, reason: `证书尚未生效（${info.validFrom}）` };
    return { usable: true };
  } catch (err) {
    return { usable: false, reason: `证书无法解析：${err.message}` };
  }
}

/**
 * 把证书主体渲染成单行文本（日志用）。
 *
 * 为什么必须单独一个函数：**空 subject 的证书是合法的**。Let's Encrypt 的 IP 地址证书
 * 就没有 subject（身份完全由 SAN 承载：`IP Address:1.2.3.4`），而 Node 的
 * `X509Certificate.subject` 在这类证书上返回 `undefined`（实测 node v22.22.1 + LE IP 证书：
 * `subject` 为 undefined、`subjectAltName` 为 `IP Address:203.0.113.9`）。
 * 早先这里直接 `info.subject.replace(...)`，于是 `tls.mode=file` 加载正式证书时抛
 * `TypeError: Cannot read properties of undefined (reading 'replace')` —— 也就是
 * 「公网 + 正式证书」这条唯一的生产形态既初始化不了（init）也起不来（serve）。
 *
 * @param {{subject?: unknown, subjectAltName?: unknown}|null} info
 * @returns {string} 单行文本；subject 为空时退化为 SAN 描述
 */
export function describeCertificateSubject(info) {
  const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s*\n\s*/g, ', ').trim() : '');
  const subject = oneLine(info?.subject);
  if (subject) return subject;
  const san = oneLine(info?.subjectAltName);
  return san ? `空 subject，身份由 SAN 承载：${san}` : '空 subject';
}

/**
 * 按配置准备 TLS 材料。
 * @param {object} config 已校验配置
 * @param {{logger?: object|null, regenerate?: boolean}} [opts]
 * @returns {Promise<null | {cert: string, key: string, certFile: string|null, keyFile: string|null, generated: boolean, commonName: string|null}>}
 */
export async function ensureTlsMaterial(config, { logger = null, regenerate = false } = {}) {
  const mode = config.tls.mode;
  if (mode === 'off') return null;

  if (mode === 'file') {
    const [cert, key] = await Promise.all([fsp.readFile(config.tls.certFile, 'utf8'), fsp.readFile(config.tls.keyFile, 'utf8')]);
    // 立刻解析一次：证书/私钥不匹配或文件内容不是 PEM 时，宁可在启动时报错，也别等第一次握手才发现
    const info = new crypto.X509Certificate(cert);
    const checked = inspectCertificate(cert);
    if (!checked.usable) logger?.warn?.(`tls.mode=file：${checked.reason}（仍按配置使用）`);
    logger?.info?.(`TLS 证书已加载：${config.tls.certFile}（主体=${describeCertificateSubject(info)}，有效期至 ${info.validTo}）`);
    return { cert, key, certFile: config.tls.certFile, keyFile: config.tls.keyFile, generated: false, commonName: null };
  }

  // selfsigned：证书目录下固定文件名，存在且可用就复用（重启不换证书，手机端不必反复重新信任）
  const certFile = path.join(config.tlsDir, 'relay.crt');
  const keyFile = path.join(config.tlsDir, 'relay.key');
  const commonName = config.tls.commonName || config.relayName || hostName();
  if (!regenerate && existsSync(certFile) && existsSync(keyFile)) {
    const [cert, key] = await Promise.all([fsp.readFile(certFile, 'utf8'), fsp.readFile(keyFile, 'utf8')]);
    const checked = inspectCertificate(cert);
    if (checked.usable) {
      logger?.info?.(`复用已有自签证书：${certFile}（CN=${commonName}）`);
      return { cert, key, certFile, keyFile, generated: false, commonName };
    }
    logger?.warn?.(`自签证书不可用（${checked.reason}），重新生成`);
  }

  const material = generateSelfSignedCertificate({ commonName, days: config.tls.days });
  await fsp.mkdir(config.tlsDir, { recursive: true });
  await atomicWriteFile(certFile, material.cert);
  await atomicWriteFile(keyFile, material.key);
  await fsp.chmod(keyFile, 0o600).catch(() => {}); // Windows 上无效果，Linux 上必须
  logger?.info?.(`已生成自签证书：${certFile}（CN=${material.commonName}，SAN=${material.subjectAltNames.join(',')}，至 ${new Date(material.notAfter).toISOString()}）`);
  return { cert: material.cert, key: material.key, certFile, keyFile, generated: true, commonName: material.commonName };
}
