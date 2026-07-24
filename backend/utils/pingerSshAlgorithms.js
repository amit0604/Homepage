/**
 * ssh2 Client.connect algorithms — modern-first with legacy fallbacks for switches / ESXi / old Linux.
 * @see https://github.com/mscdex/ssh2#client-methods
 */
function pingerSshAlgorithms() {
  return {
    kex: [
      'curve25519-sha256',
      'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group1-sha1',
    ],
    serverHostKey: [
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-dss',
    ],
    cipher: [
      'chacha20-poly1305@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'aes256-ctr',
      'aes256-gcm@openssh.com',
      'aes128-gcm@openssh.com',
      'aes128-cbc',
      'aes192-cbc',
      'aes256-cbc',
      '3des-cbc',
    ],
    hmac: [
      'hmac-sha2-256',
      'hmac-sha2-512',
      'hmac-sha1',
      'hmac-sha1-96',
      'hmac-md5',
      'hmac-md5-96',
    ],
  };
}

module.exports = { pingerSshAlgorithms };
