/**
 * Starter config for a sing-box core.
 *
 * Picking "singbox" used to drop the xray template into the editor, which the
 * panel then refused to save. This gives a config that saves as-is and shows
 * the shape the rest has to follow.
 *
 * Two blocks under `experimental` are not optional here even though sing-box
 * treats them as optional, because without them the core starts, reports
 * healthy, and quietly does not work:
 *
 *   clash_api   is how the node adds and removes users. Leave it out and the
 *               core runs and never receives a single one.
 *
 *   v2ray_api   is where per-user traffic is read from, and `users: ["*"]` is
 *               what makes it count users created after startup. Listing names
 *               instead means every user added later passes traffic that is
 *               billed to nobody — no usage, no quota, no limit.
 *
 * The certificate paths and the passwords below are placeholders. The node
 * needs real ones; hysteria2 will not start without TLS.
 */
export const DEFAULT_SINGBOX_CORE_CONFIG: Record<string, unknown> = {
  log: {
    level: 'info',
    timestamp: true,
  },
  experimental: {
    clash_api: {
      external_controller: '127.0.0.1:9090',
      secret: 'change-me',
    },
    v2ray_api: {
      listen: '127.0.0.1:8080',
      stats: {
        enabled: true,
        inbounds: ['hysteria2'],
        // "*" counts every user, including ones added after startup.
        users: ['*'],
      },
    },
  },
  inbounds: [
    {
      type: 'hysteria2',
      tag: 'hysteria2',
      listen: '::',
      listen_port: 443,
      // The panel owns this list from here on — it is replaced at runtime
      // through the node, without restarting the process.
      users: [],
      // Removing a user stops them authenticating again, but it does not close
      // a session they already hold — neither here nor in xray, which drops a
      // user from its validator and leaves open connections alone. On xray that
      // is barely visible because TCP connections keep being remade; a QUIC
      // session can sit open far longer, so a user who ran out of data could
      // keep using one.
      //
      // An idle timeout closes it for them, which forces a fresh handshake that
      // now fails. Five minutes is short enough to bound the leak and long
      // enough not to churn sessions on a phone that briefly loses signal.
      udp_timeout: '5m',
      obfs: {
        type: 'salamander',
        password: 'change-me',
      },
      tls: {
        enabled: true,
        server_name: 'example.com',
        certificate_path: '/var/lib/pg-node/certs/fullchain.pem',
        key_path: '/var/lib/pg-node/certs/privkey.pem',
      },
    },
  ],
  outbounds: [
    {
      type: 'direct',
      tag: 'direct',
    },
  ],
}

export const DEFAULT_SINGBOX_CORE_CONFIG_JSON = JSON.stringify(DEFAULT_SINGBOX_CORE_CONFIG, null, 2)
