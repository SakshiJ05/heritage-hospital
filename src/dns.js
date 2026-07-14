// MongoDB Atlas uses a `mongodb+srv://` URI, which requires a DNS SRV lookup.
// Some ISP/corporate resolvers refuse SRV queries, and the driver then dies with
// a misleading `querySrv ECONNREFUSED` that looks like Atlas is down when it isn't.
//
// Setting DNS_SERVERS points Node's resolver at a DNS server that answers SRV.
// Leave it unset and Node uses the system resolver as normal — production
// environments almost never need this.

const dns = require('dns');

function configureDns() {
  const servers = (process.env.DNS_SERVERS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  if (!servers.length) return;

  dns.setServers(servers);
  // The driver resolves through the promise API, so point that at them too.
  if (dns.promises?.setServers) dns.promises.setServers(servers);

  console.log(`DNS: using ${servers.join(', ')} (DNS_SERVERS is set)`);
}

module.exports = { configureDns };
