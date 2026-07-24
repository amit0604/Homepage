/** Map ssh2 / Node errors to OpenSSH-style lines for the terminal pane. */
function terminalErrorLine(err, host, port) {
  const m = err && err.message ? String(err.message) : '';
  const h = host || 'host';
  const p = port || 22;

  if (/ECONNREFUSED/i.test(m)) {
    return `Connection refused: ${h}:${p}`;
  }
  if (/ENOTFOUND|getaddrinfo|ENOTADDR/i.test(m)) {
    return `Could not resolve hostname ${h}`;
  }
  if (/ETIMEDOUT|Timeout.*negotiation|handshake timeout/i.test(m)) {
    return `ssh: connect to host ${h} port ${p}: Connection timed out`;
  }
  if (/All configured authentication methods failed/i.test(m) || /Authentication failed/i.test(m)) {
    return 'Permission denied (publickey,password).';
  }
  if (/Host key verification failed|Host key mismatch/i.test(m)) {
    return m;
  }
  return m || 'SSH connection failed.';
}

module.exports = { terminalErrorLine };
